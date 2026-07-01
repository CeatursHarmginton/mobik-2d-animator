import {
    clamp,
    createTransparentImage,
    cropRgba,
    detectAlphaBBox,
    lanczosResize,
    median,
    pasteRgba
} from '../../../src/core/normalize/imageOps';
import { RgbaImage } from '../../../src/core/normalize/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build a fully transparent RGBA image. */
function blank(width: number, height: number): RgbaImage {
    return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/** Fill a rectangle with a solid RGBA colour (mutates img). */
function fillRect(
    img: RgbaImage,
    x: number,
    y: number,
    w: number,
    h: number,
    [r, g, b, a]: [number, number, number, number]
): void {
    for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
            const o = (yy * img.width + xx) * 4;
            img.data[o] = r;
            img.data[o + 1] = g;
            img.data[o + 2] = b;
            img.data[o + 3] = a;
        }
    }
}

const OPAQUE_RED: [number, number, number, number] = [220, 30, 30, 255];

// ---------------------------------------------------------------------------

describe('clamp / median', () => {
    it('clamps to range', () => {
        expect(clamp(5, 0, 10)).toBe(5);
        expect(clamp(-1, 0, 10)).toBe(0);
        expect(clamp(99, 0, 10)).toBe(10);
    });

    it('computes median for odd and even length', () => {
        expect(median([3, 1, 2])).toBe(2);
        expect(median([4, 1, 3, 2])).toBe(2.5);
        expect(median([])).toBe(0);
    });
});

describe('detectAlphaBBox', () => {
    it('marks a fully transparent image as empty', () => {
        const bbox = detectAlphaBBox(blank(8, 8), 10, 0);
        expect(bbox.empty).toBe(true);
        expect(bbox.w).toBe(0);
        expect(bbox.h).toBe(0);
    });

    it('finds the tight bounding box of an opaque region', () => {
        const img = blank(20, 20);
        fillRect(img, 5, 6, 8, 7, OPAQUE_RED); // x:5..12, y:6..12
        const bbox = detectAlphaBBox(img, 10, 0);
        expect(bbox.empty).toBe(false);
        expect(bbox).toMatchObject({ x: 5, y: 6, w: 8, h: 7 });
    });

    it('expands by padding and clamps to image edges', () => {
        const img = blank(20, 20);
        fillRect(img, 0, 0, 4, 4, OPAQUE_RED); // touches top-left corner
        const bbox = detectAlphaBBox(img, 10, 3);
        // Left/top cannot go below 0; right/bottom expand by 3.
        expect(bbox).toMatchObject({ x: 0, y: 0, w: 7, h: 7 });
    });

    it('respects the alpha threshold', () => {
        const img = blank(10, 10);
        fillRect(img, 2, 2, 4, 4, [10, 10, 10, 8]); // alpha 8, below threshold 10
        const bbox = detectAlphaBBox(img, 10, 0);
        expect(bbox.empty).toBe(true);
    });
});

describe('cropRgba', () => {
    it('extracts the requested region with correct pixels', () => {
        const img = blank(10, 10);
        fillRect(img, 3, 3, 2, 2, OPAQUE_RED);
        const crop = cropRgba(img, { x: 3, y: 3, w: 2, h: 2 });
        expect(crop.width).toBe(2);
        expect(crop.height).toBe(2);
        // every pixel should be the opaque red we wrote
        for (let i = 0; i < 4; i++) {
            expect(Array.from(crop.data.subarray(i * 4, i * 4 + 4))).toEqual(OPAQUE_RED);
        }
    });

    it('clamps a region that runs off the edge', () => {
        const img = blank(6, 6);
        const crop = cropRgba(img, { x: 4, y: 4, w: 10, h: 10 });
        expect(crop.width).toBe(2);
        expect(crop.height).toBe(2);
    });
});

describe('createTransparentImage', () => {
    it('allocates an all-zero buffer of the right size', () => {
        const img = createTransparentImage(3, 4);
        expect(img.width).toBe(3);
        expect(img.height).toBe(4);
        expect(img.data.length).toBe(3 * 4 * 4);
        expect(img.data.every(v => v === 0)).toBe(true);
    });
});

describe('lanczosResize', () => {
    it('returns the requested dimensions', () => {
        const img = blank(16, 16);
        fillRect(img, 0, 0, 16, 16, OPAQUE_RED);
        const out = lanczosResize(img, 8, 24);
        expect(out.width).toBe(8);
        expect(out.height).toBe(24);
    });

    it('preserves a solid colour and full opacity when downscaling', () => {
        const img = blank(32, 32);
        fillRect(img, 0, 0, 32, 32, OPAQUE_RED);
        const out = lanczosResize(img, 8, 8);
        // sample the centre pixel
        const c = ((4 * out.width) + 4) * 4;
        expect(out.data[c + 3]).toBe(255); // alpha preserved
        expect(out.data[c]).toBeGreaterThan(200); // red channel ~ original
        expect(out.data[c + 1]).toBeLessThan(60);
        expect(out.data[c + 2]).toBeLessThan(60);
    });

    it('keeps fully transparent regions transparent (no colour bleed)', () => {
        const img = blank(16, 16); // entirely transparent
        const out = lanczosResize(img, 8, 8);
        expect(out.data.every(v => v === 0)).toBe(true);
    });

    it('returns an identical-size copy unchanged', () => {
        const img = blank(4, 4);
        fillRect(img, 1, 1, 2, 2, OPAQUE_RED);
        const out = lanczosResize(img, 4, 4);
        expect(Array.from(out.data)).toEqual(Array.from(img.data));
    });
});

describe('pasteRgba', () => {
    it('copies an opaque source onto a transparent destination at an offset', () => {
        const dst = blank(10, 10);
        const src = blank(2, 2);
        fillRect(src, 0, 0, 2, 2, OPAQUE_RED);
        pasteRgba(dst, src, 3, 4);
        const o = (4 * 10 + 3) * 4;
        expect(Array.from(dst.data.subarray(o, o + 4))).toEqual(OPAQUE_RED);
        // a pixel outside the pasted area stays transparent
        expect(dst.data[3]).toBe(0);
    });

    it('ignores out-of-bounds placement without crashing', () => {
        const dst = blank(4, 4);
        const src = blank(4, 4);
        fillRect(src, 0, 0, 4, 4, OPAQUE_RED);
        expect(() => pasteRgba(dst, src, -2, -2)).not.toThrow();
        // top-left of dst should have received src's overlapping pixels
        expect(dst.data[3]).toBe(255);
    });
});
