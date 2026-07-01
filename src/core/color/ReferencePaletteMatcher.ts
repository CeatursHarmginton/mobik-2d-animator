/**
 * Reference Palette Matcher - perceptual, part-aware LAB palette harmonization.
 *
 * Goal: make the *same body part* of any spritesheet adopt the color of the
 * matching part in a reference frame, while preserving the part's own shading.
 *
 * Pipeline:
 *   1. Extract a weighted reference palette with k-means++ (CIEDE2000-aware).
 *   2. Extract a small weighted source palette from the frame being matched.
 *   3. Map every source cluster to the *perceptually nearest* reference cluster
 *      using a hue/chroma-weighted CIEDE2000 metric. This is what keeps "red
 *      stays red" even when two sheets rank their colors differently by
 *      lightness - the previous lightness-only ranking could swap parts.
 *   4. Recolor each pixel toward its mapped reference color while re-applying
 *      the pixel's original lightness *delta* (shading) around the new base.
 *
 * The public API (function names, `ReferencePalette.colors`, the `strength` /
 * `preserveShading` / `paletteSize` / `alphaThreshold` / `maxSamplePixels`
 * options) is unchanged. New capabilities are exposed only through additional
 * optional fields, so existing callers keep working untouched.
 *
 * @module core/color/ReferencePaletteMatcher
 */

export type PaletteSize = 16 | 32 | 48;

export interface ReferencePaletteOptions {
    paletteSize?: PaletteSize;
    alphaThreshold?: number;
    maxSamplePixels?: number;
    /** Ignore near-white/near-black flat background on fully opaque sheets. Default true. */
    skipFlatBackground?: boolean;
}

export interface PaletteMatchOptions extends ReferencePaletteOptions {
    /** How strongly the base color (hue + chroma + base lightness) snaps to the reference. 0..1. */
    strength?: number;
    /** How much of the pixel's own shading detail is retained on top of the new base. 0..1. */
    preserveShading?: number;
    /**
     * How much lightness influences *which* reference color a part matches. 0..1.
     * Low values match parts almost purely by hue/chroma (recommended for
     * cross-spritesheet part matching); 1 weighs lightness like standard CIEDE2000.
     * Default 0.5.
     */
    lightnessTolerance?: number;
    /** Optional explicit size of the per-frame source palette used for mapping. */
    sourcePaletteSize?: number;
}

/**
 * Cross-frame palette consistency strategy for {@link applyPaletteMatchToFrames}.
 *
 *  - `per_frame`      : legacy behavior. Every frame extracts its own source
 *                       palette and maps it independently. Maximum per-frame
 *                       adaptivity, but the source clustering can differ frame
 *                       to frame and cause color flicker across an animation.
 *  - `global_sheet`   : sample a *single* source palette from all target frames
 *                       (bounded sampling), map it to the reference once, then
 *                       apply that one shared mapping to every frame. Kills
 *                       flicker while still preserving each pixel's own shading.
 *  - `reference_locked`: lock the clustering to the reference palette itself
 *                       (source clusters = reference clusters, identity map).
 *                       The palette used is identical for every frame, so parts
 *                       can never be reassigned between frames.
 *
 * Default is `per_frame` to remain byte-for-byte backward compatible; callers
 * that want stable animation colors should opt into `global_sheet`.
 */
export type PaletteConsistencyMode = 'per_frame' | 'global_sheet' | 'reference_locked';

export interface ApplyPaletteMatchToFramesOptions extends PaletteMatchOptions {
    targetIndices?: number[];
    /** Cross-frame consistency strategy. Default `per_frame` (unchanged). */
    paletteConsistency?: PaletteConsistencyMode;
}

export interface LabColor {
    l: number;
    a: number;
    b: number;
}

export interface ReferencePalette {
    colors: LabColor[];
    /** Population (sampled pixel weight) behind each palette color, aligned with `colors`. */
    weights?: number[];
    sourcePixelCount: number;
    requestedSize: number;
}

/** Internal weighted LAB sample / cluster. */
interface WeightedLab extends LabColor {
    weight: number;
}

interface Cluster {
    center: LabColor;
    weight: number;
}

const DEFAULT_PALETTE_SIZE: PaletteSize = 32;
const DEFAULT_ALPHA_THRESHOLD = 10;
const DEFAULT_MAX_SAMPLE_PIXELS = 30000;
const DEFAULT_STRENGTH = 0.65;
const DEFAULT_PRESERVE_SHADING = 0.75;
const DEFAULT_LIGHTNESS_TOLERANCE = 0.5;

const KMEANS_ITERATIONS = 24;
const KMEANS_RESTARTS_REFERENCE = 3;
const KMEANS_RESTARTS_SOURCE = 1;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function extractReferencePalette(referenceFrame: ImageData, options: ReferencePaletteOptions = {}): ReferencePalette {
    const alphaThreshold = options.alphaThreshold ?? DEFAULT_ALPHA_THRESHOLD;
    const requestedSize = options.paletteSize ?? DEFAULT_PALETTE_SIZE;
    const maxSamplePixels = options.maxSamplePixels ?? DEFAULT_MAX_SAMPLE_PIXELS;
    const skipFlatBackground = options.skipFlatBackground ?? true;

    const sample = sampleWeightedLab(referenceFrame, alphaThreshold, maxSamplePixels, skipFlatBackground);
    if (sample.histogram.length === 0) {
        return { colors: [], weights: [], sourcePixelCount: 0, requestedSize };
    }

    const clusterCount = Math.max(1, Math.min(requestedSize, sample.histogram.length));
    const clusters = computeWeightedPalette(sample.histogram, clusterCount, KMEANS_RESTARTS_REFERENCE);

    return {
        colors: clusters.map(cluster => cluster.center),
        weights: clusters.map(cluster => cluster.weight),
        sourcePixelCount: sample.validPixelCount,
        requestedSize
    };
}

export function applyPaletteMatch(
    frame: ImageData,
    palette: ReferencePalette | LabColor[],
    options: PaletteMatchOptions = {}
): ImageData {
    const referenceClusters = resolveReferenceClusters(palette);

    const output = new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height);
    if (referenceClusters.length === 0 || frame.data.length === 0) {
        return output;
    }

    // Build a small, per-frame source palette so we can map whole parts (not
    // individual shaded pixels) and re-base their lightness coherently.
    const sourceClusters = buildFrameSourceClusters(frame, referenceClusters.length, options);
    if (sourceClusters.length === 0) {
        return output;
    }

    // Perceptual, hue/chroma-aware mapping: each source part -> nearest reference part.
    const lightnessTolerance = clamp01(options.lightnessTolerance ?? DEFAULT_LIGHTNESS_TOLERANCE);
    const clusterTargets = mapSourceToReference(sourceClusters, referenceClusters, lightnessTolerance);

    recolorInto(output, sourceClusters, clusterTargets, options);
    return output;
}

// ---------------------------------------------------------------------------
// Internal composable steps (shared by per-frame and cross-frame consistency).
//
// These exist purely to let `applyPaletteMatchToFrames` reuse the *exact* same
// recolor math with a shared plan; `applyPaletteMatch` still composes them in
// the original order so its output is byte-for-byte unchanged.
// ---------------------------------------------------------------------------

/** Turn a palette (array or ReferencePalette) into weighted reference clusters. */
function resolveReferenceClusters(palette: ReferencePalette | LabColor[]): Cluster[] {
    const referenceColors = Array.isArray(palette) ? palette : palette.colors;
    const referenceWeights = Array.isArray(palette) ? undefined : palette.weights;
    return referenceColors.map((center, index) => ({
        center,
        weight: referenceWeights?.[index] ?? 1
    }));
}

/** Extract the small per-frame source palette used for part mapping. */
function buildFrameSourceClusters(frame: ImageData, referenceCount: number, options: PaletteMatchOptions): Cluster[] {
    const alphaThreshold = options.alphaThreshold ?? DEFAULT_ALPHA_THRESHOLD;
    const skipFlatBackground = options.skipFlatBackground ?? true;
    const sourceSize = clampInt(
        options.sourcePaletteSize ?? Math.min(referenceCount, options.paletteSize ?? DEFAULT_PALETTE_SIZE),
        1,
        64
    );
    const sourceSample = sampleWeightedLab(
        frame,
        alphaThreshold,
        Math.min(options.maxSamplePixels ?? DEFAULT_MAX_SAMPLE_PIXELS, 12000),
        skipFlatBackground
    );
    if (sourceSample.histogram.length === 0) {
        return [];
    }
    return computeWeightedPalette(
        sourceSample.histogram,
        Math.max(1, Math.min(sourceSize, sourceSample.histogram.length)),
        KMEANS_RESTARTS_SOURCE
    );
}

/**
 * Recolor `output` (in place) by pushing every opaque pixel toward the mapped
 * reference color while re-applying its own lightness delta (shading). This is
 * the single source of truth for the per-pixel math, so every consistency mode
 * behaves identically at the pixel level.
 */
function recolorInto(
    output: ImageData,
    sourceClusters: Cluster[],
    clusterTargets: LabColor[],
    options: PaletteMatchOptions
): void {
    const alphaThreshold = options.alphaThreshold ?? DEFAULT_ALPHA_THRESHOLD;
    const strength = clamp01(options.strength ?? DEFAULT_STRENGTH);
    const preserveShading = clamp01(options.preserveShading ?? DEFAULT_PRESERVE_SHADING);

    // detailScale controls how much of the original per-pixel shading survives.
    // At strength 0 it is 1 (exact identity); at full strength it equals preserveShading.
    const detailScale = 1 - strength * (1 - preserveShading);

    const data = output.data;
    for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3];
        if (alpha <= alphaThreshold) continue;

        const lab = rgbToLab(data[i], data[i + 1], data[i + 2]);
        const sourceIndex = nearestClusterIndex(lab, sourceClusters);
        if (sourceIndex < 0) continue;

        const base = sourceClusters[sourceIndex].center;
        const target = clusterTargets[sourceIndex];

        const shadingDelta = lab.l - base.l;
        const matched: LabColor = {
            l: lerp(base.l, target.l, strength) + shadingDelta * detailScale,
            a: lerp(lab.a, target.a, strength),
            b: lerp(lab.b, target.b, strength)
        };

        const rgb = labToRgb(matched.l, matched.a, matched.b);
        data[i] = rgb.r;
        data[i + 1] = rgb.g;
        data[i + 2] = rgb.b;
        data[i + 3] = alpha;
    }
}

export function applyPaletteMatchToFrames(
    frames: ImageData[],
    referenceIndex: number,
    options: ApplyPaletteMatchToFramesOptions = {}
): ImageData[] {
    if (frames.length === 0) return [];
    const safeReferenceIndex = Math.max(0, Math.min(frames.length - 1, referenceIndex));
    const palette = extractReferencePalette(frames[safeReferenceIndex], options);
    return applyPaletteMatchAcrossFrames(frames, palette, options);
}

/**
 * Apply a reference palette to many frames with an explicit
 * {@link PaletteConsistencyMode}, using a palette you already have (extracted
 * from an external reference image, cached, etc.). This is the shared engine
 * behind {@link applyPaletteMatchToFrames}; it is exposed so callers whose
 * reference lives outside the frame array (a loaded reference image, a cached
 * palette, ...) can still get flicker-free `global_sheet` / `reference_locked`
 * behavior.
 *
 * `per_frame` is byte-for-byte identical to calling {@link applyPaletteMatch}
 * on each targeted frame. Non-targeted frames are returned as untouched copies.
 */
export function applyPaletteMatchAcrossFrames(
    frames: ImageData[],
    palette: ReferencePalette | LabColor[],
    options: ApplyPaletteMatchToFramesOptions = {}
): ImageData[] {
    if (frames.length === 0) return [];
    const referenceClusters = resolveReferenceClusters(palette);
    const targets = new Set(options.targetIndices ?? frames.map((_, index) => index));
    const mode: PaletteConsistencyMode = options.paletteConsistency ?? 'per_frame';

    // Empty reference palette (e.g. fully transparent reference frame): there is
    // nothing to harmonize toward, so every frame passes through untouched.
    if (referenceClusters.length === 0) {
        return frames.map(copyImageData);
    }

    // --- Legacy per-frame path (byte-for-byte unchanged) ------------------
    if (mode === 'per_frame') {
        return frames.map((frame, index) =>
            targets.has(index) ? applyPaletteMatch(frame, palette, options) : copyImageData(frame)
        );
    }

    // --- Shared plan for global_sheet / reference_locked ------------------
    // Build ONE plan and apply it to every target frame so a given part maps to
    // the same reference color in all frames (no cross-frame flicker), while
    // recolorInto still re-applies each pixel's own lightness delta (shading).
    const targetFrames = frames.filter((_, index) => targets.has(index));
    const shared = buildSharedPlan(targetFrames, referenceClusters, mode, options);
    if (!shared) {
        return frames.map(copyImageData);
    }
    const plan: PaletteMatchPlan = { ...shared, mode };

    return frames.map((frame, index) => {
        if (!targets.has(index)) return copyImageData(frame);
        return applyPaletteMatchPlan(frame, plan, options);
    });
}

/**
 * A precomputed, reusable recolor plan for the `global_sheet` /
 * `reference_locked` modes: a fixed set of source clusters and the reference
 * color each maps to. Apply it to any single frame with
 * {@link applyPaletteMatchPlan}. This lets a UI preview a single frame with the
 * exact same mapping a full-sheet apply will use (no preview/apply mismatch).
 */
export interface PaletteMatchPlan {
    sourceClusters: { center: LabColor; weight: number }[];
    clusterTargets: LabColor[];
    mode: PaletteConsistencyMode;
}

/**
 * Build the shared cross-frame plan for `global_sheet` / `reference_locked`.
 * Returns `null` for `per_frame` (which has no single shared plan), for an empty
 * reference palette, or when nothing visible could be sampled - callers should
 * then fall back to the per-frame path.
 */
export function buildPaletteMatchPlan(
    frames: ImageData[],
    palette: ReferencePalette | LabColor[],
    options: ApplyPaletteMatchToFramesOptions = {}
): PaletteMatchPlan | null {
    const referenceClusters = resolveReferenceClusters(palette);
    if (referenceClusters.length === 0) return null;

    const mode: PaletteConsistencyMode = options.paletteConsistency ?? 'per_frame';
    if (mode === 'per_frame') return null;

    const targets = options.targetIndices;
    const targetFrames = targets ? frames.filter((_, index) => targets.includes(index)) : frames;

    const shared = buildSharedPlan(targetFrames, referenceClusters, mode, options);
    return shared ? { ...shared, mode } : null;
}

/**
 * Recolor a single frame using a precomputed {@link PaletteMatchPlan}. Honors
 * `strength` / `preserveShading` / `alphaThreshold` from `options` exactly like
 * the full apply, so a preview and a full-sheet apply produce identical pixels.
 */
export function applyPaletteMatchPlan(
    frame: ImageData,
    plan: PaletteMatchPlan,
    options: PaletteMatchOptions = {}
): ImageData {
    const output = copyImageData(frame);
    if (plan.sourceClusters.length === 0 || frame.data.length === 0) return output;
    recolorInto(output, plan.sourceClusters, plan.clusterTargets, options);
    return output;
}

/**
 * Internal: compute (sourceClusters, clusterTargets) for the non-per_frame
 * modes. `reference_locked` uses the reference palette as its own source with an
 * identity map; `global_sheet` samples one bounded palette across the frames and
 * maps it to the reference once. Returns null when nothing could be sampled.
 */
function buildSharedPlan(
    targetFrames: ImageData[],
    referenceClusters: Cluster[],
    mode: PaletteConsistencyMode,
    options: ApplyPaletteMatchToFramesOptions
): { sourceClusters: Cluster[]; clusterTargets: LabColor[] } | null {
    if (mode === 'reference_locked') {
        // Lock clustering to the reference palette itself: source == reference,
        // identity mapping. The palette is identical for every frame, so parts
        // can never be reassigned frame to frame.
        return {
            sourceClusters: referenceClusters,
            clusterTargets: referenceClusters.map(cluster => cluster.center)
        };
    }

    // global_sheet: sample one source palette from all target frames (with a
    // bounded total sample budget) and map it to the reference a single time.
    const lightnessTolerance = clamp01(options.lightnessTolerance ?? DEFAULT_LIGHTNESS_TOLERANCE);
    const referenceCount = referenceClusters.length;
    const sourceSize = clampInt(
        options.sourcePaletteSize ?? Math.min(referenceCount, options.paletteSize ?? DEFAULT_PALETTE_SIZE),
        1,
        64
    );
    const alphaThreshold = options.alphaThreshold ?? DEFAULT_ALPHA_THRESHOLD;
    const skipFlatBackground = options.skipFlatBackground ?? true;
    const totalBudget = Math.min(options.maxSamplePixels ?? DEFAULT_MAX_SAMPLE_PIXELS, DEFAULT_MAX_SAMPLE_PIXELS);

    const globalSample = sampleWeightedLabFromFrames(targetFrames, alphaThreshold, totalBudget, skipFlatBackground);
    if (globalSample.histogram.length === 0) return null;

    const sourceClusters = computeWeightedPalette(
        globalSample.histogram,
        Math.max(1, Math.min(sourceSize, globalSample.histogram.length)),
        KMEANS_RESTARTS_SOURCE
    );
    if (sourceClusters.length === 0) return null;
    return {
        sourceClusters,
        clusterTargets: mapSourceToReference(sourceClusters, referenceClusters, lightnessTolerance)
    };
}

/** Shallow (buffer-copied) clone of an ImageData, used for untouched frames. */
function copyImageData(frame: ImageData): ImageData {
    return new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height);
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

interface WeightedSample {
    /** Deduplicated, weighted LAB colors (a histogram over quantized color space). */
    histogram: WeightedLab[];
    /** Total number of valid (matched-against) pixels, before deduplication. */
    validPixelCount: number;
}

/**
 * Collect a weighted LAB histogram of the visible pixels. Transparent pixels
 * (and, on fully opaque sheets, flat near-white/near-black background) are
 * excluded so the palette concentrates on the character itself.
 */
function sampleWeightedLab(
    imageData: ImageData,
    alphaThreshold: number,
    maxSamples: number,
    skipFlatBackground: boolean
): WeightedSample {
    const data = imageData.data;
    const opaqueSheet = skipFlatBackground && !hasMeaningfulTransparency(data);

    // First pass: count valid pixels so we can compute a sampling stride.
    let validPixelCount = 0;
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] <= alphaThreshold) continue;
        if (opaqueSheet && isLikelyFlatBackground(data[i], data[i + 1], data[i + 2])) continue;
        validPixelCount++;
    }
    if (validPixelCount === 0) {
        return { histogram: [], validPixelCount: 0 };
    }

    const stride = Math.max(1, Math.ceil(validPixelCount / Math.max(1, maxSamples)));
    const buckets = new Map<number, WeightedLab>();
    let seen = 0;

    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] <= alphaThreshold) continue;
        if (opaqueSheet && isLikelyFlatBackground(data[i], data[i + 1], data[i + 2])) continue;

        if (seen % stride === 0) {
            const lab = rgbToLab(data[i], data[i + 1], data[i + 2]);
            // Quantize to ~0.5 LAB units to merge near-identical colors while
            // keeping distinct part colors apart.
            const key = quantizeKey(lab);
            const bucket = buckets.get(key);
            if (bucket) {
                bucket.l += lab.l;
                bucket.a += lab.a;
                bucket.b += lab.b;
                bucket.weight += 1;
            } else {
                buckets.set(key, { l: lab.l, a: lab.a, b: lab.b, weight: 1 });
            }
        }
        seen++;
    }

    // Convert summed buckets into mean-color weighted samples.
    const histogram: WeightedLab[] = [];
    for (const bucket of buckets.values()) {
        histogram.push({
            l: bucket.l / bucket.weight,
            a: bucket.a / bucket.weight,
            b: bucket.b / bucket.weight,
            weight: bucket.weight
        });
    }

    return { histogram, validPixelCount };
}

/**
 * Aggregate a *single* weighted LAB histogram across many frames, used by the
 * `global_sheet` consistency mode. The total sample budget is split evenly
 * across the frames so the cost stays bounded regardless of sheet size, then
 * each frame's per-bucket means are merged back into one weighted histogram.
 */
function sampleWeightedLabFromFrames(
    frames: ImageData[],
    alphaThreshold: number,
    maxSamplesTotal: number,
    skipFlatBackground: boolean
): WeightedSample {
    if (frames.length === 0) {
        return { histogram: [], validPixelCount: 0 };
    }
    const perFrameBudget = Math.max(1, Math.floor(maxSamplesTotal / frames.length));
    const buckets = new Map<number, WeightedLab>();
    let validPixelCount = 0;

    for (const frame of frames) {
        const sample = sampleWeightedLab(frame, alphaThreshold, perFrameBudget, skipFlatBackground);
        validPixelCount += sample.validPixelCount;
        for (const entry of sample.histogram) {
            // entry.{l,a,b} are per-bucket means; re-weight by entry.weight so the
            // merged mean is a proper weighted average across all frames.
            const key = quantizeKey(entry);
            const bucket = buckets.get(key);
            if (bucket) {
                bucket.l += entry.l * entry.weight;
                bucket.a += entry.a * entry.weight;
                bucket.b += entry.b * entry.weight;
                bucket.weight += entry.weight;
            } else {
                buckets.set(key, {
                    l: entry.l * entry.weight,
                    a: entry.a * entry.weight,
                    b: entry.b * entry.weight,
                    weight: entry.weight
                });
            }
        }
    }

    const histogram: WeightedLab[] = [];
    for (const bucket of buckets.values()) {
        histogram.push({
            l: bucket.l / bucket.weight,
            a: bucket.a / bucket.weight,
            b: bucket.b / bucket.weight,
            weight: bucket.weight
        });
    }

    return { histogram, validPixelCount };
}

function quantizeKey(lab: LabColor): number {
    // Range-safe packing: L in [0,100], a/b roughly [-128,127]. Step 0.5.
    const ql = Math.round(lab.l * 2);
    const qa = Math.round((lab.a + 128) * 2);
    const qb = Math.round((lab.b + 128) * 2);
    return (ql * 1024 + qa) * 1024 + qb;
}

function hasMeaningfulTransparency(data: Uint8ClampedArray): boolean {
    for (let i = 3; i < data.length; i += 4) {
        if (data[i] < 250) return true;
    }
    return false;
}

function isLikelyFlatBackground(r: number, g: number, b: number): boolean {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const saturation = max === 0 ? 0 : (max - min) / max;
    const luminance = 0.299 * rn + 0.587 * gn + 0.114 * bn;
    return saturation < 0.08 && (luminance > 0.92 || luminance < 0.06);
}

// ---------------------------------------------------------------------------
// Weighted k-means++ clustering
// ---------------------------------------------------------------------------

function computeWeightedPalette(points: WeightedLab[], k: number, restarts: number): Cluster[] {
    if (points.length === 0) return [];
    if (points.length <= k) {
        return points.map(point => ({ center: { l: point.l, a: point.a, b: point.b }, weight: point.weight }));
    }

    let best: Cluster[] | null = null;
    let bestInertia = Number.POSITIVE_INFINITY;

    for (let restart = 0; restart < Math.max(1, restarts); restart++) {
        const seed = 0x9e3779b9 ^ (restart * 0x85ebca6b);
        const result = runWeightedKMeansOnce(points, k, seed);
        if (result.inertia < bestInertia) {
            bestInertia = result.inertia;
            best = result.clusters;
        }
    }

    return best ?? [];
}

function runWeightedKMeansOnce(points: WeightedLab[], k: number, seed: number): { clusters: Cluster[]; inertia: number } {
    const random = makeRandom(seed);
    let centers = kmeansPlusPlusInit(points, k, random);
    const assignments = new Int32Array(points.length).fill(-1);

    for (let iteration = 0; iteration < KMEANS_ITERATIONS; iteration++) {
        let changed = false;

        const sums = Array.from({ length: k }, () => ({ l: 0, a: 0, b: 0, weight: 0 }));
        for (let i = 0; i < points.length; i++) {
            const nearest = nearestCenterIndex(points[i], centers);
            if (assignments[i] !== nearest) {
                assignments[i] = nearest;
                changed = true;
            }
            const sum = sums[nearest];
            const w = points[i].weight;
            sum.l += points[i].l * w;
            sum.a += points[i].a * w;
            sum.b += points[i].b * w;
            sum.weight += w;
        }

        centers = centers.map((center, index) => {
            const sum = sums[index];
            if (sum.weight === 0) {
                // Reseed an empty cluster onto the point that is currently worst served.
                return farthestPoint(points, centers, random);
            }
            return { l: sum.l / sum.weight, a: sum.a / sum.weight, b: sum.b / sum.weight };
        });

        if (!changed && iteration > 0) break;
    }

    // Final assignment + per-cluster weight + inertia.
    const weights = new Array<number>(k).fill(0);
    let inertia = 0;
    for (let i = 0; i < points.length; i++) {
        const nearest = nearestCenterIndex(points[i], centers);
        weights[nearest] += points[i].weight;
        inertia += squaredLabDistance(points[i], centers[nearest]) * points[i].weight;
    }

    const clusters: Cluster[] = [];
    for (let i = 0; i < k; i++) {
        const center = centers[i];
        if (weights[i] > 0 && Number.isFinite(center.l) && Number.isFinite(center.a) && Number.isFinite(center.b)) {
            clusters.push({ center, weight: weights[i] });
        }
    }

    // Order by population so dominant part colors come first (handy for callers).
    clusters.sort((left, right) => right.weight - left.weight);
    return { clusters, inertia };
}

function kmeansPlusPlusInit(points: WeightedLab[], k: number, random: () => number): LabColor[] {
    const centers: LabColor[] = [];
    const totalWeight = points.reduce((sum, point) => sum + point.weight, 0);

    // First center: weighted-random pick.
    centers.push({ ...pickWeighted(points, totalWeight, random) });

    const distances = new Float64Array(points.length).fill(Number.POSITIVE_INFINITY);
    for (let c = 1; c < k; c++) {
        let weightedDistanceSum = 0;
        for (let i = 0; i < points.length; i++) {
            const d = squaredLabDistance(points[i], centers[centers.length - 1]);
            if (d < distances[i]) distances[i] = d;
            weightedDistanceSum += distances[i] * points[i].weight;
        }

        if (weightedDistanceSum <= 0) {
            centers.push({ ...points[Math.floor(random() * points.length)] });
            continue;
        }

        // Choose the next center with probability proportional to D^2 * weight.
        let threshold = random() * weightedDistanceSum;
        let chosen = points.length - 1;
        for (let i = 0; i < points.length; i++) {
            threshold -= distances[i] * points[i].weight;
            if (threshold <= 0) {
                chosen = i;
                break;
            }
        }
        centers.push({ ...points[chosen] });
    }

    return centers;
}

function pickWeighted(points: WeightedLab[], totalWeight: number, random: () => number): WeightedLab {
    let threshold = random() * totalWeight;
    for (const point of points) {
        threshold -= point.weight;
        if (threshold <= 0) return point;
    }
    return points[points.length - 1];
}

function farthestPoint(points: WeightedLab[], centers: LabColor[], random: () => number): LabColor {
    let bestIndex = Math.floor(random() * points.length);
    let bestDistance = -1;
    for (let i = 0; i < points.length; i++) {
        let nearest = Number.POSITIVE_INFINITY;
        for (const center of centers) {
            const d = squaredLabDistance(points[i], center);
            if (d < nearest) nearest = d;
        }
        if (nearest > bestDistance) {
            bestDistance = nearest;
            bestIndex = i;
        }
    }
    return { ...points[bestIndex] };
}

// ---------------------------------------------------------------------------
// Part mapping (the accuracy-critical step)
// ---------------------------------------------------------------------------

/**
 * For each source cluster, find the perceptually nearest reference cluster using
 * a hue/chroma-weighted CIEDE2000 metric. The mapping is non-exclusive: several
 * source clusters (e.g. shades of one shirt) may share a reference target. This
 * is what makes a part adopt the matching part's color rather than whichever
 * reference color happens to share its lightness rank.
 */
function mapSourceToReference(source: Cluster[], reference: Cluster[], lightnessTolerance: number): LabColor[] {
    if (reference.length === 0) return source.map(cluster => cluster.center);

    // kL > 1 reduces the contribution of lightness so parts match by hue/chroma.
    // lightnessTolerance 0 -> kL 4 (lightness nearly ignored); 1 -> kL 1 (standard).
    const kL = lerp(4, 1, clamp01(lightnessTolerance));

    return source.map(sourceCluster => {
        let bestIndex = 0;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let i = 0; i < reference.length; i++) {
            const distance = deltaE2000(sourceCluster.center, reference[i].center, kL, 1, 1);
            if (distance < bestDistance) {
                bestDistance = distance;
                bestIndex = i;
            }
        }
        return reference[bestIndex].center;
    });
}

function nearestClusterIndex(color: LabColor, clusters: Cluster[]): number {
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < clusters.length; i++) {
        const d = squaredLabDistance(color, clusters[i].center);
        if (d < bestDistance) {
            bestDistance = d;
            bestIndex = i;
        }
    }
    return bestIndex;
}

function nearestCenterIndex(color: LabColor, centers: LabColor[]): number {
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < centers.length; i++) {
        const d = squaredLabDistance(color, centers[i]);
        if (d < bestDistance) {
            bestDistance = d;
            bestIndex = i;
        }
    }
    return bestIndex;
}

function squaredLabDistance(a: LabColor, b: LabColor): number {
    const dl = a.l - b.l;
    const da = a.a - b.a;
    const db = a.b - b.b;
    return dl * dl + da * da + db * db;
}

// ---------------------------------------------------------------------------
// CIEDE2000 perceptual color difference
// ---------------------------------------------------------------------------

/**
 * CIEDE2000 color difference between two LAB colors.
 * kL/kC/kH are parametric weighting factors (all 1 for the standard metric).
 */
function deltaE2000(reference: LabColor, sample: LabColor, kL = 1, kC = 1, kH = 1): number {
    const l1 = reference.l;
    const a1 = reference.a;
    const b1 = reference.b;
    const l2 = sample.l;
    const a2 = sample.a;
    const b2 = sample.b;

    const c1 = Math.sqrt(a1 * a1 + b1 * b1);
    const c2 = Math.sqrt(a2 * a2 + b2 * b2);
    const cBar = (c1 + c2) / 2;

    const cBar7 = cBar ** 7;
    const g = 0.5 * (1 - Math.sqrt(cBar7 / (cBar7 + 25 ** 7)));

    const a1p = (1 + g) * a1;
    const a2p = (1 + g) * a2;
    const c1p = Math.sqrt(a1p * a1p + b1 * b1);
    const c2p = Math.sqrt(a2p * a2p + b2 * b2);

    const h1p = hueAngle(b1, a1p);
    const h2p = hueAngle(b2, a2p);

    const dLp = l2 - l1;
    const dCp = c2p - c1p;

    let dhp = 0;
    if (c1p * c2p !== 0) {
        const diff = h2p - h1p;
        if (Math.abs(diff) <= 180) {
            dhp = diff;
        } else if (diff > 180) {
            dhp = diff - 360;
        } else {
            dhp = diff + 360;
        }
    }
    const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin(degToRad(dhp) / 2);

    const lBarP = (l1 + l2) / 2;
    const cBarP = (c1p + c2p) / 2;

    let hBarP = h1p + h2p;
    if (c1p * c2p !== 0) {
        if (Math.abs(h1p - h2p) > 180) {
            hBarP += h1p + h2p < 360 ? 360 : -360;
        }
        hBarP /= 2;
    }

    const t = 1
        - 0.17 * Math.cos(degToRad(hBarP - 30))
        + 0.24 * Math.cos(degToRad(2 * hBarP))
        + 0.32 * Math.cos(degToRad(3 * hBarP + 6))
        - 0.20 * Math.cos(degToRad(4 * hBarP - 63));

    const dTheta = 30 * Math.exp(-(((hBarP - 275) / 25) ** 2));
    const cBarP7 = cBarP ** 7;
    const rc = 2 * Math.sqrt(cBarP7 / (cBarP7 + 25 ** 7));
    const sl = 1 + (0.015 * (lBarP - 50) ** 2) / Math.sqrt(20 + (lBarP - 50) ** 2);
    const sc = 1 + 0.045 * cBarP;
    const sh = 1 + 0.015 * cBarP * t;
    const rt = -Math.sin(degToRad(2 * dTheta)) * rc;

    const lTerm = dLp / (kL * sl);
    const cTerm = dCp / (kC * sc);
    const hTerm = dHp / (kH * sh);

    return Math.sqrt(lTerm * lTerm + cTerm * cTerm + hTerm * hTerm + rt * cTerm * hTerm);
}

function hueAngle(b: number, ap: number): number {
    if (ap === 0 && b === 0) return 0;
    let angle = radToDeg(Math.atan2(b, ap));
    if (angle < 0) angle += 360;
    return angle;
}

function degToRad(deg: number): number {
    return (deg * Math.PI) / 180;
}

function radToDeg(rad: number): number {
    return (rad * 180) / Math.PI;
}

// ---------------------------------------------------------------------------
// Color space conversions (sRGB <-> CIELAB, D65)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** Deterministic mulberry32 PRNG so palette extraction is reproducible. */
function makeRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state |= 0;
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function lerp(from: number, to: number, t: number): number {
    return from + (to - from) * t;
}

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

function clampInt(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, Math.round(value)));
}

function clampByte(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(255, Math.round(value)));
}
