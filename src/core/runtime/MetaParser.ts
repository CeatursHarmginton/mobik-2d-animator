/**
 * Meta Parser - Shared parser for runtime meta.json format
 * Used by both AnimationPlayer and MetaExporter for consistency
 * @module core/runtime/MetaParser
 */

import { RuntimeMeta, RuntimeFrame, AnimationData, ParsedFrame } from './types';

export class MetaParser {
    /**
     * Parse runtime meta JSON string into AnimationData
     */
    static parse(json: string): AnimationData {
        const meta = JSON.parse(json) as RuntimeMeta;
        return this.parseObject(meta);
    }

    /**
     * Parse runtime meta object into AnimationData
     * Supports both runtime format (fps, arrays) and project format (defaultFPS, objects)
     * Also supports compact grid format (v1.1) where frames are auto-generated
     */
    static parseObject(meta: RuntimeMeta): AnimationData {
        this.validate(meta);

        // Support both runtime format (fps) and project format (defaultFPS)
        const fps = meta.animation.fps ?? (meta.animation as any).defaultFPS;
        const baseDuration = 1 / fps;

        // === Compact grid format: auto-generate frames ===
        if (meta.animation.grid && (!meta.animation.frames || meta.animation.frames.length === 0)) {
            return this._parseCompactFormat(meta, fps, baseDuration);
        }

        const frames: ParsedFrame[] = [];
        let currentTime = 0;

        for (let i = 0; i < meta.animation.frames.length; i++) {
            const rf = meta.animation.frames[i] as any;

            // Support both runtime format (arrays) and project format (objects)
            const isRuntimeFormat = Array.isArray(rf.rect);

            let sourceRect: { x: number, y: number, w: number, h: number };
            let pivot: { x: number, y: number };
            let offset: { x: number, y: number };
            let scale: { x: number, y: number };
            let sourceFile: string;
            let duration: number;

            if (isRuntimeFormat) {
                // Runtime format: arrays
                sourceRect = { x: rf.rect[0], y: rf.rect[1], w: rf.rect[2], h: rf.rect[3] };
                pivot = { x: rf.pivot[0], y: rf.pivot[1] };
                offset = { x: rf.offset[0], y: rf.offset[1] };
                scale = { x: rf.scale?.[0] ?? 1, y: rf.scale?.[1] ?? 1 };
                sourceFile = rf.src;
                duration = rf.dur;
            } else {
                // Project format: objects
                sourceRect = rf.sourceRect;
                pivot = rf.pivot;
                offset = rf.offset;
                scale = rf.scale ?? { x: 1, y: 1 };
                sourceFile = rf.sourceFile;
                duration = rf.duration;
            }

            const frameDuration = baseDuration * duration;

            frames.push({
                index: i,
                sourceFile,
                sourceRect,
                pivot,
                offset,
                scale,
                duration,
                startTime: currentTime,
                endTime: currentTime + frameDuration
            });

            currentTime += frameDuration;
        }

        return {
            name: meta.animation.name,
            fps: fps,
            loop: meta.animation.loop,
            totalDuration: currentTime,
            frames: frames
        };
    }

    /**
     * Parse compact grid format — auto-generate frames from grid layout
     */
    private static _parseCompactFormat(meta: RuntimeMeta, fps: number, baseDuration: number): AnimationData {
        const grid = meta.animation.grid!;
        const cols = grid.columns;
        const rows = grid.rows;
        const totalFrames = grid.frameCount ?? (cols * rows);

        // Helper: normalize [x,y] or {x,y} to {x,y}
        const toXY = (val: any, def: [number, number]): { x: number; y: number } => {
            if (!val) return { x: def[0], y: def[1] };
            if (Array.isArray(val)) return { x: val[0], y: val[1] };
            return { x: val.x ?? def[0], y: val.y ?? def[1] };
        };

        // Shared properties (defaults)
        const sharedPivot = toXY(meta.animation.pivot, [0.5, 1.0]);
        const sharedOffset = toXY(meta.animation.offset, [0, 0]);
        const sharedScale = toXY(meta.animation.scale, [1, 1]);
        const srcFile = meta.spriteSheet || '';

        const frames: ParsedFrame[] = [];
        let currentTime = 0;

        // We don't know image dimensions here — use 0 as placeholder
        // The actual dimensions will be filled in when the image loads
        for (let i = 0; i < totalFrames; i++) {
            const frameDuration = baseDuration;
            frames.push({
                index: i,
                sourceFile: srcFile,
                sourceRect: { x: 0, y: 0, w: 0, h: 0 }, // Placeholder — resolved by image loader
                pivot: { ...sharedPivot },
                offset: { ...sharedOffset },
                scale: { ...sharedScale },
                duration: 1,
                startTime: currentTime,
                endTime: currentTime + frameDuration
            });
            currentTime += frameDuration;
        }

        return {
            name: meta.animation.name,
            fps,
            loop: meta.animation.loop,
            totalDuration: currentTime,
            frames
        };
    }

    /**
     * Validate runtime meta structure
     */
    static validate(meta: RuntimeMeta): void {
        if (!meta.animation) {
            throw new Error('Invalid meta: missing animation');
        }
        // Compact format: grid is present, frames can be empty/missing
        if (meta.animation.grid) {
            if (meta.animation.grid.columns <= 0 || meta.animation.grid.rows <= 0) {
                throw new Error('Invalid meta: grid columns and rows must be positive');
            }
        } else if (!Array.isArray(meta.animation.frames)) {
            throw new Error('Invalid meta: frames must be an array');
        }
        // Support both runtime format (fps) and project format (defaultFPS)
        const fps = meta.animation.fps ?? (meta.animation as any).defaultFPS;
        if (typeof fps !== 'number' || fps <= 0) {
            throw new Error('Invalid meta: fps must be a positive number');
        }
    }

    /**
     * Convert AnimationData back to RuntimeMeta format
     * Used by MetaExporter for consistency
     */
    static toRuntimeFormat(data: AnimationData): RuntimeMeta {
        return {
            version: '1.0.0',
            animation: {
                name: data.name,
                fps: data.fps,
                loop: data.loop,
                frames: data.frames.map(f => this.frameToRuntime(f))
            }
        };
    }

    /**
     * Convert parsed frame to runtime format
     */
    static frameToRuntime(frame: ParsedFrame): RuntimeFrame {
        return {
            src: frame.sourceFile,
            rect: [frame.sourceRect.x, frame.sourceRect.y, frame.sourceRect.w, frame.sourceRect.h],
            pivot: [frame.pivot.x, frame.pivot.y],
            offset: [frame.offset.x, frame.offset.y],
            scale: [frame.scale.x, frame.scale.y],
            dur: frame.duration
        };
    }

    /**
     * Get frame at specific time
     * @returns Frame index, or -1 if no frames
     */
    static getFrameAtTime(data: AnimationData, time: number): number {
        if (data.frames.length === 0) return -1;

        // Handle looping
        let effectiveTime = time;
        if (data.loop && data.totalDuration > 0) {
            effectiveTime = time % data.totalDuration;
        } else if (time >= data.totalDuration) {
            return data.frames.length - 1;
        }

        // Binary search for efficiency with many frames
        for (let i = 0; i < data.frames.length; i++) {
            if (effectiveTime < data.frames[i].endTime) {
                return i;
            }
        }

        return data.frames.length - 1;
    }
}
