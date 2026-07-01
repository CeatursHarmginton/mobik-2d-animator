import { SpriteSheetNormalizer } from '../../../src/core/normalize/SpriteSheetNormalizer';
import { FramePlacement, NormalizeOptions, RgbaImage } from '../../../src/core/normalize/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function blank(width: number, height: number): RgbaImage {
    return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

function fillRect(img: RgbaImage, x: number, y: number, w: number, h: number): void {
    for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
            const o = (yy * img.width + xx) * 4;
            img.data[o] = 220;
            img.data[o + 1] = 30;
            img.data[o + 2] = 30;
            img.data[o + 3] = 255;
        }
    }
}

function alphaAt(img: RgbaImage, x: number, y: number): number {
    return img.data[(y * img.width + x) * 4 + 3];
}

/**
 * Reference 120x120 with an opaque character bbox of {x:40,y:20,w:40,h:80},
 * so ref bbox height = 80 and ref bottomY = 100.
 */
function makeReference(): RgbaImage {
    const ref = blank(120, 120);
    fillRect(ref, 40, 20, 40, 80);
    return ref;
}

/**
 * Sheet 240x120 = two 120x120 cells (cols=2, rows=1):
 *   frame0 bbox 20x40 (local x50..69, y40..79)
 *   frame1 bbox 30x60 (local x45..74, y30..89  => sheet x165..194)
 * => median height 50, max height 60; median width 25, max width 30.
 */
function makeSheet(): RgbaImage {
    const sheet = blank(240, 120);
    fillRect(sheet, 50, 40, 20, 40);        // frame 0 (cell starts at x=0)
    fillRect(sheet, 120 + 45, 30, 30, 60);  // frame 1 (cell starts at x=120)
    return sheet;
}

/** Base options that make the math exact (no bbox padding, no smoothing). */
function baseOptions(overrides: Partial<NormalizeOptions> = {}): Partial<NormalizeOptions> & { columns: number; rows: number } {
    return {
        columns: 2,
        rows: 1,
        alphaThreshold: 10,
        bboxPadding: 0,
        safePadding: 10,
        smoothing: false,
        autoReduceScale: true,
        ...overrides
    };
}

// ---------------------------------------------------------------------------

describe('splitSheet', () => {
    it('splits into columns x rows cells of floor size', () => {
        const n = new SpriteSheetNormalizer(baseOptions());
        const { frames, frameWidth, frameHeight } = n.splitSheet(makeSheet());
        expect(frames).toHaveLength(2);
        expect(frameWidth).toBe(120);
        expect(frameHeight).toBe(120);
    });
});

describe('computeBBoxStats', () => {
    it('aggregates non-empty bboxes and counts empties', () => {
        const n = new SpriteSheetNormalizer(baseOptions());
        const { frames } = n.splitSheet(makeSheet());
        const bboxes = frames.map(f => n.detectAlphaBBox(f));
        const stats = n.computeBBoxStats(bboxes);
        expect(stats.medianBBoxHeight).toBe(50);
        expect(stats.maxBBoxHeight).toBe(60);
        expect(stats.medianBBoxWidth).toBe(25);
        expect(stats.maxBBoxWidth).toBe(30);
        expect(stats.emptyFrameCount).toBe(0);
        expect(stats.sampleCount).toBe(2);
    });
});

describe('computeGlobalScale', () => {
    it('match_reference_height = refH * ratio / medianH', () => {
        const n = new SpriteSheetNormalizer(baseOptions({ scaleMode: 'match_reference_height', scaleRatio: 1.0 }));
        const res = n.normalize(makeReference(), makeSheet());
        // 80 * 1.0 / 50 = 1.6 (no crop reduction needed at safePadding 10)
        expect(res.rawGlobalScale).toBeCloseTo(1.6, 5);
        expect(res.globalScale).toBeCloseTo(1.6, 5);
        expect(res.autoReduced).toBe(false);
    });

    it('fit_safe_area = (refHeight * targetHeightRatio) / maxH', () => {
        const n = new SpriteSheetNormalizer(baseOptions({
            scaleMode: 'fit_safe_area',
            targetHeightRatio: 0.85,
            autoReduceScale: false
        }));
        const res = n.normalize(makeReference(), makeSheet());
        // 120 * 0.85 / 60 = 1.7
        expect(res.rawGlobalScale).toBeCloseTo(1.7, 5);
    });

    it('manual_scale is taken verbatim', () => {
        const n = new SpriteSheetNormalizer(baseOptions({
            scaleMode: 'manual_scale',
            manualScale: 2.0,
            autoReduceScale: false
        }));
        const res = n.normalize(makeReference(), makeSheet());
        expect(res.rawGlobalScale).toBeCloseTo(2.0, 5);
        expect(res.globalScale).toBeCloseTo(2.0, 5);
    });

    it('falls back to scale 1 for an all-empty sheet', () => {
        const n = new SpriteSheetNormalizer(baseOptions({ scaleMode: 'match_reference_height' }));
        const res = n.normalize(makeReference(), blank(240, 120));
        expect(res.globalScale).toBe(1);
        expect(res.warnings.map(w => w.code)).toContain('all_frames_empty');
    });
});

describe('crop-safety auto reduction', () => {
    it('reduces the scale so the tallest frame fits the safe area', () => {
        // safePadding 30 => allowedH = 120 - 60 = 60. At scale 1.6 frame1 is
        // 60*1.6 = 96 tall (> 60), so scale must drop to 60/60... = 1.0.
        const n = new SpriteSheetNormalizer(baseOptions({
            scaleMode: 'match_reference_height',
            scaleRatio: 1.0,
            safePadding: 30,
            autoReduceScale: true
        }));
        const res = n.normalize(makeReference(), makeSheet());
        expect(res.rawGlobalScale).toBeCloseTo(1.6, 5);
        expect(res.globalScale).toBeCloseTo(1.0, 5);
        expect(res.autoReduced).toBe(true);
        expect(res.warnings.map(w => w.code)).toContain('scale_reduced');
    });

    it('does not reduce when autoReduceScale is disabled', () => {
        const n = new SpriteSheetNormalizer(baseOptions({
            scaleMode: 'match_reference_height',
            scaleRatio: 1.0,
            safePadding: 30,
            autoReduceScale: false
        }));
        const res = n.normalize(makeReference(), makeSheet());
        expect(res.globalScale).toBeCloseTo(1.6, 5);
        expect(res.autoReduced).toBe(false);
    });
});

describe('computePlacements (anchor math)', () => {
    const reference = {
        width: 120,
        height: 120,
        bbox: { x: 40, y: 20, w: 40, h: 80, empty: false },
        centerX: 60,
        centerY: 60,
        bottomY: 100
    };
    // bboxes as produced by makeSheet frames (local coords)
    const bboxes = [
        { x: 50, y: 40, w: 20, h: 40, empty: false },
        { x: 45, y: 30, w: 30, h: 60, empty: false }
    ];

    it('bottom-center grounds content to the reference bottom line', () => {
        const n = new SpriteSheetNormalizer(baseOptions({ anchorMode: 'bottom-center', safePadding: 10 }));
        const p = n.computePlacements(bboxes, 1.6, reference);
        // frame0: w=32,h=64 -> x=60-16=44, y=100-64=36
        expect(p[0]).toMatchObject({ x: 44, y: 36, scaledWidth: 32, scaledHeight: 64 });
        // frame1: w=48,h=96 -> x=60-24=36, y=100-96=4
        expect(p[1]).toMatchObject({ x: 36, y: 4, scaledWidth: 48, scaledHeight: 96 });
    });

    it('center places content in the canvas centre', () => {
        const n = new SpriteSheetNormalizer(baseOptions({ anchorMode: 'center' }));
        const p = n.computePlacements(bboxes, 1.6, reference);
        // frame1: y = 60 - 96/2 = 12
        expect(p[1]).toMatchObject({ x: 36, y: 12 });
    });

    it('upper-center pins content to safe_padding + top_offset', () => {
        const n = new SpriteSheetNormalizer(baseOptions({ anchorMode: 'upper-center', safePadding: 10, topOffset: 5 }));
        const p = n.computePlacements(bboxes, 1.6, reference);
        expect(p[0].y).toBe(15);
        expect(p[1].y).toBe(15);
    });
});

describe('smoothPlacements', () => {
    it('median-filters x/y to reject single-frame jitter', () => {
        const n = new SpriteSheetNormalizer(baseOptions({ smoothing: true, smoothingWindow: 3 }));
        const mk = (i: number, x: number, y: number): FramePlacement => ({
            index: i, x, y, scaledWidth: 10, scaledHeight: 10,
            bbox: { x: 0, y: 0, w: 10, h: 10, empty: false }, empty: false
        });
        // middle frame x is an outlier (50) between two 10/12 values
        const placements = [mk(0, 10, 5), mk(1, 50, 5), mk(2, 12, 5)];
        const out = n.smoothPlacements(placements);
        // median(10,50,12) = 12 -> the spike is removed
        expect(out[1].x).toBe(12);
        expect(out[1].y).toBe(5);
    });

    it('is a no-op when smoothing is disabled', () => {
        const n = new SpriteSheetNormalizer(baseOptions({ smoothing: false }));
        const placements: FramePlacement[] = [
            { index: 0, x: 1, y: 2, scaledWidth: 3, scaledHeight: 4, bbox: { x: 0, y: 0, w: 3, h: 4, empty: false }, empty: false }
        ];
        expect(n.smoothPlacements(placements)).toBe(placements);
    });
});

describe('combineFrames + normalize end-to-end', () => {
    it('produces a sheet of ref_w*cols x ref_h*rows with ref-sized frames', () => {
        const n = new SpriteSheetNormalizer(baseOptions({ scaleMode: 'match_reference_height', scaleRatio: 1.0 }));
        const res = n.normalize(makeReference(), makeSheet());

        expect(res.sheet.width).toBe(240);   // 120 * 2 columns
        expect(res.sheet.height).toBe(120);  // 120 * 1 row
        expect(res.frames).toHaveLength(2);
        for (const f of res.frames) {
            expect(f.width).toBe(120);
            expect(f.height).toBe(120);
        }
        // the normalized character should have opaque pixels near canvas centre
        expect(alphaAt(res.frames[1], 60, 50)).toBeGreaterThan(0);
    });

    it('handles an empty frame safely', () => {
        const sheet = blank(240, 120);
        fillRect(sheet, 50, 40, 20, 40); // only frame 0 has content
        const n = new SpriteSheetNormalizer(baseOptions({ scaleMode: 'match_reference_height' }));
        const res = n.normalize(makeReference(), sheet);

        expect(res.stats.emptyFrameCount).toBe(1);
        expect(res.placements[1].empty).toBe(true);
        // the empty frame's normalized output is fully transparent
        expect(res.frames[1].data.every(v => v === 0)).toBe(true);
        expect(res.warnings.map(w => w.code)).toContain('empty_frames');
    });
});

describe('metadata + validation', () => {
    it('exports the spec metadata schema', () => {
        const n = new SpriteSheetNormalizer(baseOptions({
            scaleMode: 'match_reference_height',
            scaleRatio: 1.0,
            anchorMode: 'bottom-center',
            targetHeightRatio: 0.85
        }));
        const res = n.normalize(makeReference(), makeSheet());
        const m = res.metadata;
        expect(m).toMatchObject({
            frame_width: 120,
            frame_height: 120,
            columns: 2,
            rows: 1,
            total_frames: 2,
            anchor_mode: 'bottom-center',
            scale_mode: 'match_reference_height',
            safe_padding: 10,
            target_height_ratio: 0.85,
            reference_bbox: { x: 40, y: 20, width: 40, height: 80 }
        });
        expect(m.global_scale).toBeCloseTo(1.6, 5);
        expect(m.bbox_stats.median_bbox_height).toBe(50);
        expect(m.bbox_stats.max_bbox_height).toBe(60);
        // round-trips through JSON
        expect(() => JSON.parse(SpriteSheetNormalizer.metadataToJson(m))).not.toThrow();
    });

    it('warns when the sheet is not grid-divisible', () => {
        const n = new SpriteSheetNormalizer(baseOptions({ columns: 3, rows: 1 }));
        const warnings = n.validate(blank(200, 120)); // 200 % 3 != 0
        expect(warnings.map(w => w.code)).toContain('width_not_divisible');
    });
});

describe('fromPreset', () => {
    it('builds options from a named preset with overrides', () => {
        const n = SpriteSheetNormalizer.fromPreset('standing', { columns: 4, rows: 2 });
        expect(n.options.columns).toBe(4);
        expect(n.options.rows).toBe(2);
        expect(n.options.anchorMode).toBe('bottom-center');
        expect(n.options.scaleMode).toBe('match_reference_height');
    });
});



// ---------------------------------------------------------------------------
// Debug overlay / before-after preview / debug metadata
// ---------------------------------------------------------------------------

/** Byte-equality helper for two RgbaImage buffers. */
function sheetDataEquals(a: RgbaImage, b: RgbaImage): boolean {
    if (a.width !== b.width || a.height !== b.height || a.data.length !== b.data.length) return false;
    for (let i = 0; i < a.data.length; i++) {
        if (a.data[i] !== b.data[i]) return false;
    }
    return true;
}

describe('debug outputs', () => {
    it('produces no debug output and identical sheet when all debug flags are off (default)', () => {
        const n = new SpriteSheetNormalizer(baseOptions({ scaleMode: 'match_reference_height', scaleRatio: 1.0 }));
        const res = n.normalize(makeReference(), makeSheet());

        expect(res.debug).toBeUndefined();
        expect(res.overlaySheet).toBeUndefined();
        expect(res.beforeSheet).toBeUndefined();
        expect(res.metadata.debug).toBeUndefined();
    });

    it('debugOverlay=true adds an overlay sheet + debug info without changing the primary sheet', () => {
        const opts = baseOptions({ scaleMode: 'match_reference_height', scaleRatio: 1.0 });
        const baseline = new SpriteSheetNormalizer(opts).normalize(makeReference(), makeSheet());
        const debugRun = new SpriteSheetNormalizer({ ...opts, debugOverlay: true }).normalize(makeReference(), makeSheet());

        // The primary output is unchanged by enabling the overlay.
        expect(sheetDataEquals(debugRun.sheet, baseline.sheet)).toBe(true);

        // Overlay sheet exists, matches the combined sheet size.
        expect(debugRun.overlaySheet).toBeDefined();
        expect(debugRun.overlaySheet!.width).toBe(240);
        expect(debugRun.overlaySheet!.height).toBe(120);

        // Structured debug info covers every frame.
        expect(debugRun.debug).toBeDefined();
        expect(debugRun.debug!.frames).toHaveLength(2);
        expect(debugRun.debug!.globalScale).toBeCloseTo(1.6, 5);
        expect(debugRun.debug!.frames[1].placement.width).toBeGreaterThan(0);

        // The overlay actually draws something (differs from the plain sheet).
        expect(sheetDataEquals(debugRun.overlaySheet!, debugRun.sheet)).toBe(false);
    });

    it('debugMetadata=true attaches a backward-compatible debug block with bbox/scale info', () => {
        const n = new SpriteSheetNormalizer(baseOptions({
            scaleMode: 'match_reference_height',
            scaleRatio: 1.0,
            debugMetadata: true
        }));
        const res = n.normalize(makeReference(), makeSheet());

        expect(res.metadata.debug).toBeDefined();
        const d = res.metadata.debug!;
        expect(d.auto_reduced).toBe(false);
        expect(d.raw_global_scale).toBeCloseTo(1.6, 4);
        expect(d.frames).toHaveLength(2);
        expect(typeof d.frames[0].clamped_x).toBe('boolean');
        expect(typeof d.frames[0].crop_risk).toBe('boolean');

        // Base schema still round-trips through JSON with the extra block.
        expect(() => JSON.parse(SpriteSheetNormalizer.metadataToJson(res.metadata))).not.toThrow();
    });

    it('reflects auto-reduced scale in the debug metadata and keeps the warning', () => {
        const n = new SpriteSheetNormalizer(baseOptions({
            scaleMode: 'match_reference_height',
            scaleRatio: 1.0,
            safePadding: 30,
            autoReduceScale: true,
            debugMetadata: true
        }));
        const res = n.normalize(makeReference(), makeSheet());

        expect(res.autoReduced).toBe(true);
        expect(res.metadata.debug!.auto_reduced).toBe(true);
        expect(res.metadata.debug!.raw_global_scale).toBeCloseTo(1.6, 4);
        expect(res.warnings.map(w => w.code)).toContain('scale_reduced');
    });

    it('includeBeforeAfterPreview=true returns a verbatim copy of the input sheet', () => {
        const sheet = makeSheet();
        const n = new SpriteSheetNormalizer(baseOptions({ includeBeforeAfterPreview: true }));
        const res = n.normalize(makeReference(), sheet);

        expect(res.beforeSheet).toBeDefined();
        expect(sheetDataEquals(res.beforeSheet!, sheet)).toBe(true);
        // It is a copy, not the same reference (mutating output must not touch input).
        expect(res.beforeSheet!.data).not.toBe(sheet.data);
    });

    it('handles a fully empty sheet with debugOverlay enabled without crashing', () => {
        const n = new SpriteSheetNormalizer(baseOptions({ debugOverlay: true, debugMetadata: true }));
        let res!: ReturnType<SpriteSheetNormalizer['normalize']>;
        expect(() => { res = n.normalize(makeReference(), blank(240, 120)); }).not.toThrow();

        expect(res.overlaySheet).toBeDefined();
        expect(res.debug!.frames).toHaveLength(2);
        expect(res.debug!.frames.every(f => f.empty)).toBe(true);
        expect(res.warnings.map(w => w.code)).toContain('all_frames_empty');
    });
});
