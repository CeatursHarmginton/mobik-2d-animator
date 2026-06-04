/**
 * Core type definitions for Mobik 2D Animation Editor
 * @module core/models/types
 */

// ============================================================================
// Basic Geometry Types
// ============================================================================

export interface Point {
    x: number;
    y: number;
}

export interface Size {
    w: number;
    h: number;
}

export interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

// ============================================================================
// Source Types
// ============================================================================

export type SourceType = 'frames' | 'sheet';

export interface SheetConfig {
    gridWidth: number;
    gridHeight: number;
    columns: number;
    rows: number;
    padding?: number;
    spacing?: number;
}

export interface SourceInfo {
    type: SourceType;
    files: string[];
    basePath: string;
    sheetConfig?: SheetConfig;
}

// ============================================================================
// Frame Types
// ============================================================================

export interface FrameData {
    index: number;
    sourceFile: string;
    sourceRect: Rect;
    pivot: Point;
    offset: Point;
    duration: number;
    scale: Point;  // Scale factor { x, y } - defaults to { x: 1, y: 1 }
    userData: Record<string, unknown>;
}

export interface FrameImage {
    element: HTMLImageElement;
    width: number;
    height: number;
    loaded: boolean;
}

// ============================================================================
// Animation Types
// ============================================================================

export interface AnimationData {
    name: string;
    frameCount: number;
    defaultFPS: number;
    loop: boolean;
    frames: FrameData[];
    /** Target size for pivot alignment - all animations with same targetSize will align correctly */
    targetSize?: Size;
}

// ============================================================================
// Project Types
// ============================================================================

export interface ProjectInfo {
    name: string;
    created: string;
    modified: string;
}

export interface ExportSettings {
    normalizedSize: Size;
    trimmed: boolean;
    padding: number;
}

export interface ProjectData {
    version: string;
    project: ProjectInfo;
    source: SourceInfo;
    animation: AnimationData;
    export: ExportSettings;
}

// ============================================================================
// Editor State Types
// ============================================================================

export interface ViewportState {
    zoom: number;
    panX: number;
    panY: number;
}

export interface SelectionState {
    selectedFrameIndex: number;
    multiSelect: number[];
}

export interface PlaybackState {
    playing: boolean;
    currentFrame: number;
    fps: number;
    loop: boolean;
}

export interface OnionSkinSettings {
    enabled: boolean;
    previousFrames: number;
    nextFrames: number;
    opacity: number;
}

export interface EditorState {
    viewport: ViewportState;
    selection: SelectionState;
    playback: PlaybackState;
    onionSkin: OnionSkinSettings;
}

// ============================================================================
// Event Types
// ============================================================================

export type EditorEventType =
    | 'frame-selected'
    | 'frame-updated'
    | 'animation-updated'
    | 'playback-changed'
    | 'viewport-changed'
    | 'project-loaded'
    | 'project-saved';

export interface EditorEvent {
    type: EditorEventType;
    data?: unknown;
}

// ============================================================================
// Slice Types
// ============================================================================

export interface SliceResult {
    frames: FrameData[];
    sourceRect: Rect;
}

export interface GridSliceConfig {
    cellWidth: number;
    cellHeight: number;
    startX?: number;
    startY?: number;
    columns?: number;
    rows?: number;
}

export interface ManualSliceRegion {
    rect: Rect;
    order: number;
}

// ============================================================================
// Export Types
// ============================================================================

export interface ExportOptions {
    format: 'json' | 'binary';
    prettyPrint: boolean;
    includeSource: boolean;
}

export const META_VERSION = '1.0.0';
