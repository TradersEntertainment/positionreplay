/**
 * Boot checks. SPEC §15:
 *
 *   "Verify both exist at container start and fail loudly if not — a render worker
 *    that silently can't render is worse than one that won't boot."
 *
 * Both means ffmpeg and @napi-rs/canvas. The canvas check actually draws, because a
 * module that imports and a module that can rasterise are different claims — and the
 * second one is the one that matters.
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

const require = createRequire(import.meta.url);

export class PreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreflightError';
  }
}

export interface PreflightResult {
  ffmpegVersion: string;
  /** False when JetBrains Mono could not be registered; text falls back to a system mono. */
  fontsRegistered: boolean;
}

function checkFfmpeg(binary: string): string {
  let output: string;
  try {
    output = execFileSync(binary, ['-version'], { encoding: 'utf8', timeout: 10_000 });
  } catch (error) {
    throw new PreflightError(
      `Could not run "${binary}". SPEC §15: install it in the worker image ` +
        `(apt-get install -y ffmpeg, or apps/worker/nixpacks.toml with aptPkgs = ["ffmpeg"]).\n` +
        `  ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // libx264 specifically: SPEC §9 requires H.264 + yuv420p because X will not accept
  // anything else, and an ffmpeg built without it fails only once a job is running.
  const encoders = execFileSync(binary, ['-hide_banner', '-encoders'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (!encoders.includes('libx264')) {
    throw new PreflightError(
      `"${binary}" has no libx264 encoder. SPEC §9 Phase 2 requires H.264 with yuv420p ` +
        `for X/Twitter; this build cannot produce it.`,
    );
  }

  return output.split('\n')[0] ?? 'unknown';
}

/** JetBrains Mono, so server output matches the browser's text metrics. */
function registerFonts(): boolean {
  for (const file of [
    'jetbrains-mono-latin-400-normal.woff2',
    'jetbrains-mono-latin-700-normal.woff2',
  ]) {
    try {
      GlobalFonts.registerFromPath(
        require.resolve(`@fontsource/jetbrains-mono/files/${file}`),
        'JetBrains Mono',
      );
    } catch {
      return false;
    }
  }
  return GlobalFonts.families.some((f) => f.family === 'JetBrains Mono');
}

export function preflight(ffmpegBinary = process.env['FFMPEG_PATH'] ?? 'ffmpeg'): PreflightResult {
  const ffmpegVersion = checkFfmpeg(ffmpegBinary);

  // Draw something and read a pixel back. An @napi-rs/canvas that loads but cannot
  // rasterise would otherwise surface as a black MP4.
  try {
    const canvas = createCanvas(8, 8);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#00e0a0';
    ctx.fillRect(0, 0, 8, 8);
    const [r, g, b] = ctx.getImageData(4, 4, 1, 1).data;
    if (r !== 0x00 || g !== 0xe0 || b !== 0xa0) {
      throw new Error(`drew #00e0a0 but read back rgb(${r}, ${g}, ${b})`);
    }
  } catch (error) {
    throw new PreflightError(
      `@napi-rs/canvas cannot rasterise: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { ffmpegVersion, fontsRegistered: registerFonts() };
}
