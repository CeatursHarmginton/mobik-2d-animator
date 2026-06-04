/**
 * Runtime Types - Standalone types for animation playback
 * These types are designed to work with exported meta.json files
 * @module core/runtime/types
 */

/**
 * Runtime meta.json format
 * This is the structure produced by MetaExporter.exportRuntime()
 */
export interface RuntimeMeta {
    version: string;
    /** Original sprite sheet filename for import */
    spriteSheet?: string;
    animation: {
        name: string;
        fps: number;
        loop: boolean;
        frames: RuntimeFrame[];
        /** Target size for pivot alignment - all animations with same targetSize will align correctly */
        targetSize?: { w: number; h: number };

        // --- Compact format fields (v1.1) ---
        /** Grid layout for auto-slicing. When present, frames can be auto-generated */
        grid?: { columns: number; rows: number; frameCount?: number };
        /** Shared pivot for all frames (used when grid is present and frames are empty) */
        pivot?: [number, number];
        /** Shared offset for all frames */
        offset?: [number, number];
        /** Shared scale for all frames */
        scale?: [number, number];
    };
    /** Color adjustments applied during export */
    colorAdjustments?: {
        brightness: number;
        contrast: number;
        saturation: number;
        hue: number;
        invert: number;
    };
}

/**
 * Runtime frame data - compact format for file size
 */
export interface RuntimeFrame {
    /** Source file or sprite sheet atlas key */
    src: string;
    /** Source rectangle [x, y, width, height] */
    rect: [number, number, number, number];
    /** Pivot point [x, y] normalized 0-1 */
    pivot: [number, number];
    /** Offset [x, y] in pixels */
    offset: [number, number];
    /** Scale [x, y] factors - defaults to [1, 1] */
    scale?: [number, number];
    /** Duration multiplier (1.0 = default) */
    dur: number;
}

/**
 * Parsed animation data - expanded for easier use
 */
export interface AnimationData {
    name: string;
    fps: number;
    loop: boolean;
    totalDuration: number;
    frames: ParsedFrame[];
}

/**
 * Parsed frame data - expanded from compact format
 */
export interface ParsedFrame {
    index: number;
    sourceFile: string;
    sourceRect: { x: number; y: number; w: number; h: number };
    pivot: { x: number; y: number };
    offset: { x: number; y: number };
    scale: { x: number; y: number };
    duration: number;
    /** Frame start time in seconds */
    startTime: number;
    /** Frame end time in seconds */
    endTime: number;
}

/**
 * Animation playback state
 */
export interface PlaybackState {
    playing: boolean;
    currentFrameIndex: number;
    currentTime: number;
    speedMultiplier: number;
    loop: boolean;
}

/**
 * Render options for AnimationPlayer
 */
export interface RenderOptions {
    /** Draw pivot point indicator */
    showPivot?: boolean;
    /** Draw bounding box */
    showBoundingBox?: boolean;
    /** Pivot indicator color */
    pivotColor?: string;
    /** Bounding box color */
    boundingBoxColor?: string;
}
