/**
 * Mascot Config - public interactive mascot runtime types.
 * @module core/mascot/MascotConfig
 */

export type {
    AngleFramesPoseSetConfig,
    DirectionFramesPoseSetConfig,
    IdleBehaviorConfig,
    InteractiveConfig,
    MascotEventAction,
    MascotHitAreaConfig,
    MascotQueueStep,
    MascotRuleConfig,
    MascotStateConfig,
    MascotStateType,
    PointerTrackingConfig,
    PoseSetConfig
} from '../runtime/types';

export interface MascotPointerInput {
    x: number;
    y: number;
    dx: number;
    dy: number;
    distance: number;
    angleDeg: number;
    direction4: string;
    direction8: string;
}

export interface MascotDebugInfo {
    currentState: string | null;
    previousState: string | null;
    currentAnimation: string | null;
    currentPoseSet: string | null;
    priority: number;
    queue: string | null;
    lastEvent: string | null;
    cooldowns: Record<string, number>;
}
