import {
    extractReferencePalette,
    applyPaletteMatch,
    applyPaletteMatchToFrames,
    applyPaletteMatchAcrossFrames,
    applyPaletteMatchPlan,
    buildPaletteMatchPlan,
    LabColor
} from '../../../src/core/color/ReferencePaletteMatcher';

type Rgba = [number, number, number, number];

/** Build an ImageData of the given size, filled by a per-pixel RGBA callback. */
function makeImage(width: number, height: number, rgba: (index: number) => Rgba): ImageData {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const [r, g, b, a] = rgba(i);
        data[i * 4] = r;
        data[i * 4 + 1] = g;
        data[i * 4 + 2] = b;
        data[i * 4 + 3] = a;
    }
    return new ImageData(data, width, height);
}

const RED: Rgba = [220, 30, 30, 255];
const BLUE: Rgba = [30, 30, 220, 255];
const TRANSPARENT: Rgba = [0, 0, 0, 0];

describe('extractReferencePalette', () => {
    it('returns an empty palette for a fully transparent image', () => {
        const palette = extractReferencePalette(makeImage(4, 4, () => TRANSPARENT));
        expect(palette.colors).toHaveLength(0);
        expect(palette.sourcePixelCount).toBe(0);
        expect(palette.requestedSize).toBe(32); // module default
    });

    it('collapses a solid colour to a single cluster', () => {
        const palette = extractReferencePalette(makeImage(4, 4, () => RED));
        expect(palette.colors).toHaveLength(1);
        expect(palette.sourcePixelCount).toBe(16);

        const [color] = palette.colors;
        expect(Number.isFinite(color.l)).toBe(true);
        // Red has a strongly positive a* component in CIELAB.
        expect(color.a).toBeGreaterThan(40);
    });

    it('honours the requested palette size', () => {
        const image = makeImage(4, 4, (i) => (i % 2 === 0 ? RED : BLUE));
        const palette = extractReferencePalette(image, { paletteSize: 16 });
        expect(palette.requestedSize).toBe(16);
        expect(palette.colors.length).toBeGreaterThanOrEqual(1);
        expect(palette.colors.length).toBeLessThanOrEqual(16);
    });

    it('separates two distinct colours into two clusters', () => {
        const image = makeImage(4, 4, (i) => (i < 8 ? RED : BLUE));
        const palette = extractReferencePalette(image, { paletteSize: 16 });
        expect(palette.colors).toHaveLength(2);
    });
});

describe('applyPaletteMatch', () => {
    it('returns an unmodified copy when the palette is empty', () => {
        const image = makeImage(2, 2, () => RED);
        const result = applyPaletteMatch(image, []);

        expect(result).not.toBe(image);
        expect(result.width).toBe(2);
        expect(result.height).toBe(2);
        expect(Array.from(result.data)).toEqual(Array.from(image.data));
    });

    it('preserves dimensions and leaves transparent pixels untouched', () => {
        const image = makeImage(2, 1, (i) => (i === 0 ? RED : TRANSPARENT));
        const palette: LabColor[] = [{ l: 50, a: 0, b: 0 }];
        const result = applyPaletteMatch(image, palette, { strength: 1 });

        expect(result.width).toBe(2);
        expect(result.height).toBe(1);
        // The opaque pixel keeps full alpha.
        expect(result.data[3]).toBe(255);
        // The transparent pixel is copied through verbatim.
        expect(Array.from(result.data.slice(4, 8))).toEqual([0, 0, 0, 0]);
    });
});

describe('applyPaletteMatchToFrames', () => {
    it('returns an empty array when there are no frames', () => {
        expect(applyPaletteMatchToFrames([], 0)).toEqual([]);
    });

    it('only transforms the targeted frames and copies the rest', () => {
        const frames = [
            makeImage(2, 2, () => RED),
            makeImage(2, 2, () => BLUE),
            makeImage(2, 2, () => RED)
        ];
        const result = applyPaletteMatchToFrames(frames, 1, { targetIndices: [1] });

        expect(result).toHaveLength(3);
        for (const frame of result) {
            expect(frame.width).toBe(2);
            expect(frame.height).toBe(2);
        }
        // Untargeted frames are verbatim copies of their source.
        expect(Array.from(result[0].data)).toEqual(Array.from(frames[0].data));
        expect(Array.from(result[2].data)).toEqual(Array.from(frames[2].data));
    });

    it('clamps an out-of-range reference index without throwing', () => {
        const frames = [makeImage(2, 2, () => RED), makeImage(2, 2, () => BLUE)];
        expect(() => applyPaletteMatchToFrames(frames, 99)).not.toThrow();
        expect(applyPaletteMatchToFrames(frames, 99)).toHaveLength(2);
    });
});



// --- Upgraded engine: perceptual part matching ---------------------------

/** Build a 4x4 image whose first half is colorA and second half colorB. */
function twoRegionImage(colorA: Rgba, colorB: Rgba): ImageData {
    return makeImage(4, 4, (i) => (i < 8 ? colorA : colorB));
}

function pixel(image: ImageData, index: number): Rgba {
    const o = index * 4;
    return [image.data[o], image.data[o + 1], image.data[o + 2], image.data[o + 3]];
}

function luminance([r, g, b]: Rgba): number {
    return 0.299 * r + 0.587 * g + 0.114 * b;
}

describe('applyPaletteMatch - part matching by hue (not lightness rank)', () => {
    // Reference: a DARK red part and a BRIGHT green part.
    const REF_DARK_RED: Rgba = [120, 0, 0, 255];
    const REF_BRIGHT_GREEN: Rgba = [120, 255, 120, 255];
    // Target: a BRIGHT red part and a DARK green part - the lightness order is
    // the opposite of the reference. A lightness-rank mapping would swap the
    // parts (red -> green); a perceptual mapping must keep red matched to red.
    const TGT_BRIGHT_RED: Rgba = [255, 130, 130, 255];
    const TGT_DARK_GREEN: Rgba = [0, 80, 0, 255];

    it('keeps the red part red and the green part green across mismatched lightness', () => {
        const reference = twoRegionImage(REF_DARK_RED, REF_BRIGHT_GREEN);
        const target = twoRegionImage(TGT_BRIGHT_RED, TGT_DARK_GREEN);

        const palette = extractReferencePalette(reference, { paletteSize: 16 });
        expect(palette.colors).toHaveLength(2);

        const matched = applyPaletteMatch(target, palette, {
            strength: 1,
            preserveShading: 0,
            paletteSize: 16
        });

        const redRegion = pixel(matched, 0);   // was bright red
        const greenRegion = pixel(matched, 15); // was dark green

        // Red part must stay reddish (this fails under lightness-rank mapping).
        expect(redRegion[0]).toBeGreaterThan(redRegion[1]);
        expect(redRegion[0]).toBeGreaterThan(redRegion[2]);
        // Green part must stay greenish.
        expect(greenRegion[1]).toBeGreaterThan(greenRegion[0]);
        expect(greenRegion[1]).toBeGreaterThan(greenRegion[2]);
    });

    it('moves the target red toward the reference (darker) red, not the source red', () => {
        const reference = twoRegionImage(REF_DARK_RED, REF_BRIGHT_GREEN);
        const target = twoRegionImage(TGT_BRIGHT_RED, TGT_DARK_GREEN);
        const palette = extractReferencePalette(reference, { paletteSize: 16 });

        const matched = applyPaletteMatch(target, palette, {
            strength: 1,
            preserveShading: 0,
            paletteSize: 16
        });

        // Bright red (255) should be pulled down toward the reference dark red.
        const redRegion = pixel(matched, 0);
        expect(redRegion[0]).toBeLessThan(TGT_BRIGHT_RED[0]);
    });
});

describe('applyPaletteMatch - shading preservation', () => {
    it('keeps relative lightness order within a single recolored part', () => {
        // Two shades of the same red hue in the target...
        const LIGHT_RED: Rgba = [240, 170, 170, 255];
        const DARK_RED: Rgba = [110, 40, 40, 255];
        const target = twoRegionImage(LIGHT_RED, DARK_RED);

        // ...mapped against a single mid-red reference color.
        const MID_RED: Rgba = [190, 70, 70, 255];
        const reference = makeImage(4, 4, () => MID_RED);
        const palette = extractReferencePalette(reference, { paletteSize: 16 });
        expect(palette.colors).toHaveLength(1);

        const matched = applyPaletteMatch(target, palette, {
            strength: 1,
            preserveShading: 1,
            paletteSize: 16
        });

        const lightOut = pixel(matched, 0);
        const darkOut = pixel(matched, 15);

        // Both should be recolored, but the originally-lighter shade must remain
        // lighter than the darker shade (shading/gradient survives the match).
        expect(luminance(lightOut)).toBeGreaterThan(luminance(darkOut));
    });

    it('is an identity transform at strength 0', () => {
        const target = twoRegionImage(RED, BLUE);
        const palette = extractReferencePalette(makeImage(4, 4, () => BLUE));
        const matched = applyPaletteMatch(target, palette, { strength: 0 });
        expect(Array.from(matched.data)).toEqual(Array.from(target.data));
    });
});

describe('extractReferencePalette - weights', () => {
    it('returns a population weight aligned with each palette color', () => {
        // 12 red pixels, 4 blue pixels.
        const image = makeImage(4, 4, (i) => (i < 12 ? RED : BLUE));
        const palette = extractReferencePalette(image, { paletteSize: 16 });

        expect(palette.colors).toHaveLength(2);
        expect(palette.weights).toBeDefined();
        expect(palette.weights).toHaveLength(palette.colors.length);
        expect(palette.weights!.every((w) => w > 0)).toBe(true);

        // The dominant color carries the larger weight.
        const maxWeight = Math.max(...palette.weights!);
        const minWeight = Math.min(...palette.weights!);
        expect(maxWeight).toBeGreaterThan(minWeight);
    });
});



// ===========================================================================
// Cross-frame palette consistency (per_frame / global_sheet / reference_locked)
// ===========================================================================

const GREEN: Rgba = [30, 200, 30, 255];

/** Deep byte-equality helper for two ImageData buffers. */
function dataEquals(a: ImageData, b: ImageData): boolean {
    if (a.data.length !== b.data.length) return false;
    for (let i = 0; i < a.data.length; i++) {
        if (a.data[i] !== b.data[i]) return false;
    }
    return true;
}

describe('applyPaletteMatchToFrames - paletteConsistency', () => {
    it('defaults to per_frame and is byte-identical to explicit per_frame + manual per-frame', () => {
        const frames = [
            twoRegionImage(RED, GREEN),
            twoRegionImage([255, 120, 120, 255], [20, 90, 20, 255]),
            twoRegionImage([180, 40, 40, 255], [40, 150, 40, 255])
        ];
        const opts = { strength: 1, preserveShading: 0.5, paletteSize: 16 as const };

        const def = applyPaletteMatchToFrames(frames, 0, opts);
        const explicit = applyPaletteMatchToFrames(frames, 0, { ...opts, paletteConsistency: 'per_frame' });

        // Manual reference: extract once, apply per frame independently.
        const palette = extractReferencePalette(frames[0], opts);
        const manual = frames.map(f => applyPaletteMatch(f, palette, opts));

        for (let i = 0; i < frames.length; i++) {
            expect(dataEquals(def[i], explicit[i])).toBe(true);
            expect(dataEquals(def[i], manual[i])).toBe(true);
        }
    });

    it('global_sheet shares one mapping across frames where per_frame flickers', () => {
        // Force a SINGLE source cluster so the source centroid drifts with each
        // frame's dominant color under per_frame (classic cross-frame flicker).
        // frameA is mostly red, frameB is mostly green, but both carry a pure-red
        // pixel at index 0 that we compare across frames.
        const frameA = makeImage(4, 4, (i) => (i === 0 ? RED : i < 12 ? RED : GREEN));
        const frameB = makeImage(4, 4, (i) => (i === 0 ? RED : i < 12 ? GREEN : RED));
        const reference = twoRegionImage(RED, GREEN); // palette has both red and green
        const frames = [reference, frameA, frameB];

        const opts = {
            strength: 1,
            preserveShading: 0,
            sourcePaletteSize: 1,
            paletteSize: 16 as const,
            targetIndices: [1, 2]
        };

        const perFrame = applyPaletteMatchToFrames(frames, 0, { ...opts, paletteConsistency: 'per_frame' });
        const global = applyPaletteMatchToFrames(frames, 0, { ...opts, paletteConsistency: 'global_sheet' });

        // per_frame: the same red pixel maps toward different reference colors in
        // the two frames -> the outputs differ (this is the flicker we fix).
        expect(pixel(perFrame[1], 0)).not.toEqual(pixel(perFrame[2], 0));

        // global_sheet: one shared plan -> the same input pixel yields the SAME
        // output in every frame -> no flicker.
        expect(pixel(global[1], 0)).toEqual(pixel(global[2], 0));

        // Dimensions preserved and non-target frames copied.
        expect(global).toHaveLength(3);
        expect(dataEquals(global[0], reference)).toBe(true);
    });

    it('global_sheet keeps parts on-hue and leaves transparent pixels untouched', () => {
        const frames = [
            twoRegionImage(RED, GREEN),
            makeImage(4, 4, (i) => (i < 8 ? [255, 130, 130, 255] : TRANSPARENT)),
            twoRegionImage([160, 30, 30, 255], GREEN)
        ];
        const result = applyPaletteMatchToFrames(frames, 0, {
            paletteConsistency: 'global_sheet',
            strength: 1,
            preserveShading: 0.5,
            paletteSize: 16
        });

        expect(result).toHaveLength(3);
        for (const f of result) {
            expect(f.width).toBe(4);
            expect(f.height).toBe(4);
        }
        // The red half of frame 1 stays reddish...
        const red = pixel(result[1], 0);
        expect(red[0]).toBeGreaterThan(red[1]);
        expect(red[0]).toBeGreaterThan(red[2]);
        // ...and its transparent half is copied through verbatim.
        expect(Array.from(result[1].data.slice(8 * 4, 8 * 4 + 4))).toEqual([0, 0, 0, 0]);
    });

    it('reference_locked does not crash on transparent / low-color frames', () => {
        const frames = [
            twoRegionImage(RED, GREEN),
            makeImage(4, 4, () => TRANSPARENT),
            makeImage(4, 4, () => RED)
        ];
        let result!: ImageData[];
        expect(() => {
            result = applyPaletteMatchToFrames(frames, 0, {
                paletteConsistency: 'reference_locked',
                strength: 1,
                preserveShading: 1,
                paletteSize: 16
            });
        }).not.toThrow();

        expect(result).toHaveLength(3);
        // The fully transparent frame stays fully transparent.
        expect(Array.from(result[1].data).every(v => v === 0)).toBe(true);
    });

    it('reference_locked preserves within-part shading order', () => {
        const LIGHT_RED: Rgba = [240, 170, 170, 255];
        const DARK_RED: Rgba = [110, 40, 40, 255];
        const MID_RED: Rgba = [190, 70, 70, 255];
        const frames = [
            makeImage(4, 4, () => MID_RED),          // reference frame (single red)
            twoRegionImage(LIGHT_RED, DARK_RED)      // target with two shades
        ];

        const result = applyPaletteMatchToFrames(frames, 0, {
            paletteConsistency: 'reference_locked',
            targetIndices: [1],
            strength: 1,
            preserveShading: 1,
            paletteSize: 16
        });

        const lightOut = pixel(result[1], 0);
        const darkOut = pixel(result[1], 15);
        // Lighter shade remains lighter after locking to the reference red.
        expect(luminance(lightOut)).toBeGreaterThan(luminance(darkOut));
    });

    it('falls back to unchanged copies when the reference palette is empty (all modes)', () => {
        const frames = [
            makeImage(4, 4, () => TRANSPARENT), // empty reference -> empty palette
            twoRegionImage(RED, GREEN)
        ];
        for (const mode of ['per_frame', 'global_sheet', 'reference_locked'] as const) {
            const result = applyPaletteMatchToFrames(frames, 0, { paletteConsistency: mode, strength: 1 });
            expect(result).toHaveLength(2);
            expect(dataEquals(result[1], frames[1])).toBe(true);
        }
    });
});


describe('applyPaletteMatchAcrossFrames - palette-based engine (external reference)', () => {
    it('matches applyPaletteMatchToFrames when given the same extracted palette', () => {
        const frames = [
            twoRegionImage(RED, GREEN),
            twoRegionImage([255, 120, 120, 255], [20, 120, 20, 255]),
            twoRegionImage([170, 40, 40, 255], [40, 160, 40, 255])
        ];
        const opts = { strength: 1, preserveShading: 0.5, paletteSize: 16 as const };
        const palette = extractReferencePalette(frames[0], opts);

        for (const mode of ['per_frame', 'global_sheet', 'reference_locked'] as const) {
            const viaIndex = applyPaletteMatchToFrames(frames, 0, { ...opts, paletteConsistency: mode });
            const viaPalette = applyPaletteMatchAcrossFrames(frames, palette, { ...opts, paletteConsistency: mode });
            for (let i = 0; i < frames.length; i++) {
                expect(dataEquals(viaPalette[i], viaIndex[i])).toBe(true);
            }
        }
    });

    it('accepts a raw LabColor[] reference palette and preserves dimensions / transparency', () => {
        // An "external" palette (e.g. from a loaded reference image), not tied to
        // any frame in the array.
        const palette: LabColor[] = extractReferencePalette(twoRegionImage(RED, GREEN), { paletteSize: 16 }).colors;
        expect(palette.length).toBe(2);

        const frames = [
            makeImage(4, 4, (i) => (i < 8 ? [255, 130, 130, 255] : TRANSPARENT)),
            twoRegionImage([150, 30, 30, 255], GREEN)
        ];
        const result = applyPaletteMatchAcrossFrames(frames, palette, {
            paletteConsistency: 'global_sheet',
            strength: 1,
            preserveShading: 0.5
        });

        expect(result).toHaveLength(2);
        for (const f of result) {
            expect(f.width).toBe(4);
            expect(f.height).toBe(4);
        }
        // Red half stays reddish; transparent half is untouched.
        const red = pixel(result[0], 0);
        expect(red[0]).toBeGreaterThan(red[1]);
        expect(Array.from(result[0].data.slice(8 * 4, 8 * 4 + 4))).toEqual([0, 0, 0, 0]);
    });

    it('respects targetIndices and returns copies for the rest', () => {
        const palette: LabColor[] = [{ l: 50, a: 60, b: 40 }];
        const frames = [twoRegionImage(RED, GREEN), twoRegionImage(RED, GREEN), twoRegionImage(RED, GREEN)];
        const result = applyPaletteMatchAcrossFrames(frames, palette, {
            paletteConsistency: 'global_sheet',
            targetIndices: [1],
            strength: 1
        });
        expect(result).toHaveLength(3);
        expect(dataEquals(result[0], frames[0])).toBe(true);
        expect(dataEquals(result[2], frames[2])).toBe(true);
    });

    it('returns unchanged copies for an empty palette', () => {
        const frames = [twoRegionImage(RED, GREEN), twoRegionImage(RED, GREEN)];
        const result = applyPaletteMatchAcrossFrames(frames, [], { paletteConsistency: 'global_sheet' });
        expect(result).toHaveLength(2);
        for (let i = 0; i < frames.length; i++) {
            expect(dataEquals(result[i], frames[i])).toBe(true);
        }
    });
});



describe('applyPaletteMatchAcrossFrames - palette-based engine (external reference)', () => {
    it('matches applyPaletteMatchToFrames when given the same extracted palette', () => {
        const frames = [
            twoRegionImage(RED, GREEN),
            twoRegionImage([255, 120, 120, 255], [20, 120, 20, 255]),
            twoRegionImage([170, 40, 40, 255], [40, 160, 40, 255])
        ];
        const opts = { strength: 1, preserveShading: 0.5, paletteSize: 16 as const };
        const palette = extractReferencePalette(frames[0], opts);

        for (const mode of ['per_frame', 'global_sheet', 'reference_locked'] as const) {
            const viaIndex = applyPaletteMatchToFrames(frames, 0, { ...opts, paletteConsistency: mode });
            const viaPalette = applyPaletteMatchAcrossFrames(frames, palette, { ...opts, paletteConsistency: mode });
            for (let i = 0; i < frames.length; i++) {
                expect(dataEquals(viaPalette[i], viaIndex[i])).toBe(true);
            }
        }
    });

    it('accepts a raw LabColor[] reference palette and preserves dimensions / transparency', () => {
        // An "external" palette (e.g. from a loaded reference image), not tied to
        // any frame in the array.
        const palette: LabColor[] = extractReferencePalette(twoRegionImage(RED, GREEN), { paletteSize: 16 }).colors;
        expect(palette.length).toBe(2);

        const frames = [
            makeImage(4, 4, (i) => (i < 8 ? [255, 130, 130, 255] : TRANSPARENT)),
            twoRegionImage([150, 30, 30, 255], GREEN)
        ];
        const result = applyPaletteMatchAcrossFrames(frames, palette, {
            paletteConsistency: 'global_sheet',
            strength: 1,
            preserveShading: 0.5
        });

        expect(result).toHaveLength(2);
        for (const f of result) {
            expect(f.width).toBe(4);
            expect(f.height).toBe(4);
        }
        // Red half stays reddish; transparent half is untouched.
        const red = pixel(result[0], 0);
        expect(red[0]).toBeGreaterThan(red[1]);
        expect(Array.from(result[0].data.slice(8 * 4, 8 * 4 + 4))).toEqual([0, 0, 0, 0]);
    });

    it('respects targetIndices and returns copies for the rest', () => {
        const palette: LabColor[] = [{ l: 50, a: 60, b: 40 }];
        const frames = [twoRegionImage(RED, GREEN), twoRegionImage(RED, GREEN), twoRegionImage(RED, GREEN)];
        const result = applyPaletteMatchAcrossFrames(frames, palette, {
            paletteConsistency: 'global_sheet',
            targetIndices: [1],
            strength: 1
        });
        expect(result).toHaveLength(3);
        expect(dataEquals(result[0], frames[0])).toBe(true);
        expect(dataEquals(result[2], frames[2])).toBe(true);
    });

    it('returns unchanged copies for an empty palette', () => {
        const frames = [twoRegionImage(RED, GREEN), twoRegionImage(RED, GREEN)];
        const result = applyPaletteMatchAcrossFrames(frames, [], { paletteConsistency: 'global_sheet' });
        expect(result).toHaveLength(2);
        for (let i = 0; i < frames.length; i++) {
            expect(dataEquals(result[i], frames[i])).toBe(true);
        }
    });
});



describe('buildPaletteMatchPlan / applyPaletteMatchPlan - preview parity', () => {
    it('returns null for per_frame and for an empty palette', () => {
        const frames = [twoRegionImage(RED, GREEN), twoRegionImage(RED, GREEN)];
        const palette = extractReferencePalette(frames[0], { paletteSize: 16 });
        expect(buildPaletteMatchPlan(frames, palette, { paletteConsistency: 'per_frame' })).toBeNull();
        expect(buildPaletteMatchPlan(frames, [], { paletteConsistency: 'global_sheet' })).toBeNull();
    });

    it('a single frame via the plan matches that frame from the full across-frames apply', () => {
        const frames = [
            twoRegionImage(RED, GREEN),
            twoRegionImage([255, 120, 120, 255], [20, 120, 20, 255]),
            twoRegionImage([170, 40, 40, 255], [40, 160, 40, 255])
        ];
        const palette = extractReferencePalette(frames[0], { paletteSize: 16 });
        const opts = { strength: 0.8, preserveShading: 0.5, paletteSize: 16 as const };

        for (const mode of ['global_sheet', 'reference_locked'] as const) {
            const across = applyPaletteMatchAcrossFrames(frames, palette, { ...opts, paletteConsistency: mode });
            const plan = buildPaletteMatchPlan(frames, palette, { ...opts, paletteConsistency: mode });
            expect(plan).not.toBeNull();

            // Previewing any single frame with the plan == its full-apply result.
            for (let i = 0; i < frames.length; i++) {
                const single = applyPaletteMatchPlan(frames[i], plan!, opts);
                expect(dataEquals(single, across[i])).toBe(true);
            }
        }
    });
});
