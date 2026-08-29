/**
 * What the renderer currently draws.
 *
 * Bump this whenever a change alters the pixels — a new layer, a moved label, a
 * different colour. It is folded into the render job's request key
 * (packages/cache/src/renderJobs.ts), which is the only thing standing between a
 * viewer and an MP4 encoded by an older version of this code: the key is otherwise
 * derived from the replay alone, so a rendered file would be served forever no matter
 * how much the drawing had moved on.
 *
 * A number rather than a hash of the sources: a hash would invalidate every cached
 * render on a comment change, and this is a decision about output, not about files.
 *
 * 1 — M8, the first server renders.
 * 2 — PnL-reactive effects (effects.ts) and the per-candle burst.
 * 3 — the closing card (outro.ts).
 */
export const RENDER_VERSION = 3;
