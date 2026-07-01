/**
 * Renderer adapters bridging the DOM-free normalize core to the browser canvas.
 * @module renderer/normalizeAdapters
 *
 * The core (`src/core/normalize`) never touches the DOM so it can run in Node /
 * tests. These tiny helpers are the only place that converts between the
 * renderer's `HTMLImageElement` / `HTMLCanvasElement` / `ImageData` world and
 * the core's plain `RgbaImage` buffers.
 */

import type { RgbaImage } from '../core/normalize/types';

/** Rasterize a loaded image element into a flat RGBA buffer. */
export function imageElementToRgba(img: HTMLImageElement): RgbaImage {
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Could not acquire 2D context.');
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0);
    const id = ctx.getImageData(0, 0, width, height);
    return { width: id.width, height: id.height, data: id.data };
}

/** Paint an `RgbaImage` into a freshly created canvas. */
export function rgbaToCanvas(img: RgbaImage): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not acquire 2D context.');
    // Copy the buffer so the ImageData owns its own memory.
    const id = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
    ctx.putImageData(id, 0, 0);
    return canvas;
}

/** Encode an `RgbaImage` to a PNG data URL (base64). */
export function rgbaToDataUrl(img: RgbaImage): string {
    return rgbaToCanvas(img).toDataURL('image/png');
}

/** Strip the `data:...;base64,` prefix so it can be written via IPC WRITE_FILE. */
export function dataUrlToBase64(dataUrl: string): string {
    return dataUrl.replace(/^data:image\/png;base64,/, '');
}

/** Load an image from an absolute filesystem path (webSecurity is disabled). */
export function loadImageFromPath(filePath: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error(`Failed to load image: ${filePath}`));
        image.src = `file:///${filePath.replace(/\\/g, '/')}`;
    });
}
