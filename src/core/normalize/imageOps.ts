/**
 * Sprite Sheet Normalize - low level RGBA image operations
 * @module core/normalize/imageOps
 *
 * Pure, DOM-free pixel math. Every function takes/returns plain `RgbaImage`
 * buffers so it is identically usable in the renderer, the CLI and unit tests.
 *
 * Conventions:
 *  - Buffers are RGBA, row-major, 8-bit per channel (Uint8ClampedArray).
 *  - The byte index of pixel (x, y) is  (y * width + x) * 4.
 */

import type { BBox, RgbaImage } from './types';

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

export function clamp(value: number, min: number, max: number): number {
    return value < min ? min : value > max ? max : value;
}

/**
 * Median of a numeric list. Returns 0 for an empty list.
 * Uses the average of the two middle values for even-length input, which is
 * the standard statistical median and behaves nicely for placement smoothing.
 */
export function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
}

// ---------------------------------------------------------------------------
// Construction / cropping
// ---------------------------------------------------------------------------

/** Allocate a fully transparent (all-zero) RGBA image. */
export function createTransparentImage(width: number, height: number): RgbaImage {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    // Uint8ClampedArray is zero-initialised => transparent black (0,0,0,0).
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
}

/**
 * Crop a rectangular region out of `img` into a new buffer.
 * The rect is clamped to the source bounds so callers never read out of range.
 */
export function cropRgba(img: RgbaImage, rect: { x: number; y: number; w: number; h: number }): RgbaImage {
    const x0 = clamp(Math.floor(rect.x), 0, img.width);
    const y0 = clamp(Math.floor(rect.y), 0, img.height);
    const x1 = clamp(Math.floor(rect.x + rect.w), 0, img.width);
    const y1 = clamp(Math.floor(rect.y + rect.h), 0, img.height);

    const w = Math.max(1, x1 - x0);
    const h = Math.max(1, y1 - y0);

    const out = new Uint8ClampedArray(w * h * 4);
    for (let row = 0; row < h; row++) {
        // Copy a whole scanline at once for speed.
        const srcStart = ((y0 + row) * img.width + x0) * 4;
        const dstStart = row * w * 4;
        out.set(img.data.subarray(srcStart, srcStart + w * 4), dstStart);
    }
    return { width: w, height: h, data: out };
}

// ---------------------------------------------------------------------------
// Alpha bounding box detection
// ---------------------------------------------------------------------------

/**
 * Detect the tight alpha bounding box of the character and (optionally) expand
 * it by `padding` pixels on every side, clamped to the image.
 *
 * A pixel belongs to the character when alpha > alphaThreshold. A small
 * threshold (~10) keeps soft anti-aliased edges while ignoring fully invisible
 * pixels; the extra `padding` then guarantees we never shave off thin hair /
 * line-art at the very edge of the silhouette.
 *
 * Returns `{ empty: true, w: 0, h: 0 }` when the image is fully transparent.
 */
export function detectAlphaBBox(img: RgbaImage, alphaThreshold = 10, padding = 0): BBox {
    const { width, height, data } = img;

    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < height; y++) {
        const rowOffset = y * width * 4;
        for (let x = 0; x < width; x++) {
            const alpha = data[rowOffset + x * 4 + 3];
            if (alpha > alphaThreshold) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }

    // No opaque pixel found -> empty frame.
    if (maxX < 0) {
        return { x: 0, y: 0, w: 0, h: 0, empty: true };
    }

    // Expand by padding, clamped to the image so the bbox stays valid.
    const x0 = clamp(minX - padding, 0, width - 1);
    const y0 = clamp(minY - padding, 0, height - 1);
    const x1 = clamp(maxX + padding, 0, width - 1);
    const y1 = clamp(maxY + padding, 0, height - 1);

    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, empty: false };
}

// ---------------------------------------------------------------------------
// Lanczos resampling (high quality, transparency-safe)
// ---------------------------------------------------------------------------

/**
 * The Lanczos kernel of order `a` (a.k.a. "Lanczos-a"):
 *
 *      L(x) = sinc(x) * sinc(x / a)            for |x| < a
 *      L(0) = 1
 *      L(x) = 0                                for |x| >= a
 *
 * with sinc(t) = sin(pi*t) / (pi*t). It is the windowed-sinc filter that gives
 * sharp, ringing-controlled results for both up- and down-scaling, which is why
 * the spec asks specifically for LANCZOS.
 */
function lanczosKernel(x: number, a: number): number {
    if (x === 0) return 1;
    if (x <= -a || x >= a) return 0;
    const px = Math.PI * x;
    // sinc(x) * sinc(x/a) = a * sin(pi x) * sin(pi x / a) / (pi^2 x^2)
    return (a * Math.sin(px) * Math.sin(px / a)) / (px * px);
}

/** A precomputed set of (sourceIndex, weight) contributions for one output sample. */
interface AxisContribution {
    indices: number[];
    weights: number[];
}

/**
 * Precompute, for every output position along one axis, which source pixels
 * contribute and with what (normalised) weights.
 *
 * Down-scaling note: when shrinking (scale < 1) the kernel must be *widened* by
 * 1/scale so it acts as a proper low-pass filter and averages the source pixels
 * that fall inside one destination pixel - otherwise we would alias. When
 * enlarging we keep the kernel at its natural width (radius = a).
 */
function buildContributions(srcSize: number, dstSize: number, a: number): AxisContribution[] {
    const scale = dstSize / srcSize;
    const support = scale < 1 ? a / scale : a;   // kernel radius in *source* pixels
    const invFilterScale = scale < 1 ? scale : 1; // how we compress distances back into kernel space

    const contributions: AxisContribution[] = new Array(dstSize);

    for (let i = 0; i < dstSize; i++) {
        // Centre of this destination pixel mapped into source-pixel-centre space.
        const center = (i + 0.5) / scale - 0.5;
        const start = Math.floor(center - support);
        const end = Math.ceil(center + support);

        const indices: number[] = [];
        const weights: number[] = [];
        let weightSum = 0;

        for (let j = start; j <= end; j++) {
            // Distance from sample centre, compressed into kernel units.
            const weight = lanczosKernel((j - center) * invFilterScale, a);
            if (weight === 0) continue;
            // Clamp source index to the edge (edge-extend) so borders stay clean.
            const srcIndex = clamp(j, 0, srcSize - 1);
            indices.push(srcIndex);
            weights.push(weight);
            weightSum += weight;
        }

        // Normalise so the weights sum to exactly 1 (preserves brightness).
        if (weightSum !== 0) {
            for (let k = 0; k < weights.length; k++) weights[k] /= weightSum;
        }

        contributions[i] = { indices, weights };
    }

    return contributions;
}

/**
 * Resize an RGBA image to `dstWidth` x `dstHeight` using a separable Lanczos
 * filter (horizontal pass, then vertical pass).
 *
 * Transparency handling: we resample in **premultiplied alpha** space. If we
 * blended straight (non-premultiplied) RGBA, the usually-black RGB of fully
 * transparent pixels would bleed into the visible edge and produce dark halos.
 * Premultiplying (rgb *= a) before filtering and un-premultiplying afterwards
 * keeps edges clean and colour faithful - exactly what we want for sprite art.
 */
export function lanczosResize(img: RgbaImage, dstWidth: number, dstHeight: number, a = 3): RgbaImage {
    const dstW = Math.max(1, Math.round(dstWidth));
    const dstH = Math.max(1, Math.round(dstHeight));
    const srcW = img.width;
    const srcH = img.height;

    if (srcW === dstW && srcH === dstH) {
        // Nothing to do - return a copy so callers can mutate freely.
        return { width: srcW, height: srcH, data: new Uint8ClampedArray(img.data) };
    }

    // --- Step 1: premultiply source into float channels -------------------
    const srcPremul = new Float32Array(srcW * srcH * 4);
    for (let p = 0; p < srcW * srcH; p++) {
        const o = p * 4;
        const alpha = img.data[o + 3] / 255;
        srcPremul[o] = img.data[o] * alpha;
        srcPremul[o + 1] = img.data[o + 1] * alpha;
        srcPremul[o + 2] = img.data[o + 2] * alpha;
        srcPremul[o + 3] = img.data[o + 3]; // keep alpha 0..255
    }

    // --- Step 2: horizontal pass (srcW -> dstW), height unchanged ---------
    const xContrib = buildContributions(srcW, dstW, a);
    const horiz = new Float32Array(dstW * srcH * 4);
    for (let y = 0; y < srcH; y++) {
        const srcRow = y * srcW * 4;
        const dstRow = y * dstW * 4;
        for (let x = 0; x < dstW; x++) {
            const { indices, weights } = xContrib[x];
            let r = 0, g = 0, b = 0, al = 0;
            for (let k = 0; k < indices.length; k++) {
                const so = srcRow + indices[k] * 4;
                const w = weights[k];
                r += srcPremul[so] * w;
                g += srcPremul[so + 1] * w;
                b += srcPremul[so + 2] * w;
                al += srcPremul[so + 3] * w;
            }
            const dstO = dstRow + x * 4;
            horiz[dstO] = r;
            horiz[dstO + 1] = g;
            horiz[dstO + 2] = b;
            horiz[dstO + 3] = al;
        }
    }

    // --- Step 3: vertical pass (srcH -> dstH) -----------------------------
    const yContrib = buildContributions(srcH, dstH, a);
    const out = new Uint8ClampedArray(dstW * dstH * 4);
    for (let x = 0; x < dstW; x++) {
        for (let y = 0; y < dstH; y++) {
            const { indices, weights } = yContrib[y];
            let r = 0, g = 0, b = 0, al = 0;
            for (let k = 0; k < indices.length; k++) {
                const so = (indices[k] * dstW + x) * 4;
                const w = weights[k];
                r += horiz[so] * w;
                g += horiz[so + 1] * w;
                b += horiz[so + 2] * w;
                al += horiz[so + 3] * w;
            }
            // --- Step 4: un-premultiply and write out ---------------------
            const o = (y * dstW + x) * 4;
            const alpha = clamp(al, 0, 255);
            if (alpha > 0) {
                const inv = 255 / alpha; // divide by (alpha/255)
                out[o] = clamp(r * inv, 0, 255);
                out[o + 1] = clamp(g * inv, 0, 255);
                out[o + 2] = clamp(b * inv, 0, 255);
            } else {
                out[o] = out[o + 1] = out[o + 2] = 0;
            }
            out[o + 3] = alpha;
        }
    }

    return { width: dstW, height: dstH, data: out };
}

// ---------------------------------------------------------------------------
// Compositing
// ---------------------------------------------------------------------------

/**
 * Paste `src` onto `dst` at integer top-left (x, y) using standard
 * source-over alpha compositing. Pixels outside `dst` are skipped, so callers
 * can place content partially off-canvas without crashing (although the
 * normalizer is designed never to need that).
 */
export function pasteRgba(dst: RgbaImage, src: RgbaImage, x: number, y: number): void {
    const px = Math.round(x);
    const py = Math.round(y);

    for (let sy = 0; sy < src.height; sy++) {
        const ty = py + sy;
        if (ty < 0 || ty >= dst.height) continue;
        for (let sx = 0; sx < src.width; sx++) {
            const tx = px + sx;
            if (tx < 0 || tx >= dst.width) continue;

            const si = (sy * src.width + sx) * 4;
            const sa = src.data[si + 3];
            if (sa === 0) continue; // fully transparent source pixel: nothing to do

            const di = (ty * dst.width + tx) * 4;
            const da = dst.data[di + 3];

            if (da === 0) {
                // Fast path: destination empty, just copy the source pixel.
                dst.data[di] = src.data[si];
                dst.data[di + 1] = src.data[si + 1];
                dst.data[di + 2] = src.data[si + 2];
                dst.data[di + 3] = sa;
                continue;
            }

            // General source-over: out = src + dst * (1 - srcAlpha)
            const saN = sa / 255;
            const daN = da / 255;
            const outA = saN + daN * (1 - saN);
            if (outA <= 0) {
                dst.data[di + 3] = 0;
                continue;
            }
            for (let c = 0; c < 3; c++) {
                const sc = src.data[si + c];
                const dc = dst.data[di + c];
                dst.data[di + c] = (sc * saN + dc * daN * (1 - saN)) / outA;
            }
            dst.data[di + 3] = Math.round(outA * 255);
        }
    }
}
