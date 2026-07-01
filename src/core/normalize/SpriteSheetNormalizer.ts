/**
 * SpriteSheetNormalizer - normalize every frame of a sprite sheet against a
 * single reference image so a set of separately-generated mascot animations
 * share one canvas size, one visual scale, one anchor and stable placement.
 * @module core/normalize/SpriteSheetNormalizer
 *
 * Design rule (critical): a SINGLE global scale factor is computed for the
 * whole sheet and applied to every frame. We never resize each frame to its own
 * bbox, because that makes the character pulse/breathe in size during playback.
 *
 * The class is DOM-free and reused by the UI, the CLI and the unit tests.
 */

import {
    BBox,
    BBoxStats,
    FrameDebugInfo,
    FramePlacement,
    NORMALIZE_PRESETS,
    NormalizeDebugInfo,
    NormalizeMetadata,
    NormalizeOptions,
    NormalizePresetName,
    NormalizeResult,
    NormalizeWarning,
    DEFAULT_NORMALIZE_OPTIONS,
    ReferenceInfo,
    RgbaImage
} from './types';
import {
    clamp,
    createTransparentImage,
    cropRgba,
    detectAlphaBBox,
    lanczosResize,
    median,
    pasteRgba
} from './imageOps';
import { renderDebugOverlaySheet } from './debugOverlay';

export class SpriteSheetNormalizer {
    readonly options: NormalizeOptions;

    constructor(options: Partial<NormalizeOptions> & { columns: number; rows: number }) {
        this.options = { ...DEFAULT_NORMALIZE_OPTIONS, ...options };
    }

    /** Build a normalizer from a recommended preset, with optional overrides. */
    static fromPreset(
        preset: NormalizePresetName,
        config: { columns: number; rows: number } & Partial<NormalizeOptions>
    ): SpriteSheetNormalizer {
        const presetOpts = NORMALIZE_PRESETS[preset];
        // Strip the human-readable label/description before merging.
        const { label: _label, description: _desc, ...presetValues } = presetOpts;
        return new SpriteSheetNormalizer({ ...presetValues, ...config });
    }

    // ========================================================================
    // 1. Alpha bbox detection
    // ========================================================================

    /**
     * Detect the (padded) alpha bounding box of the character in an image.
     * Uses the configured alpha threshold and internal bbox padding.
     */
    detectAlphaBBox(img: RgbaImage): BBox {
        return detectAlphaBBox(img, this.options.alphaThreshold, this.options.bboxPadding);
    }

    // ========================================================================
    // 2. Split sheet into frames
    // ========================================================================

    /**
     * Split a sprite sheet into `columns x rows` frames (row-major order).
     * Uses floor division for the cell size; any divisibility issue is surfaced
     * as a validation warning by `validate()` / `normalize()`, not here.
     */
    splitSheet(sheet: RgbaImage): { frames: RgbaImage[]; frameWidth: number; frameHeight: number } {
        const { columns, rows } = this.options;
        const frameWidth = Math.floor(sheet.width / columns);
        const frameHeight = Math.floor(sheet.height / rows);

        const frames: RgbaImage[] = [];
        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < columns; col++) {
                frames.push(cropRgba(sheet, {
                    x: col * frameWidth,
                    y: row * frameHeight,
                    w: frameWidth,
                    h: frameHeight
                }));
            }
        }
        return { frames, frameWidth, frameHeight };
    }

    // ========================================================================
    // 3. Bbox statistics
    // ========================================================================

    /** Aggregate stats over all non-empty bboxes (empty frames are excluded). */
    computeBBoxStats(bboxes: BBox[]): BBoxStats {
        const widths: number[] = [];
        const heights: number[] = [];
        const centerXs: number[] = [];
        const centerYs: number[] = [];
        const bottomYs: number[] = [];
        let emptyFrameCount = 0;

        for (const b of bboxes) {
            if (b.empty || b.w <= 0 || b.h <= 0) {
                emptyFrameCount++;
                continue;
            }
            widths.push(b.w);
            heights.push(b.h);
            centerXs.push(b.x + b.w / 2);
            centerYs.push(b.y + b.h / 2);
            bottomYs.push(b.y + b.h);
        }

        return {
            medianBBoxHeight: median(heights),
            maxBBoxHeight: heights.length ? Math.max(...heights) : 0,
            medianBBoxWidth: median(widths),
            maxBBoxWidth: widths.length ? Math.max(...widths) : 0,
            medianCenterX: median(centerXs),
            medianCenterY: median(centerYs),
            medianBottomY: median(bottomYs),
            emptyFrameCount,
            sampleCount: widths.length
        };
    }

    // ========================================================================
    // 4. Global scale
    // ========================================================================

    /**
     * Compute the single global scale factor for the whole sheet.
     *
     *   match_reference_height : ref_bbox_height * scaleRatio / median_bbox_height
     *   fit_safe_area          : (ref_height * targetHeightRatio) / max_bbox_height
     *   manual_scale           : manualScale (verbatim)
     *
     * Returns a finite, positive scale; degenerate inputs (e.g. an all-empty
     * sheet) fall back to 1.0 and a warning is recorded by `normalize()`.
     */
    computeGlobalScale(stats: BBoxStats, reference: ReferenceInfo): number {
        const o = this.options;
        let scale: number;

        switch (o.scaleMode) {
            case 'match_reference_height': {
                const denom = stats.medianBBoxHeight;
                scale = denom > 0 ? (reference.bbox.h * o.scaleRatio) / denom : 1;
                break;
            }
            case 'fit_safe_area': {
                const safeAreaHeight = reference.height * o.targetHeightRatio;
                const denom = stats.maxBBoxHeight;
                scale = denom > 0 ? safeAreaHeight / denom : 1;
                break;
            }
            case 'manual_scale':
                scale = o.manualScale;
                break;
            default:
                scale = 1;
        }

        if (!Number.isFinite(scale) || scale <= 0) scale = 1;
        return scale;
    }

    /**
     * Crop-safety: shrink the global scale (only ever down, never up) until no
     * frame's scaled bbox can exceed the canvas minus safe padding. We prefer
     * keeping the whole character on-canvas over keeping a larger scale.
     *
     * Returns the (possibly reduced) scale and whether a reduction happened.
     */
    applyCropSafety(
        scale: number,
        bboxes: BBox[],
        reference: ReferenceInfo
    ): { scale: number; autoReduced: boolean } {
        if (!this.options.autoReduceScale) return { scale, autoReduced: false };

        const allowedW = reference.width - 2 * this.options.safePadding;
        const allowedH = reference.height - 2 * this.options.safePadding;
        // If padding leaves no room, we cannot reduce sensibly; leave as-is.
        if (allowedW <= 0 || allowedH <= 0) return { scale, autoReduced: false };

        let factor = 1;
        for (const b of bboxes) {
            if (b.empty || b.w <= 0 || b.h <= 0) continue;
            const sw = b.w * scale;
            const sh = b.h * scale;
            if (sw > allowedW) factor = Math.min(factor, allowedW / sw);
            if (sh > allowedH) factor = Math.min(factor, allowedH / sh);
        }

        if (factor < 1) {
            return { scale: scale * factor, autoReduced: true };
        }
        return { scale, autoReduced: false };
    }

    // ========================================================================
    // 5. Placement (anchor math) + temporal smoothing
    // ========================================================================

    /**
     * Compute the raw (un-smoothed) placement of every frame on the output
     * canvas. Because each frame is cropped to its own bbox, the character's
     * absolute position in the original cell is removed; we then re-anchor the
     * resized content on the reference-sized canvas:
     *
     *   x (all modes)   : horizontally centred -> x = canvas_center_x - w/2
     *   bottom-center y : feet locked to the reference bottom line
     *                     y = ground_y - h
     *   center y        : y = canvas_center_y - h/2
     *   upper-center y  : y = safe_padding + top_offset
     *
     * Centring on canvas constants (rather than each frame's raw bbox centre)
     * is what makes placement stable from frame to frame.
     */
    computePlacements(bboxes: BBox[], scale: number, reference: ReferenceInfo): FramePlacement[] {
        const o = this.options;
        const canvasW = reference.width;
        const canvasH = reference.height;
        const centerX = canvasW / 2;
        const centerY = canvasH / 2;

        // For bottom-center we ground the character on the reference's feet
        // line, clamped so the ground always sits inside the safe area.
        const groundY = clamp(reference.bottomY, o.safePadding, canvasH - o.safePadding);

        return bboxes.map((bbox, index) => {
            if (bbox.empty || bbox.w <= 0 || bbox.h <= 0) {
                return { index, x: 0, y: 0, scaledWidth: 0, scaledHeight: 0, bbox, empty: true };
            }

            const scaledWidth = Math.max(1, Math.round(bbox.w * scale));
            const scaledHeight = Math.max(1, Math.round(bbox.h * scale));

            let x = centerX - scaledWidth / 2;
            let y: number;

            switch (o.anchorMode) {
                case 'center':
                    y = centerY - scaledHeight / 2;
                    break;
                case 'upper-center':
                    y = o.safePadding + o.topOffset;
                    break;
                case 'bottom-center':
                default:
                    y = groundY - scaledHeight;
                    break;
            }

            // Final anti-crop clamp: keep the whole content inside the canvas.
            x = clamp(Math.round(x), 0, Math.max(0, canvasW - scaledWidth));
            y = clamp(Math.round(y), 0, Math.max(0, canvasH - scaledHeight));

            return { index, x, y, scaledWidth, scaledHeight, bbox, empty: false };
        });
    }

    /**
     * Temporal anti-jitter: even with a fixed global scale, the detected bbox
     * size wobbles by a pixel or two as anti-aliased edges cross the alpha
     * threshold, which nudges the centred paste position frame to frame. We
     * remove that with a centred **median** filter over the x/y placement
     * sequences (median is robust to the odd outlier frame). Empty frames keep
     * their zero placement and are skipped.
     */
    smoothPlacements(placements: FramePlacement[]): FramePlacement[] {
        const win = this.options.smoothingWindow;
        if (!this.options.smoothing || win <= 1) return placements;

        const half = Math.floor(win / 2);
        const xs = placements.map(p => p.x);
        const ys = placements.map(p => p.y);

        return placements.map((p, i) => {
            if (p.empty) return p;
            const winX: number[] = [];
            const winY: number[] = [];
            for (let k = i - half; k <= i + half; k++) {
                if (k < 0 || k >= placements.length) continue;
                if (placements[k].empty) continue; // don't average in empty frames
                winX.push(xs[k]);
                winY.push(ys[k]);
            }
            return {
                ...p,
                x: Math.round(median(winX)),
                y: Math.round(median(winY))
            };
        });
    }

    // ========================================================================
    // 6. Per-frame normalization
    // ========================================================================

    /**
     * Normalize one frame: crop to its bbox, resize by the shared global scale
     * (Lanczos), then paste onto a transparent reference-sized canvas at the
     * pre-computed placement. Returns a brand-new reference-sized RgbaImage.
     */
    normalizeFrame(frame: RgbaImage, placement: FramePlacement, reference: ReferenceInfo): RgbaImage {
        const canvas = createTransparentImage(reference.width, reference.height);
        if (placement.empty) return canvas; // fully transparent output for empty frames

        const cropped = cropRgba(frame, placement.bbox);
        const resized = lanczosResize(cropped, placement.scaledWidth, placement.scaledHeight);
        pasteRgba(canvas, resized, placement.x, placement.y);
        return canvas;
    }

    // ========================================================================
    // 7. Recombine frames into a sheet
    // ========================================================================

    /**
     * Recombine normalized frames into a single sheet of the same grid.
     * Output sheet size = reference.width*columns x reference.height*rows.
     */
    combineFrames(frames: RgbaImage[], reference: ReferenceInfo): RgbaImage {
        const { columns, rows } = this.options;
        const sheet = createTransparentImage(reference.width * columns, reference.height * rows);

        for (let i = 0; i < frames.length; i++) {
            const col = i % columns;
            const row = Math.floor(i / columns);
            pasteRgba(sheet, frames[i], col * reference.width, row * reference.height);
        }
        return sheet;
    }

    // ========================================================================
    // 8. Metadata
    // ========================================================================

    /** Build the metadata object (snake_case schema per the feature spec). */
    exportMetadata(
        reference: ReferenceInfo,
        stats: BBoxStats,
        globalScale: number,
        frameCount: number
    ): NormalizeMetadata {
        const o = this.options;
        return {
            frame_width: reference.width,
            frame_height: reference.height,
            columns: o.columns,
            rows: o.rows,
            total_frames: frameCount,
            anchor_mode: o.anchorMode,
            scale_mode: o.scaleMode,
            global_scale: round(globalScale, 6),
            reference_bbox: {
                x: reference.bbox.x,
                y: reference.bbox.y,
                width: reference.bbox.w,
                height: reference.bbox.h
            },
            bbox_stats: {
                median_bbox_height: round(stats.medianBBoxHeight, 3),
                max_bbox_height: stats.maxBBoxHeight,
                median_bbox_width: round(stats.medianBBoxWidth, 3),
                max_bbox_width: stats.maxBBoxWidth,
                median_center_x: round(stats.medianCenterX, 3),
                median_center_y: round(stats.medianCenterY, 3),
                median_bottom_y: round(stats.medianBottomY, 3),
                empty_frame_count: stats.emptyFrameCount
            },
            safe_padding: o.safePadding,
            target_height_ratio: o.targetHeightRatio
        };
    }

    /** Serialize metadata to a pretty JSON string. */
    static metadataToJson(meta: NormalizeMetadata): string {
        return JSON.stringify(meta, null, 2);
    }

    // ========================================================================
    // 9. Debug diagnostics (only computed when a debug flag is set)
    // ========================================================================

    /**
     * Build structured, DOM-free diagnostics for the sheet. This is intentionally
     * a *separate* O(frames) pass so the normal hot path is untouched: it is only
     * ever called from `normalize()` when `debugOverlay`/`debugMetadata` is on.
     *
     * `clampedX/clampedY` reflect whether the ideal anchored position fell
     * outside the canvas (so the anti-crop clamp had to move it); `cropRisk` is
     * true when the scaled content is larger than the safe area.
     */
    buildDebugInfo(
        placements: FramePlacement[],
        globalScale: number,
        rawGlobalScale: number,
        autoReduced: boolean,
        reference: ReferenceInfo
    ): NormalizeDebugInfo {
        const o = this.options;
        const canvasW = reference.width;
        const canvasH = reference.height;
        const centerX = canvasW / 2;
        const centerY = canvasH / 2;
        const groundY = clamp(reference.bottomY, o.safePadding, canvasH - o.safePadding);
        const allowedW = canvasW - 2 * o.safePadding;
        const allowedH = canvasH - 2 * o.safePadding;

        const frames: FrameDebugInfo[] = placements.map((p) => {
            if (p.empty || p.scaledWidth <= 0 || p.scaledHeight <= 0) {
                return {
                    index: p.index,
                    empty: true,
                    bbox: { x: p.bbox.x, y: p.bbox.y, width: p.bbox.w, height: p.bbox.h },
                    placement: { x: 0, y: 0, width: 0, height: 0 },
                    anchorPoint: { x: 0, y: 0 },
                    clampedX: false,
                    clampedY: false,
                    cropRisk: false
                };
            }

            // Re-derive the *ideal* (un-clamped) anchored position to detect clamping.
            const unclampedX = Math.round(centerX - p.scaledWidth / 2);
            let unclampedY: number;
            switch (o.anchorMode) {
                case 'center':
                    unclampedY = Math.round(centerY - p.scaledHeight / 2);
                    break;
                case 'upper-center':
                    unclampedY = Math.round(o.safePadding + o.topOffset);
                    break;
                case 'bottom-center':
                default:
                    unclampedY = Math.round(groundY - p.scaledHeight);
                    break;
            }
            const clampedFinalX = clamp(unclampedX, 0, Math.max(0, canvasW - p.scaledWidth));
            const clampedFinalY = clamp(unclampedY, 0, Math.max(0, canvasH - p.scaledHeight));

            // Anchor point uses the *actual* (post-smoothing) placement.
            let anchorX = p.x + p.scaledWidth / 2;
            let anchorY: number;
            switch (o.anchorMode) {
                case 'center':
                    anchorY = p.y + p.scaledHeight / 2;
                    break;
                case 'upper-center':
                    anchorY = p.y;
                    break;
                case 'bottom-center':
                default:
                    anchorY = p.y + p.scaledHeight;
                    break;
            }

            return {
                index: p.index,
                empty: false,
                bbox: { x: p.bbox.x, y: p.bbox.y, width: p.bbox.w, height: p.bbox.h },
                placement: { x: p.x, y: p.y, width: p.scaledWidth, height: p.scaledHeight },
                anchorPoint: { x: anchorX, y: anchorY },
                clampedX: clampedFinalX !== unclampedX,
                clampedY: clampedFinalY !== unclampedY,
                cropRisk: p.scaledWidth > allowedW || p.scaledHeight > allowedH
            };
        });

        return {
            globalScale,
            rawGlobalScale,
            autoReduced,
            safePadding: o.safePadding,
            canvasCenter: { x: centerX, y: centerY },
            referenceBaselineY: groundY,
            referenceBBox: {
                x: reference.bbox.x,
                y: reference.bbox.y,
                width: reference.bbox.w,
                height: reference.bbox.h,
                empty: reference.bbox.empty
            },
            frames
        };
    }

    // ========================================================================
    // Validation
    // ========================================================================

    /**
     * Validate the grid against a sheet's dimensions, returning warnings (not
     * errors) so the caller can decide whether to proceed.
     */
    validate(sheet: RgbaImage): NormalizeWarning[] {
        const warnings: NormalizeWarning[] = [];
        const { columns, rows } = this.options;

        if (columns <= 0 || rows <= 0) {
            warnings.push({ code: 'invalid_grid', message: 'Columns and rows must be positive integers.' });
            return warnings;
        }
        if (sheet.width % columns !== 0) {
            warnings.push({
                code: 'width_not_divisible',
                message: `Sheet width ${sheet.width} is not divisible by ${columns} columns (frames may be misaligned).`
            });
        }
        if (sheet.height % rows !== 0) {
            warnings.push({
                code: 'height_not_divisible',
                message: `Sheet height ${sheet.height} is not divisible by ${rows} rows (frames may be misaligned).`
            });
        }
        return warnings;
    }

    // ========================================================================
    // Orchestrator
    // ========================================================================

    /**
     * Run the full pipeline:
     *   reference bbox -> split -> per-frame bbox -> stats -> global scale
     *   -> crop-safety -> placements (+smoothing) -> per-frame normalize
     *   -> combine -> metadata.
     */
    normalize(reference: RgbaImage, sheet: RgbaImage): NormalizeResult {
        const o = this.options;
        const warnings: NormalizeWarning[] = [...this.validate(sheet)];

        // --- Reference -----------------------------------------------------
        const refBBox = this.detectAlphaBBox(reference);
        if (refBBox.empty) {
            warnings.push({
                code: 'reference_empty',
                message: 'No transparent alpha detected in the reference image; bbox falls back to the full image. Use a transparent PNG for best results.'
            });
        }
        const effectiveRefBBox: BBox = refBBox.empty
            ? { x: 0, y: 0, w: reference.width, h: reference.height, empty: false }
            : refBBox;

        const referenceInfo: ReferenceInfo = {
            width: reference.width,
            height: reference.height,
            bbox: effectiveRefBBox,
            centerX: effectiveRefBBox.x + effectiveRefBBox.w / 2,
            centerY: effectiveRefBBox.y + effectiveRefBBox.h / 2,
            bottomY: effectiveRefBBox.y + effectiveRefBBox.h
        };

        // --- Split + per-frame bbox ---------------------------------------
        const { frames, frameWidth, frameHeight } = this.splitSheet(sheet);
        const bboxes = frames.map(f => this.detectAlphaBBox(f));

        // --- Stats ---------------------------------------------------------
        const stats = this.computeBBoxStats(bboxes);
        if (stats.sampleCount === 0) {
            warnings.push({ code: 'all_frames_empty', message: 'All frames are empty (no opaque pixels detected).' });
        } else if (stats.emptyFrameCount > 0) {
            warnings.push({
                code: 'empty_frames',
                message: `${stats.emptyFrameCount} of ${frames.length} frames are empty and were skipped in statistics.`
            });
        }

        // Detect a likely missing/garbage alpha channel: if essentially every
        // frame fills its whole cell, the sheet probably has no transparency.
        const opaqueFrames = bboxes.filter(
            b => !b.empty && b.w >= frameWidth - 2 && b.h >= frameHeight - 2
        ).length;
        if (stats.sampleCount > 0 && opaqueFrames === stats.sampleCount) {
            warnings.push({
                code: 'no_transparency',
                message: 'Frames appear to have no transparent margin; alpha bbox may be unreliable. Provide transparent PNG sprites.'
            });
        }

        // --- Global scale + crop safety -----------------------------------
        const rawGlobalScale = this.computeGlobalScale(stats, referenceInfo);
        const { scale: globalScale, autoReduced } = this.applyCropSafety(rawGlobalScale, bboxes, referenceInfo);
        if (autoReduced) {
            warnings.push({
                code: 'scale_reduced',
                message: `Global scale auto-reduced from ${round(rawGlobalScale, 4)} to ${round(globalScale, 4)} to avoid cropping.`
            });
        }

        // --- Placements (+ smoothing) -------------------------------------
        let placements = this.computePlacements(bboxes, globalScale, referenceInfo);
        placements = this.smoothPlacements(placements);

        // --- Per-frame normalize + combine --------------------------------
        const normalizedFrames = frames.map((f, i) => this.normalizeFrame(f, placements[i], referenceInfo));
        const combined = this.combineFrames(normalizedFrames, referenceInfo);

        // --- Metadata ------------------------------------------------------
        const metadata = this.exportMetadata(referenceInfo, stats, globalScale, frames.length);

        // --- Optional diagnostics (only when a debug flag is enabled) ------
        const result: NormalizeResult = {
            sheet: combined,
            frames: normalizedFrames,
            placements,
            globalScale,
            rawGlobalScale,
            autoReduced,
            reference: referenceInfo,
            stats,
            metadata,
            warnings,
            frameWidth,
            frameHeight
        };

        if (o.debugOverlay || o.debugMetadata) {
            const debug = this.buildDebugInfo(placements, globalScale, rawGlobalScale, autoReduced, referenceInfo);
            result.debug = debug;

            if (o.debugMetadata) {
                metadata.debug = {
                    raw_global_scale: round(rawGlobalScale, 6),
                    auto_reduced: autoReduced,
                    canvas_center: debug.canvasCenter,
                    reference_baseline_y: debug.referenceBaselineY,
                    frames: debug.frames.map(f => ({
                        index: f.index,
                        empty: f.empty,
                        clamped_x: f.clampedX,
                        clamped_y: f.clampedY,
                        crop_risk: f.cropRisk
                    }))
                };
            }

            if (o.debugOverlay) {
                result.overlaySheet = renderDebugOverlaySheet(combined, debug, {
                    columns: o.columns,
                    rows: o.rows,
                    frameWidth: referenceInfo.width,
                    frameHeight: referenceInfo.height
                });
            }
        }

        if (o.includeBeforeAfterPreview) {
            // A verbatim copy of the input sheet (the "before" of before/after).
            result.beforeSheet = { width: sheet.width, height: sheet.height, data: new Uint8ClampedArray(sheet.data) };
        }

        return result;
    }
}

/** Round to a fixed number of decimals (keeps metadata JSON tidy). */
function round(value: number, decimals: number): number {
    const f = Math.pow(10, decimals);
    return Math.round(value * f) / f;
}
