/**
 * Jest global setup.
 *
 * Jest's `node` test environment does not provide the browser `ImageData`
 * global, but several pure-logic core modules (notably the palette matcher)
 * construct `new ImageData(...)`. This polyfill implements the two standard
 * constructor signatures so those modules run unmodified under test:
 *
 *   new ImageData(width, height)
 *   new ImageData(data, width, height?)
 */

class NodeImageData {
    readonly data: Uint8ClampedArray;
    readonly width: number;
    readonly height: number;
    readonly colorSpace: string = 'srgb';

    constructor(width: number, height: number);
    constructor(data: Uint8ClampedArray, width: number, height?: number);
    constructor(arg1: number | Uint8ClampedArray, arg2: number, arg3?: number) {
        if (typeof arg1 === 'number') {
            const width = arg1;
            const height = arg2;
            if (width <= 0 || height <= 0) {
                throw new RangeError('ImageData dimensions must be positive');
            }
            this.width = width;
            this.height = height;
            this.data = new Uint8ClampedArray(width * height * 4);
        } else {
            this.data = arg1;
            this.width = arg2;
            this.height = arg3 ?? arg1.length / 4 / arg2;
        }
    }
}

type GlobalWithImageData = typeof globalThis & { ImageData?: unknown };

const globalRef = globalThis as GlobalWithImageData;
if (typeof globalRef.ImageData === 'undefined') {
    globalRef.ImageData = NodeImageData as unknown as typeof ImageData;
}
