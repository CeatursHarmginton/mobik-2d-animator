/**
 * PoseSetResolver - resolves input-selected frames for pose sets.
 * @module core/mascot/PoseSetResolver
 */

import { AnimationPlayer } from '../runtime/AnimationPlayer';
import { ParsedFrame, PoseSetConfig, RuntimeFrame } from '../runtime/types';
import { MascotPointerInput } from './MascotConfig';

export class PoseSetResolver {
    private _player: AnimationPlayer;
    private _poseSets: Record<string, PoseSetConfig>;
    private _lastAngleByPoseSet: Map<string, number> = new Map();
    private _lastIndexByPoseSet: Map<string, number> = new Map();

    constructor(player: AnimationPlayer, poseSets: Record<string, PoseSetConfig> = {}) {
        this._player = player;
        this._poseSets = poseSets;
    }

    setPoseSets(poseSets: Record<string, PoseSetConfig>): void {
        this._poseSets = poseSets;
        this._lastAngleByPoseSet.clear();
        this._lastIndexByPoseSet.clear();
    }

    getPoseSet(name: string): PoseSetConfig | null {
        return this._poseSets[name] || null;
    }

    resolve(name: string, input: Partial<MascotPointerInput> = {}): ParsedFrame | null {
        const poseSet = this.getPoseSet(name);
        if (!poseSet) return null;

        if (poseSet.type === 'angleFrames') {
            return this.resolveAngleFrames(name, poseSet, input);
        }
        if (poseSet.type === 'directionFrames') {
            return this.resolveDirectionFrames(poseSet, input);
        }
        return null;
    }

    private resolveAngleFrames(name: string, poseSet: any, input: Partial<MascotPointerInput>): ParsedFrame | null {
        const distance = input.distance ?? Number.MAX_SAFE_INTEGER;
        if (poseSet.deadZonePx !== undefined && distance < poseSet.deadZonePx) {
            const lastIndex = this._lastIndexByPoseSet.get(name) ?? 0;
            return this.getPoseFrame(poseSet, lastIndex);
        }

        const frames = this.getPoseFrameCount(poseSet);
        if (frames <= 0) return null;

        let angle = this.normalizeAngle(input.angleDeg ?? 0);
        const previousAngle = this._lastAngleByPoseSet.get(name);
        if (previousAngle !== undefined && poseSet.smoothing !== undefined) {
            const smoothing = Math.max(0, Math.min(1, poseSet.smoothing));
            angle = this.lerpAngle(previousAngle, angle, smoothing);
        }

        const snap = Number(poseSet.snapDegrees) || 0;
        if (snap > 0) angle = Math.round(angle / snap) * snap;

        const start = Number(poseSet.angleStartDeg) || 0;
        const end = poseSet.angleEndDeg === undefined ? 360 : Number(poseSet.angleEndDeg);
        const span = Math.max(1, end - start);
        const normalized = poseSet.wrap === false
            ? Math.max(0, Math.min(1, (angle - start) / span))
            : this.normalizeAngle(angle - start) / span;

        let index = Math.round(normalized * (frames - 1));
        if (poseSet.wrap !== false) index = ((index % frames) + frames) % frames;
        index = Math.max(0, Math.min(frames - 1, index));

        const hysteresis = Number(poseSet.hysteresisDegrees) || 0;
        const lastIndex = this._lastIndexByPoseSet.get(name);
        if (lastIndex !== undefined && hysteresis > 0) {
            const degreesPerFrame = span / frames;
            if (Math.abs(index - lastIndex) * degreesPerFrame < hysteresis) {
                index = lastIndex;
            }
        }

        this._lastAngleByPoseSet.set(name, angle);
        this._lastIndexByPoseSet.set(name, index);
        return this.getPoseFrame(poseSet, index);
    }

    private resolveDirectionFrames(poseSet: any, input: Partial<MascotPointerInput>): ParsedFrame | null {
        const mode = poseSet.mode || '4-direction';
        let direction = 'center';
        if (mode === 'horizontal-only') {
            direction = input.direction4 === 'left' || input.direction4 === 'right' ? input.direction4 : 'center';
        } else if (mode === '8-direction') {
            direction = input.direction8 || input.direction4 || 'center';
        } else {
            direction = input.direction4 || 'center';
        }

        const frameRef = poseSet.frames?.[direction] ?? poseSet.frames?.center;
        return this.frameFromReference(frameRef, poseSet);
    }

    private getPoseFrame(poseSet: any, index: number): ParsedFrame | null {
        const explicit = poseSet.frames?.[index];
        if (explicit !== undefined) return this.frameFromReference(explicit, poseSet);

        if (poseSet.grid) {
            const image = this._player.spriteSheet;
            if (!image) return null;
            const grid = poseSet.grid;
            const meta = this._player.normalizedMeta;
            const sheetConfig = meta?.source?.sheetConfig;
            const cellW = Math.max(1, Math.floor(sheetConfig?.gridWidth || (image.naturalWidth / grid.columns)));
            const cellH = Math.max(1, Math.floor(sheetConfig?.gridHeight || (image.naturalHeight / grid.rows)));
            const globalIndex = (grid.startFrame || 0) + index;
            const col = globalIndex % grid.columns;
            const row = Math.floor(globalIndex / grid.columns);
            return {
                index,
                sourceFile: meta?.spriteSheet || meta?.source?.files?.[0] || '',
                sourceRect: { x: col * cellW, y: row * cellH, w: cellW, h: cellH },
                pivot: this.toXY(poseSet.pivot, [0.5, 1.0]),
                offset: this.toXY(poseSet.offset, [0, 0]),
                scale: this.toXY(poseSet.scale, [1, 1]),
                duration: 1,
                startTime: 0,
                endTime: 0
            };
        }

        const currentAnimation = this._player.getCurrentAnimation();
        return currentAnimation?.frames[index] || null;
    }

    private frameFromReference(frameRef: number | RuntimeFrame | any, poseSet: any): ParsedFrame | null {
        if (typeof frameRef === 'number') return this.getPoseFrame({ ...poseSet, frames: undefined }, frameRef);
        if (!frameRef) return null;

        if (Array.isArray(frameRef.rect)) {
            return {
                index: 0,
                sourceFile: frameRef.src || this._player.normalizedMeta?.spriteSheet || '',
                sourceRect: { x: Number(frameRef.rect[0]) || 0, y: Number(frameRef.rect[1]) || 0, w: Number(frameRef.rect[2]) || 0, h: Number(frameRef.rect[3]) || 0 },
                pivot: this.toXY(frameRef.pivot ?? poseSet.pivot, [0.5, 1.0]),
                offset: this.toXY(frameRef.offset ?? poseSet.offset, [0, 0]),
                scale: this.toXY(frameRef.scale ?? poseSet.scale, [1, 1]),
                duration: Number(frameRef.dur) || 1,
                startTime: 0,
                endTime: 0
            };
        }

        if (frameRef.sourceRect) {
            return {
                index: Number(frameRef.index) || 0,
                sourceFile: frameRef.sourceFile || this._player.normalizedMeta?.spriteSheet || '',
                sourceRect: frameRef.sourceRect,
                pivot: this.toXY(frameRef.pivot ?? poseSet.pivot, [0.5, 1.0]),
                offset: this.toXY(frameRef.offset ?? poseSet.offset, [0, 0]),
                scale: this.toXY(frameRef.scale ?? poseSet.scale, [1, 1]),
                duration: Number(frameRef.duration) || 1,
                startTime: 0,
                endTime: 0
            };
        }

        return null;
    }

    private getPoseFrameCount(poseSet: any): number {
        if (poseSet.frameCount) return Number(poseSet.frameCount) || 0;
        if (poseSet.grid?.frameCount) return Number(poseSet.grid.frameCount) || 0;
        if (poseSet.grid) return Number(poseSet.grid.columns) * Number(poseSet.grid.rows);
        if (Array.isArray(poseSet.frames)) return poseSet.frames.length;
        return 0;
    }

    private normalizeAngle(angle: number): number {
        return ((angle % 360) + 360) % 360;
    }

    private lerpAngle(from: number, to: number, amount: number): number {
        const delta = ((((to - from) % 360) + 540) % 360) - 180;
        return this.normalizeAngle(from + delta * amount);
    }

    private toXY(value: any, fallback: [number, number]): { x: number; y: number } {
        if (!value) return { x: fallback[0], y: fallback[1] };
        const rawX = Array.isArray(value) ? value[0] : value.x;
        const rawY = Array.isArray(value) ? value[1] : value.y;
        const x = Number(rawX);
        const y = Number(rawY);
        return {
            x: Number.isFinite(x) ? x : fallback[0],
            y: Number.isFinite(y) ? y : fallback[1]
        };
    }
}
