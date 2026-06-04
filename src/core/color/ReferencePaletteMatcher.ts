/**
 * Reference Palette Matcher - anime-safe LAB palette harmonization.
 * Extracts a reference palette with KMeans, then softly moves frame chroma
 * toward nearest palette colors while keeping local lightness/shading intact.
 * @module core/color/ReferencePaletteMatcher
 */

export type PaletteSize = 16 | 32 | 48;

export interface ReferencePaletteOptions {
    paletteSize?: PaletteSize;
    alphaThreshold?: number;
    maxSamplePixels?: number;
}

export interface PaletteMatchOptions extends ReferencePaletteOptions {
    strength?: number;
    preserveShading?: number;
}

export interface ApplyPaletteMatchToFramesOptions extends PaletteMatchOptions {
    targetIndices?: number[];
}

export interface LabColor {
    l: number;
    a: number;
    b: number;
}

export interface ReferencePalette {
    colors: LabColor[];
    sourcePixelCount: number;
    requestedSize: number;
}

const DEFAULT_PALETTE_SIZE: PaletteSize = 32;
const DEFAULT_ALPHA_THRESHOLD = 10;
const DEFAULT_MAX_SAMPLE_PIXELS = 30000;
const DEFAULT_STRENGTH = 0.65;
const DEFAULT_PRESERVE_SHADING = 0.75;

export function extractReferencePalette(referenceFrame: ImageData, options: ReferencePaletteOptions = {}): ReferencePalette {
    const alphaThreshold = options.alphaThreshold ?? DEFAULT_ALPHA_THRESHOLD;
    const requestedSize = options.paletteSize ?? DEFAULT_PALETTE_SIZE;
    const maxSamplePixels = options.maxSamplePixels ?? DEFAULT_MAX_SAMPLE_PIXELS;
    const pixels = sampleValidLabPixels(referenceFrame, alphaThreshold, maxSamplePixels);

    if (pixels.length === 0) {
        return { colors: [], sourcePixelCount: 0, requestedSize };
    }

    const unique = uniqueLabPixels(pixels);
    const clusterCount = Math.max(1, Math.min(requestedSize, unique.length));
    const colors = runKMeans(unique.length <= clusterCount ? unique : pixels, clusterCount);

    return { colors, sourcePixelCount: pixels.length, requestedSize };
}

export function applyPaletteMatch(
    frame: ImageData,
    palette: ReferencePalette | LabColor[],
    options: PaletteMatchOptions = {}
): ImageData {
    const colors = Array.isArray(palette) ? palette : palette.colors;
    if (colors.length === 0 || frame.data.length === 0) {
        return new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height);
    }

    const alphaThreshold = options.alphaThreshold ?? DEFAULT_ALPHA_THRESHOLD;
    const strength = clamp01(options.strength ?? DEFAULT_STRENGTH);
    const preserveShading = clamp01(options.preserveShading ?? DEFAULT_PRESERVE_SHADING);
    const output = new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height);
    const data = output.data;

    for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3];
        if (alpha <= alphaThreshold) continue;

        const oldLab = rgbToLab(data[i], data[i + 1], data[i + 2]);
        const nearest = findNearestPaletteLab(oldLab, colors);
        if (!nearest) continue;

        const matched: LabColor = {
            l: oldLab.l * preserveShading + nearest.l * (1 - preserveShading),
            a: oldLab.a * (1 - strength) + nearest.a * strength,
            b: oldLab.b * (1 - strength) + nearest.b * strength
        };
        const rgb = labToRgb(matched.l, matched.a, matched.b);
        data[i] = rgb.r;
        data[i + 1] = rgb.g;
        data[i + 2] = rgb.b;
        data[i + 3] = alpha;
    }

    return output;
}

export function applyPaletteMatchToFrames(
    frames: ImageData[],
    referenceIndex: number,
    options: ApplyPaletteMatchToFramesOptions = {}
): ImageData[] {
    if (frames.length === 0) return [];
    const safeReferenceIndex = Math.max(0, Math.min(frames.length - 1, referenceIndex));
    const palette = extractReferencePalette(frames[safeReferenceIndex], options);
    const targets = new Set(options.targetIndices ?? frames.map((_, index) => index));

    return frames.map((frame, index) => {
        if (!targets.has(index)) {
            return new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height);
        }
        return applyPaletteMatch(frame, palette, options);
    });
}

function sampleValidLabPixels(imageData: ImageData, alphaThreshold: number, maxSamples: number): LabColor[] {
    const data = imageData.data;
    const validCount = countValidPixels(data, alphaThreshold);
    if (validCount === 0) return [];

    const stride = Math.max(1, Math.ceil(validCount / Math.max(1, maxSamples)));
    const pixels: LabColor[] = [];
    let seen = 0;

    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] <= alphaThreshold) continue;
        if (seen % stride === 0) pixels.push(rgbToLab(data[i], data[i + 1], data[i + 2]));
        seen++;
    }

    return pixels;
}

function countValidPixels(data: Uint8ClampedArray, alphaThreshold: number): number {
    let count = 0;
    for (let i = 3; i < data.length; i += 4) {
        if (data[i] > alphaThreshold) count++;
    }
    return count;
}

function uniqueLabPixels(pixels: LabColor[]): LabColor[] {
    const seen = new Set<string>();
    const unique: LabColor[] = [];
    for (const pixel of pixels) {
        const key = `${Math.round(pixel.l * 2)},${Math.round(pixel.a * 2)},${Math.round(pixel.b * 2)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(pixel);
    }
    return unique;
}

function runKMeans(pixels: LabColor[], k: number): LabColor[] {
    if (pixels.length === 0) return [];
    if (pixels.length <= k) return pixels.slice();

    let centers = initializeCenters(pixels, k);
    const assignments = new Int32Array(pixels.length);
    assignments.fill(-1);

    for (let iteration = 0; iteration < 12; iteration++) {
        let changed = false;
        const sums = Array.from({ length: k }, () => ({ l: 0, a: 0, b: 0, count: 0 }));

        for (let i = 0; i < pixels.length; i++) {
            const nearest = findNearestIndex(pixels[i], centers);
            if (assignments[i] !== nearest) {
                assignments[i] = nearest;
                changed = true;
            }
            const sum = sums[nearest];
            sum.l += pixels[i].l;
            sum.a += pixels[i].a;
            sum.b += pixels[i].b;
            sum.count++;
        }

        centers = centers.map((center, index) => {
            const sum = sums[index];
            return sum.count === 0 ? center : { l: sum.l / sum.count, a: sum.a / sum.count, b: sum.b / sum.count };
        });

        if (!changed) break;
    }

    return centers.filter(color => Number.isFinite(color.l) && Number.isFinite(color.a) && Number.isFinite(color.b));
}

function initializeCenters(pixels: LabColor[], k: number): LabColor[] {
    const sorted = pixels.slice().sort((left, right) => left.l - right.l);
    const centers: LabColor[] = [];
    for (let i = 0; i < k; i++) {
        const index = Math.min(sorted.length - 1, Math.floor((i + 0.5) * sorted.length / k));
        centers.push({ ...sorted[index] });
    }
    return centers;
}

function findNearestPaletteLab(color: LabColor, palette: LabColor[]): LabColor | null {
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let i = 0; i < palette.length; i++) {
        const candidate = palette[i];
        const dl = (color.l - candidate.l) * 0.25;
        const da = color.a - candidate.a;
        const db = color.b - candidate.b;
        const distance = dl * dl + da * da + db * db;
        if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = i;
        }
    }

    return bestIndex >= 0 ? palette[bestIndex] : null;
}
function findNearestLab(color: LabColor, palette: LabColor[]): LabColor | null {
    const index = findNearestIndex(color, palette);
    return index >= 0 ? palette[index] : null;
}

function findNearestIndex(color: LabColor, palette: LabColor[]): number {
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < palette.length; i++) {
        const candidate = palette[i];
        const dl = color.l - candidate.l;
        const da = color.a - candidate.a;
        const db = color.b - candidate.b;
        const distance = dl * dl + da * da + db * db;
        if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = i;
        }
    }
    return bestIndex;
}

function rgbToLab(r: number, g: number, b: number): LabColor {
    const sr = pivotRgb(r / 255);
    const sg = pivotRgb(g / 255);
    const sb = pivotRgb(b / 255);
    const x = (sr * 0.4124564 + sg * 0.3575761 + sb * 0.1804375) / 0.95047;
    const y = (sr * 0.2126729 + sg * 0.7151522 + sb * 0.0721750);
    const z = (sr * 0.0193339 + sg * 0.1191920 + sb * 0.9503041) / 1.08883;
    const fx = pivotXyz(x);
    const fy = pivotXyz(y);
    const fz = pivotXyz(z);
    return { l: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

function labToRgb(l: number, a: number, b: number): { r: number; g: number; b: number } {
    const fy = (l + 16) / 116;
    const fx = a / 500 + fy;
    const fz = fy - b / 200;
    const x = 0.95047 * inversePivotXyz(fx);
    const y = inversePivotXyz(fy);
    const z = 1.08883 * inversePivotXyz(fz);
    const linearR = x * 3.2404542 + y * -1.5371385 + z * -0.4985314;
    const linearG = x * -0.9692660 + y * 1.8760108 + z * 0.0415560;
    const linearB = x * 0.0556434 + y * -0.2040259 + z * 1.0572252;
    return {
        r: clampByte(inversePivotRgb(linearR) * 255),
        g: clampByte(inversePivotRgb(linearG) * 255),
        b: clampByte(inversePivotRgb(linearB) * 255)
    };
}

function pivotRgb(value: number): number {
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function inversePivotRgb(value: number): number {
    const clamped = Math.max(0, Math.min(1, value));
    return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * (clamped ** (1 / 2.4)) - 0.055;
}

function pivotXyz(value: number): number {
    return value > 0.008856 ? Math.cbrt(value) : (7.787 * value) + (16 / 116);
}

function inversePivotXyz(value: number): number {
    const cube = value ** 3;
    return cube > 0.008856 ? cube : (value - 16 / 116) / 7.787;
}

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

function clampByte(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(255, Math.round(value)));
}

