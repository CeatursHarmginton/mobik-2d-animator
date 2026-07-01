/**
 * Runtime Types - Standalone types for animation playback
 * These types are designed to work with exported meta.json files
 * @module core/runtime/types
 */

/**
 * Runtime meta.json format.
 * Supports the legacy single-animation format and the extended interactive
 * mascot format. All new fields are optional so old exports remain valid.
 */
export interface RuntimeMeta {
    version: string;
    format?: 'mobik-animation' | 'mobik-interactive-mascot' | string;
    project?: unknown;
    source?: {
        type?: string;
        basePath?: string;
        files?: string[];
        sheetConfig?: {
            gridWidth?: number;
            gridHeight?: number;
            columns?: number;
            rows?: number;
            padding?: number;
            spacing?: number;
        };
    };
    /** Original sprite sheet filename for import */
    spriteSheet?: string;
    /** Sprite sheet filenames used by multi-part merged animations */
    spriteSheets?: string[];
    /** Legacy/default animation clip */
    animation?: AnimationClipMeta;
    /** Named animation clips for interactive mascot/runtime use */
    animations?: Record<string, AnimationClipMeta>;
    /** Input-selected frame sets. Pose sets are not FPS animations. */
    poseSets?: Record<string, PoseSetConfig>;
    /** Optional interactive mascot behavior config */
    interactive?: InteractiveConfig | null;
    /** Color adjustments applied during export */
    colorAdjustments?: {
        brightness: number;
        contrast: number;
        saturation: number;
        hue: number;
        invert: number;
    };
}

export interface AnimationGridMeta {
    columns: number;
    rows: number;
    frameCount?: number;
    startFrame?: number;
}

export interface AnimationClipMeta {
    name?: string;
    frameCount?: number;
    fps?: number;
    defaultFPS?: number;
    loop?: boolean;
    frames?: Array<RuntimeFrame | any>;
    targetSize?: { w: number; h: number };
    grid?: AnimationGridMeta;
    pivot?: [number, number] | { x: number; y: number };
    offset?: [number, number] | { x: number; y: number };
    scale?: [number, number] | { x: number; y: number };
    safeFrames?: number[] | { start: number; end: number };
    speed?: number;
}

export interface NormalizedMobikMeta {
    version: string;
    format: string;
    project?: unknown;
    source?: RuntimeMeta['source'];
    spriteSheet?: string;
    spriteSheets?: string[];
    legacyAnimation: AnimationClipMeta | null;
    animations: Record<string, AnimationClipMeta>;
    poseSets: Record<string, PoseSetConfig>;
    interactive: InteractiveConfig | null;
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
    targetSize?: { w: number; h: number };
    safeFrames?: number[] | { start: number; end: number };
    speed: number;
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

export interface AngleFramesPoseSetConfig {
    type: 'angleFrames';
    frameCount?: number;
    angleStartDeg?: number;
    angleEndDeg?: number;
    wrap?: boolean;
    grid?: AnimationGridMeta;
    frames?: Array<number | RuntimeFrame | any>;
    pivot?: [number, number] | { x: number; y: number };
    offset?: [number, number] | { x: number; y: number };
    scale?: [number, number] | { x: number; y: number };
    smoothing?: number;
    deadZonePx?: number;
    snapDegrees?: number;
    hysteresisDegrees?: number;
    maxDegreesPerSecond?: number;
}

export interface DirectionFramesPoseSetConfig {
    type: 'directionFrames';
    mode?: 'horizontal-only' | '4-direction' | '8-direction';
    frames: Record<string, number | RuntimeFrame | any>;
    pivot?: [number, number] | { x: number; y: number };
    offset?: [number, number] | { x: number; y: number };
    scale?: [number, number] | { x: number; y: number };
}

export type PoseSetConfig = AngleFramesPoseSetConfig | DirectionFramesPoseSetConfig | any;

export type MascotStateType = 'clip' | 'frameSelector' | 'directionalClip';

export interface MascotStateConfig {
    type: MascotStateType | string;
    animation?: string;
    poseSet?: string;
    input?: string;
    directions?: Record<string, string>;
    priority?: number;
    loop?: boolean;
    interruptible?: boolean;
    cooldownMs?: number;
    returnTo?: string | null;
    transitionMs?: number;
    speed?: number;
}

export interface MascotEventAction {
    state?: string;
    queue?: string;
}

export interface MascotHitAreaConfig {
    name: string;
    shape: 'rect' | string;
    rect: { x: number; y: number; w: number; h: number };
    priority?: number;
    onClick?: string;
    onHover?: string;
    onLeave?: string;
}

export interface PointerTrackingConfig {
    enabled?: boolean;
    mode?: 'horizontal-only' | '4-direction' | '8-direction' | 'angle';
    thresholdPx?: number;
    debounceMs?: number;
    maxDistancePx?: number;
    state?: string;
    directionStates?: Record<string, string>;
}

export interface IdleBehaviorConfig {
    enabled?: boolean;
    inactiveAfterMs?: number;
    minDelayMs?: number;
    maxDelayMs?: number;
    pool?: Array<{ state: string; weight?: number; cooldownMs?: number }>;
}

export interface MascotQueueStep {
    state: string;
    waitBeforeMs?: number;
    minDurationMs?: number;
    maxDurationMs?: number;
    allowInterrupt?: boolean;
}

export interface MascotRuleConfig {
    event: string;
    when?: {
        currentState?: string;
        userInactiveMsGreaterThan?: number;
    };
    action: MascotEventAction;
}

export interface InteractiveConfig {
    defaultState?: string;
    defaultTransitionMs?: number;
    states?: Record<string, MascotStateConfig>;
    events?: Record<string, MascotEventAction>;
    hitAreas?: MascotHitAreaConfig[];
    pointerTracking?: PointerTrackingConfig;
    idleBehavior?: IdleBehaviorConfig;
    queues?: Record<string, MascotQueueStep[]>;
    rules?: MascotRuleConfig[];
    debug?: { enabled?: boolean };
}
