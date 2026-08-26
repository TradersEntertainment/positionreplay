/**
 * gif.js ships no types.
 *
 * Note the import path: the package's `main` (index.js) exports the internal encoders
 * — NeuQuant, LZWEncoder — not the `GIF` class. The class only exists in the UMD build
 * under dist/, which is what this declares.
 */
declare module 'gif.js/dist/gif.js' {
  export interface GifOptions {
    /** Encoder workers. More is faster until the machine runs out of cores. */
    workers?: number;
    /** 1 = best, 30 = fastest. gif.js counts down, not up. */
    quality?: number;
    width?: number;
    height?: number;
    /** URL of dist/gif.worker.js, served by the host. */
    workerScript?: string;
    /** 0 = loop forever, -1 = play once. */
    repeat?: number;
    dither?: boolean | string;
    background?: string;
    transparent?: number | null;
  }

  export interface AddFrameOptions {
    /** Milliseconds this frame is held. */
    delay?: number;
    /** Required when passing a reused canvas context, or every frame ends up identical. */
    copy?: boolean;
    dispose?: number;
  }

  export default class GIF {
    constructor(options?: GifOptions);
    addFrame(
      image: CanvasImageSource | ImageData | CanvasRenderingContext2D,
      options?: AddFrameOptions,
    ): void;
    render(): void;
    abort(): void;
    on(event: 'finished', callback: (blob: Blob) => void): void;
    on(event: 'progress', callback: (progress: number) => void): void;
    on(event: 'abort', callback: () => void): void;
    on(event: 'start', callback: () => void): void;
  }
}
