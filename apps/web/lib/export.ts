/**
 * Client-side export. SPEC.md §9 Phase 1.
 *
 * Browser-only on purpose. `packages/renderer` must stay pure — no DOM, no async — and
 * that purity is what makes M8's server render possible at all. MediaRecorder will never
 * run there; `renderFrame` and `createSequenceRenderer`, which do the actual drawing,
 * already are shared.
 *
 * CLAUDE.md: "These outputs get exported as images and posted as fact." Everything here
 * carries the replay's notices into the pixels, and refuses rather than producing a file
 * that misrepresents what it contains.
 */

import type { Frame, PositionEpisode, PriceSeries } from '@trade-replay/core';
import { createPlaybackClock } from '@trade-replay/core';
import { createSequenceRenderer, darkTheme, type Canvas2D } from '@trade-replay/renderer';

/** SPEC §9: "1080x1080 (square, best for X timeline) and 1920x1080 presets." */
export interface ExportPreset {
  id: 'square' | 'wide';
  label: string;
  width: number;
  height: number;
}

export const EXPORT_PRESETS: readonly ExportPreset[] = [
  { id: 'square', label: '1080×1080 square', width: 1080, height: 1080 },
  { id: 'wide', label: '1920×1080 wide', width: 1920, height: 1080 },
];

/**
 * Candidates in preference order.
 *
 * SPEC names vp9, but hardcoding it produces a broken or empty file wherever it is
 * missing — Safari has no WebM encoder at all. Note that Chromium reports bare
 * `video/mp4` as supported while rejecting `video/mp4;codecs=avc1`, so the bare type is
 * last: it is the least trustworthy claim in the list.
 */
export const VIDEO_MIME_CANDIDATES: readonly string[] = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4;codecs=avc1',
  'video/mp4',
];

export type SupportProbe = (mimeType: string) => boolean;

/** The best supported container, or null when the browser can record none of them. */
export function pickVideoMimeType(isSupported?: SupportProbe): string | null {
  const probe: SupportProbe =
    isSupported ??
    ((mimeType) =>
      typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mimeType));

  return VIDEO_MIME_CANDIDATES.find((candidate) => probe(candidate)) ?? null;
}

/** File extension matching a recorder mime type. Never guess from the codec name. */
export function extensionForMimeType(mimeType: string): string {
  return mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
}

/** Everything the export needs about the replay. Mirrors what the player passes. */
export interface ExportScene {
  episode: PositionEpisode;
  series: PriceSeries;
  frames: Frame[];
  address: string;
  interval: string;
  /** Painted into every frame; these must not be lost on the way out. */
  notices: string[];
  /** Carried into the export too — an unknown funding figure must not export as zero. */
  fundingUnavailable?: boolean;
}

export class ExportUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportUnsupportedError';
  }
}

function layoutFor(scene: ExportScene, width: number, height: number) {
  return {
    width,
    height,
    dpr: 1,
    address: scene.address,
    watermark: 'trade-replay',
    interval: scene.interval,
    ...(scene.notices.length > 0 ? { notices: scene.notices } : {}),
    ...(scene.fundingUnavailable ? { fundingUnavailable: true } : {}),
  };
}

export interface FramePainter {
  canvas: HTMLCanvasElement;
  paint(index: number): void;
  reset(): void;
}

/**
 * An offscreen canvas at a fixed size, plus the shared sequence renderer.
 *
 * Offscreen rather than the visible player: that canvas is sized by the viewport, so
 * recording it would make the output depend on the browser window. `renderFrame` is
 * resolution-independent, so a preset-sized canvas costs nothing and is deterministic.
 */
export function createFramePainter(
  scene: ExportScene,
  width: number,
  height: number,
): FramePainter {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ExportUnsupportedError('This browser refused a 2D canvas context.');

  const renderer = createSequenceRenderer(scene.episode, scene.series, scene.frames, darkTheme);
  const layout = layoutFor(scene, width, height);

  return {
    canvas,
    paint: (index) => renderer.render(ctx as unknown as Canvas2D, index, layout),
    reset: () => renderer.reset(),
  };
}

export interface RecordOptions {
  /** SPEC §6.3's playback rate. The video runs at real speed, so this sets its length. */
  fps?: number;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface RecordResult {
  blob: Blob;
  mimeType: string;
  extension: string;
  frames: number;
  durationMs: number;
}

/** Milliseconds held after the final paint so the recorder captures it. */
const TAIL_MS = 250;

/**
 * Record the replay to video. SPEC §9 Phase 1.
 *
 * Real time, deliberately: MediaRecorder timestamps frames by arrival, so painting
 * faster than playback would produce a sped-up video. SPEC's "run the replay at a fixed
 * timestep driven by rAF while recording" is the requirement, and the fixed timestep is
 * the same `createPlaybackClock` the player uses.
 */
export async function recordVideo(
  scene: ExportScene,
  preset: ExportPreset,
  options: RecordOptions = {},
): Promise<RecordResult> {
  if (scene.frames.length === 0) {
    throw new ExportUnsupportedError('This replay has no frames to record.');
  }

  const mimeType = pickVideoMimeType();
  if (!mimeType) {
    throw new ExportUnsupportedError(
      'This browser cannot record video. Safari has no WebM encoder; try Chrome or Firefox.',
    );
  }

  const painter = createFramePainter(scene, preset.width, preset.height);
  if (typeof painter.canvas.captureStream !== 'function') {
    throw new ExportUnsupportedError('This browser does not support canvas.captureStream().');
  }

  // SPEC §9: captureStream(60).
  const stream = painter.canvas.captureStream(60);
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks: Blob[] = [];
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  });

  const stopped = new Promise<void>((resolve) => {
    recorder.addEventListener('stop', () => resolve(), { once: true });
  });

  const clock = createPlaybackClock({ frameCount: scene.frames.length });
  const startedAt = performance.now();

  painter.paint(0);
  recorder.start();
  clock.play();

  await new Promise<void>((resolve, reject) => {
    let last = performance.now();
    let raf = 0;

    const finish = (): void => {
      cancelAnimationFrame(raf);
      resolve();
    };

    const tick = (now: number): void => {
      if (options.signal?.aborted) {
        cancelAnimationFrame(raf);
        reject(new DOMException('Export cancelled', 'AbortError'));
        return;
      }

      const delta = now - last;
      last = now;
      const index = clock.advance(delta);
      painter.paint(index);
      options.onProgress?.((index + 1) / scene.frames.length);

      // The clock pauses itself on the final frame (SPEC §6.3).
      if (!clock.state.playing) {
        // Hold briefly so the recorder samples the last frame before the stream ends.
        setTimeout(finish, TAIL_MS);
        return;
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
  }).finally(() => {
    if (recorder.state !== 'inactive') recorder.stop();
    for (const track of stream.getTracks()) track.stop();
  });

  await stopped;

  const blob = new Blob(chunks, { type: mimeType });
  if (blob.size === 0) {
    throw new ExportUnsupportedError(
      'The recorder produced an empty file. This browser reports the codec as supported but did not encode anything.',
    );
  }

  return {
    blob,
    mimeType,
    extension: extensionForMimeType(mimeType),
    frames: scene.frames.length,
    durationMs: performance.now() - startedAt,
  };
}

/** SPEC §9: "downsample to 15fps / 640px wide or the file is unusable." */
export const GIF_FPS = 15;
export const GIF_WIDTH = 640;
/**
 * Above this, a GIF is tens of megabytes and nothing will accept it. Capping frames
 * rather than truncating the replay keeps the whole episode visible, just choppier.
 */
export const GIF_MAX_FRAMES = 150;

export interface GifPlan {
  /** Source frame indices to encode, evenly spaced in time. */
  indices: number[];
  /** Milliseconds per frame, so the GIF lasts as long as the replay does. */
  delayMs: number;
}

/**
 * Choose which frames to encode and how long to hold each.
 *
 * The delay is derived from the frames actually sampled, not from the target rate. When
 * the cap bites, holding each frame for 1/15s would make the GIF play back faster than
 * the replay — a shorter, wrong-speed version of the trade.
 */
export function planGif(
  frameCount: number,
  sourceFps: number = 24,
  targetFps: number = GIF_FPS,
  maxFrames: number = GIF_MAX_FRAMES,
): GifPlan {
  if (frameCount <= 0) return { indices: [], delayMs: Math.round(1000 / targetFps) };
  if (frameCount === 1) return { indices: [0], delayMs: Math.round(1000 / targetFps) };

  const durationMs = (frameCount / sourceFps) * 1000;
  const wanted = Math.max(2, Math.round((durationMs / 1000) * targetFps));
  const count = Math.min(maxFrames, wanted, frameCount);

  const indices = Array.from({ length: count }, (_, i) =>
    Math.round((i * (frameCount - 1)) / (count - 1)),
  );

  return { indices, delayMs: Math.max(20, Math.round(durationMs / count)) };
}

export interface GifOptions {
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  /** Where the host serves gif.js's worker. */
  workerScript?: string;
}

export interface GifResult {
  blob: Blob;
  frames: number;
  width: number;
  height: number;
  delayMs: number;
}

/**
 * Encode the replay to GIF. SPEC §9 Phase 1.
 *
 * Unlike video this does not run in real time — gif.js encodes offline in workers — so
 * the frames are resampled by time instead of being played through.
 */
export async function encodeGif(
  scene: ExportScene,
  preset: ExportPreset,
  options: GifOptions = {},
): Promise<GifResult> {
  if (scene.frames.length === 0) {
    throw new ExportUnsupportedError('This replay has no frames to encode.');
  }

  // The package's `main` exports the internal encoders, not the GIF class; only the
  // UMD build under dist/ has it. Imported lazily so it never loads during SSR.
  const { default: GIF } = await import('gif.js/dist/gif.js');

  const plan = planGif(scene.frames.length);
  const width = GIF_WIDTH;
  const height = Math.round((GIF_WIDTH * preset.height) / preset.width);

  const painter = createFramePainter(scene, width, height);
  const ctx = painter.canvas.getContext('2d');
  if (!ctx) throw new ExportUnsupportedError('This browser refused a 2D canvas context.');

  const gif = new GIF({
    workers: 4,
    quality: 10,
    width,
    height,
    workerScript: options.workerScript ?? '/gif.worker.js',
    repeat: 0,
  });

  for (const [position, index] of plan.indices.entries()) {
    if (options.signal?.aborted) {
      gif.abort();
      throw new DOMException('Export cancelled', 'AbortError');
    }
    painter.paint(index);
    // `copy` is required: without it every frame aliases the same canvas and the GIF
    // comes out as the last frame repeated.
    gif.addFrame(ctx, { delay: plan.delayMs, copy: true });
    // Painting is half the work; encoding reports the other half.
    options.onProgress?.((position / plan.indices.length) * 0.5);
  }

  const blob = await new Promise<Blob>((resolve, reject) => {
    gif.on('progress', (progress) => options.onProgress?.(0.5 + progress * 0.5));
    gif.on('finished', (result) => resolve(result));
    gif.on('abort', () => reject(new DOMException('Export cancelled', 'AbortError')));
    gif.render();
  });

  return { blob, frames: plan.indices.length, width, height, delayMs: plan.delayMs };
}

/** Hand a blob to the browser as a download. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A filename that says what the file is without needing the page it came from. */
export function exportFilename(scene: ExportScene, extension: string): string {
  const symbol = scene.episode.displayName.replace(/\s+/g, '-').toLowerCase();
  const opened = new Date(scene.episode.openedAt).toISOString().slice(0, 10);
  return `trade-replay-${symbol}-${scene.episode.direction}-${opened}.${extension}`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
