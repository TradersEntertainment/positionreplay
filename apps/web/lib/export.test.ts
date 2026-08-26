import { describe, expect, it } from 'vitest';
import {
  EXPORT_PRESETS,
  GIF_FPS,
  GIF_MAX_FRAMES,
  VIDEO_MIME_CANDIDATES,
  exportFilename,
  extensionForMimeType,
  formatBytes,
  pickVideoMimeType,
  planGif,
  type ExportScene,
} from './export';

describe('pickVideoMimeType', () => {
  it('prefers vp9 when the browser has it', () => {
    expect(pickVideoMimeType(() => true)).toBe('video/webm;codecs=vp9');
  });

  it('falls back down the chain', () => {
    // Hardcoding vp9 would hand these browsers a broken or empty file.
    expect(pickVideoMimeType((t) => t !== 'video/webm;codecs=vp9')).toBe('video/webm;codecs=vp8');
    expect(pickVideoMimeType((t) => t === 'video/webm')).toBe('video/webm');
    expect(pickVideoMimeType((t) => t.startsWith('video/mp4'))).toBe('video/mp4;codecs=avc1');
  });

  it('returns null when nothing is supported, rather than a guess', () => {
    // Safari records no WebM at all; the UI has to say so instead of downloading junk.
    expect(pickVideoMimeType(() => false)).toBeNull();
  });

  it('ranks bare video/mp4 last', () => {
    // Chromium claims support for it while rejecting video/mp4;codecs=avc1, so it is
    // the least trustworthy claim in the list.
    expect(VIDEO_MIME_CANDIDATES.at(-1)).toBe('video/mp4');
  });
});

describe('extensionForMimeType', () => {
  it('matches the container, never the codec name', () => {
    expect(extensionForMimeType('video/webm;codecs=vp9')).toBe('webm');
    expect(extensionForMimeType('video/webm')).toBe('webm');
    expect(extensionForMimeType('video/mp4;codecs=avc1')).toBe('mp4');
  });
});

describe('EXPORT_PRESETS (SPEC §9)', () => {
  it('offers the square and wide presets SPEC names', () => {
    expect(EXPORT_PRESETS.map((p) => `${p.width}x${p.height}`)).toEqual([
      '1080x1080',
      '1920x1080',
    ]);
  });
});

describe('planGif (SPEC §9: 15fps)', () => {
  it('samples close to the target rate for a normal replay', () => {
    // 240 frames at 24fps is 10 seconds, so about 150 frames at 15fps.
    const plan = planGif(240, 24, GIF_FPS, 1_000);
    expect(plan.indices).toHaveLength(150);
    expect(plan.delayMs).toBeCloseTo(1000 / GIF_FPS, 0);
  });

  it('always spans the whole replay, first frame to last', () => {
    const plan = planGif(240);
    expect(plan.indices[0]).toBe(0);
    expect(plan.indices.at(-1)).toBe(239);
  });

  it('samples evenly in time', () => {
    const plan = planGif(100, 24, 15, 1_000);
    const gaps = plan.indices.slice(1).map((v, i) => v - plan.indices[i]!);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
  });

  it('stretches the delay when the frame cap bites, so the GIF is not sped up', () => {
    // A long replay capped at GIF_MAX_FRAMES must still last as long as the trade did.
    const frames = 2_000;
    const plan = planGif(frames, 24, GIF_FPS, GIF_MAX_FRAMES);
    const replayMs = (frames / 24) * 1000;

    expect(plan.indices).toHaveLength(GIF_MAX_FRAMES);
    expect(plan.indices.length * plan.delayMs).toBeCloseTo(replayMs, -3);
    // Holding 1/15s per frame here would compress 83 seconds into 10.
    expect(plan.delayMs).toBeGreaterThan(1000 / GIF_FPS);
  });

  it('never emits a delay too short for a GIF decoder to honour', () => {
    expect(planGif(5, 24, 15, 150).delayMs).toBeGreaterThanOrEqual(20);
  });

  it('survives degenerate frame counts', () => {
    expect(planGif(0).indices).toEqual([]);
    expect(planGif(1).indices).toEqual([0]);
    expect(planGif(2).indices).toEqual([0, 1]);
  });

  it('never asks for more frames than exist', () => {
    for (const count of [3, 7, 20, 61]) {
      const plan = planGif(count);
      expect(plan.indices.length, `count ${count}`).toBeLessThanOrEqual(count);
      expect(Math.max(...plan.indices), `count ${count}`).toBeLessThan(count);
      expect(new Set(plan.indices).size, `count ${count}`).toBe(plan.indices.length);
    }
  });
});

describe('exportFilename', () => {
  const scene = {
    episode: {
      displayName: 'HYPE PERP',
      direction: 'long',
      openedAt: Date.UTC(2025, 10, 1, 12, 30),
    },
  } as ExportScene;

  it('says what the file is without needing the page it came from', () => {
    expect(exportFilename(scene, 'webm')).toBe('trade-replay-hype-perp-long-2025-11-01.webm');
  });
});

describe('formatBytes', () => {
  it('reads at a glance', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
