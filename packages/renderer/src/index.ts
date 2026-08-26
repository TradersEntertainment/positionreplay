/**
 * @trade-replay/renderer — pure Canvas 2D drawing.
 *
 * Runs unchanged in a browser and under @napi-rs/canvas in Node. It must never import
 * from @trade-replay/adapters or touch the DOM (CLAUDE.md).
 */

export * from './types.js';
export * from './theme.js';
export * from './scale.js';
export * from './render.js';
export { FADE_FRAMES } from './layers/markers.js';
