/** SPEC §7.1 layer 1: flat dark fill. No gradient (SPEC §7.3). */

import { fillRect } from '../helpers.js';
import type { Canvas2D } from '../types.js';
import type { LayerContext } from './context.js';

export function drawBackground(ctx: Canvas2D, c: LayerContext): void {
  fillRect(ctx, 0, 0, c.layout.width, c.layout.height, c.theme.background);
}
