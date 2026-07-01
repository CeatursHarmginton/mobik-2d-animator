/**
 * Sprite Sheet Normalize by Reference - Type definitions
 * @module core/normalize/types
 *
 * This whole module is intentionally **DOM-independent**: it operates on plain
 * `RgbaImage` buffers ({ width, height, data: Uint8ClampedArray }) so the exact
 * same code runs in the Electron renderer (via canvas <-> RGBA adapters), in a
 * pure-Node CLI (via a PNG codec) and under Jest's `node` test environment.
 */

import type { Rect } from '../models/types';

// ============================================================================
// Pixel container
// ============================================================================

/**
 * A raw RGBA raster, row-major, 4 bytes per pixel (R,G,B,A).
 * Structurally compatible with the browser `ImageData` object, so an
 * `ImageData` can be passed anywhere an `RgbaImage` is expected.
 */
export interface RgbaImage {
    width: number;
    height: number;
    /** Length must equal width * height * 4. */
    data: Uint8ClampedArray;
}

// ============================================================================
// Bounding box
// ============================================================================

/**
 * Alpha bounding box of the character inside a frame / reference.
 * Coordinates are local to the image it was detected in.
 * `empty` is true when no opaque pixels were found (fully transparent frame).
 */
export interface BBox extends Rect {
    empty: boolean;
}

// ============================================================================
// Options
// ============================================================================

export type AnchorMode = 'bottom-center' | 'center' | 'upper-center';

export type ScaleMode = 'match_reference_height' | 'fit_safe_area' | 'manual_scale';

export interface NormalizeOptions {
    /** Grid columns (frames per row). */
    columns: number;
    /** Grid rows. */
    rows: number;

    anchorMode: AnchorMode;
    scaleMode: ScaleMode;

    /**
     * Multiplier used by `match_reference_height`:
     *   global_scale = ref_bbox_height * scaleRatio / median_bbox_height
     * 1.0 means "make the median character exactly as tall as the reference".
     */
    scaleRatio: number;

    /**
     * Used by `fit_safe_area`:
     *   safe_area_height = ref_height * targetHeightRatio
     *   global_scale     = safe_area_height / max_bbox_height
     * 0.85 means "the tallest frame fills 85% of the canvas height".
     */
    targetHeightRatio: number;

    /** Used by `manual_scale`: the global scale is taken verbatim. */
    manualScale: number;

    /** Transparent margin (px) kept inside the canvas edges. */
    safePadding: number;

    /** A pixel counts as "character" when its alpha is strictly greater than this. */
    alphaThreshold: number;

    /**
     * Extra pixels added around each detected bbox before cropping, so thin
     * line-art / hair / anti-aliased edges are never clipped.
     */
    bboxPadding: number;

    /** Enable temporal (cross-frame) placement smoothing to kill jitter. */
    smoothing: boolean;

    /** Odd window size for the median placement smoother (>=1, 1 disables). */
    smoothingWindow: number;

    /** Automatically reduce the global scale so no frame is ever cropped. */
    autoReduceScale: boolean;

    /** Additional top offset (px) for the `upper-center` anchor. */
    topOffset: number;

    // --- Debugging / diagnostics (all default OFF; never change output) ---

    /**
     * Render an extra `overlaySheet` (a copy of the normalized sheet annotated
     * with per-frame bbox / placement / anchor / safe-area / baseline / index /
     * scale / clamp+crop-risk markers). Purely diagnostic; the primary `sheet`
     * output is unaffected. Off by default.
     */
    debugOverlay: boolean;

    /**
     * Include a `beforeSheet` (a verbatim copy of the input sheet) in the result
     * so callers can show/export a before/after comparison. Off by default.
     */
    includeBeforeAfterPreview: boolean;

    /**
     * Attach an optional `debug` block to both `NormalizeResult` and the
     * metadata JSON (per-frame clamp/crop-risk flags, canvas center, baseline,
     * raw vs. final scale). The base metadata schema is unchanged when off.
     */
    debugMetadata: boolean;
}

/** Defaults for everything except the required grid (columns / rows). */
export const DEFAULT_NORMALIZE_OPTIONS: Omit<NormalizeOptions, 'columns' | 'rows'> = {
    anchorMode: 'bottom-center',
    scaleMode: 'match_reference_height',
    scaleRatio: 1.0,
    targetHeightRatio: 0.85,
    manualScale: 1.0,
    safePadding: 40,
    alphaThreshold: 10,
    bboxPadding: 2,
    smoothing: true,
    smoothingWindow: 3,
    autoReduceScale: true,
    topOffset: 0,
    debugOverlay: false,
    includeBeforeAfterPreview: false,
    debugMetadata: false
};

// ============================================================================
// Presets (recommended mascot configurations)
// ============================================================================

export type NormalizePresetName = 'standing' | 'floating' | 'jump' | 'kaboo';

/**
 * Recommended presets from the feature spec. Each is a partial override merged
 * on top of DEFAULT_NORMALIZE_OPTIONS (+ the caller's columns/rows).
 */
export const NORMALIZE_PRESETS: Record<NormalizePresetName, Partial<NormalizeOptions> & { label: string; description: string }> = {
    standing: {
        label: 'Standing mascot',
        description: 'idle / talk / thinking / standing',
        anchorMode: 'bottom-center',
        scaleMode: 'match_reference_height',
        scaleRatio: 1.0,
        smoothing: true
    },
    floating: {
        label: 'Floating / drag',
        description: 'drag / lifted / floating / kaboo',
        anchorMode: 'center',
        scaleMode: 'fit_safe_area',
        targetHeightRatio: 0.85,
        smoothing: true
    },
    jump: {
        label: 'Jump / notification',
        description: 'jump / notification (extra top padding)',
        anchorMode: 'bottom-center',
        scaleMode: 'fit_safe_area',
        targetHeightRatio: 0.82,
        topOffset: 24,
        smoothing: true
    },
    kaboo: {
        label: 'Kaboo / appear from below',
        description: 'appear from below',
        anchorMode: 'center',
        scaleMode: 'fit_safe_area',
        targetHeightRatio: 0.82,
        smoothing: true
    }
};

// ============================================================================
// Statistics & reference info
// ============================================================================

/** Aggregated bbox statistics over all non-empty frames of the sheet. */
export interface BBoxStats {
    medianBBoxHeight: number;
    maxBBoxHeight: number;
    medianBBoxWidth: number;
    maxBBoxWidth: number;
    medianCenterX: number;
    medianCenterY: number;
    medianBottomY: number;
    /** Number of frames that contained no opaque pixels. */
    emptyFrameCount: number;
    /** Number of non-empty frames the stats were computed from. */
    sampleCount: number;
}

/** Everything we need to know about the reference image. */
export interface ReferenceInfo {
    /** Reference canvas size = the size every normalized frame will have. */
    width: number;
    height: number;
    /** Character bounding box inside the reference. */
    bbox: BBox;
    centerX: number;
    centerY: number;
    /** Y of the reference character's feet (bbox bottom), in reference space. */
    bottomY: number;
}

// ============================================================================
// Placement & result
// ============================================================================

/**
 * The computed placement of a single normalized frame: where (top-left x/y)
 * the resized character is pasted on the transparent reference-sized canvas.
 */
export interface FramePlacement {
    index: number;
    /** Top-left paste position on the output canvas (integer px). */
    x: number;
    y: number;
    /** Size of the resized character content (integer px). */
    scaledWidth: number;
    scaledHeight: number;
    /** The (padded) source bbox this frame was cropped from. */
    bbox: BBox;
    empty: boolean;
}

export interface NormalizeWarning {
    code: string;
    message: string;
}

/** Metadata JSON schema (snake_case as required by the feature spec). */
export interface NormalizeMetadata {
    frame_width: number;
    frame_height: number;
    columns: number;
    rows: number;
    total_frames: number;
    anchor_mode: AnchorMode;
    scale_mode: ScaleMode;
    global_scale: number;
    reference_bbox: { x: number; y: number; width: number; height: number };
    bbox_stats: {
        median_bbox_height: number;
        max_bbox_height: number;
        median_bbox_width: number;
        max_bbox_width: number;
        median_center_x: number;
        median_center_y: number;
        median_bottom_y: number;
        empty_frame_count: number;
    };
    safe_padding: number;
    target_height_ratio: number;

    /**
     * Optional diagnostics block, present ONLY when `debugMetadata` is enabled.
     * Absent by default so the base schema is byte-for-byte unchanged.
     */
    debug?: NormalizeMetadataDebug;
}

/** Diagnostic metadata (snake_case), only attached when `debugMetadata` is on. */
export interface NormalizeMetadataDebug {
    raw_global_scale: number;
    auto_reduced: boolean;
    canvas_center: { x: number; y: number };
    reference_baseline_y: number;
    frames: Array<{
        index: number;
        empty: boolean;
        clamped_x: boolean;
        clamped_y: boolean;
        crop_risk: boolean;
    }>;
}

// ============================================================================
// Debug info (structured, DOM-free; the overlay sheet is rendered from this)
// ============================================================================

/** Per-frame diagnostic geometry used to render the debug overlay. */
export interface FrameDebugInfo {
    index: number;
    empty: boolean;
    /** Padded source bbox (local to the source cell). */
    bbox: { x: number; y: number; width: number; height: number };
    /** Final paste rect on the output canvas. */
    placement: { x: number; y: number; width: number; height: number };
    /** Anchor point on the output canvas (feet / center / top per anchorMode). */
    anchorPoint: { x: number; y: number };
    /** True if the anti-crop clamp moved the frame horizontally / vertically. */
    clampedX: boolean;
    clampedY: boolean;
    /** True if the scaled content exceeds the safe area (was at risk of cropping). */
    cropRisk: boolean;
}

/** Sheet-wide diagnostics, sufficient to render the overlay without any DOM. */
export interface NormalizeDebugInfo {
    globalScale: number;
    rawGlobalScale: number;
    autoReduced: boolean;
    safePadding: number;
    canvasCenter: { x: number; y: number };
    /** Reference baseline (clamped feet line) in canvas space. */
    referenceBaselineY: number;
    referenceBBox: { x: number; y: number; width: number; height: number; empty: boolean };
    frames: FrameDebugInfo[];
}

/** Full result of a normalize run. */
export interface NormalizeResult {
    /** The recombined normalized sprite sheet (ref_w*cols x ref_h*rows). */
    sheet: RgbaImage;
    /** Individual normalized frames, each exactly reference-sized. */
    frames: RgbaImage[];
    placements: FramePlacement[];
    /** Final global scale actually applied to every frame. */
    globalScale: number;
    /** Global scale before crop-safety reduction (for diagnostics). */
    rawGlobalScale: number;
    /** True if crop-safety reduced the scale. */
    autoReduced: boolean;
    reference: ReferenceInfo;
    stats: BBoxStats;
    metadata: NormalizeMetadata;
    warnings: NormalizeWarning[];
    /** Source cell size the sheet was split into. */
    frameWidth: number;
    frameHeight: number;

    // --- Optional diagnostics (populated only when the matching flag is on) ---

    /** Structured diagnostics; present when `debugOverlay` or `debugMetadata`. */
    debug?: NormalizeDebugInfo;
    /**
     * Copy of the normalized sheet with per-frame debug annotations drawn on
     * top. Present only when `debugOverlay` is enabled.
     */
    overlaySheet?: RgbaImage;
    /**
     * Verbatim copy of the input sheet (the "before" of a before/after
     * comparison). Present only when `includeBeforeAfterPreview` is enabled.
     */
    beforeSheet?: RgbaImage;
}
