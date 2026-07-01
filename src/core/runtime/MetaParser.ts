/**
 * Meta Parser - Shared parser for runtime meta.json format
 * Supports legacy single-animation Mobik JSON and extended interactive mascot JSON.
 * @module core/runtime/MetaParser
 */

import {
    AnimationClipMeta,
    AnimationData,
    NormalizedMobikMeta,
    ParsedFrame,
    RuntimeFrame,
    RuntimeMeta
} from './types';

interface GridResolveOptions {
    imageWidth: number;
    imageHeight: number;
    sourceFile?: string;
}

export class MetaParser {
    /** Parse default/legacy animation JSON into AnimationData. */
    static parse(json: string): AnimationData {
        const meta = JSON.parse(json) as RuntimeMeta;
        return this.parseObject(meta);
    }

    /**
     * Normalize legacy and extended Mobik JSON into one runtime shape.
     * Legacy nimation is retained as legacyAnimation and also inserted into
     * animations under its clip name when no duplicate exists.
     */
    static normalizeMobikMeta(meta: RuntimeMeta | any): NormalizedMobikMeta {
        const normalizedExternal = this.normalizeExternalMeta(meta);
        const animations: Record<string, AnimationClipMeta> = { ...(normalizedExternal.animations ?? {}) };

        if (normalizedExternal.animation) {
            const legacyName = normalizedExternal.animation.name || 'default';
            if (!animations[legacyName]) {
                animations[legacyName] = normalizedExternal.animation;
            }
        }

        return {
            version: normalizedExternal.version || '1.0.0',
            format: normalizedExternal.format || 'mobik-animation',
            project: normalizedExternal.project,
            source: normalizedExternal.source,
            spriteSheet: normalizedExternal.spriteSheet,
            spriteSheets: normalizedExternal.spriteSheets,
            legacyAnimation: normalizedExternal.animation || null,
            animations,
            poseSets: normalizedExternal.poseSets || {},
            interactive: normalizedExternal.interactive || null
        };
    }

    /** Parse a named clip, or the legacy/default clip when name is omitted. */
    static parseObject(meta: RuntimeMeta | any, animationName?: string): AnimationData {
        const normalized = this.normalizeMobikMeta(meta);
        this.validateNormalized(normalized);

        const clipName = animationName || this.getDefaultAnimationName(normalized);
        const clip = normalized.animations[clipName];
        if (!clip) {
            throw new Error('Invalid meta: missing animation ' + clipName);
        }

        return this.parseClip(clip, clip.name || clipName, normalized);
    }

    /** Parse all named animation clips. */
    static parseAnimations(meta: RuntimeMeta | any): Record<string, AnimationData> {
        const normalized = this.normalizeMobikMeta(meta);
        this.validateNormalized(normalized);

        const parsed: Record<string, AnimationData> = {};
        for (const [name, clip] of Object.entries(normalized.animations)) {
            parsed[name] = this.parseClip(clip, clip.name || name, normalized);
        }
        return parsed;
    }

    static getDefaultAnimationName(meta: NormalizedMobikMeta): string {
        if (meta.legacyAnimation) return meta.legacyAnimation.name || 'default';
        return Object.keys(meta.animations)[0] || 'default';
    }

    static parseClip(clip: AnimationClipMeta, name: string, meta?: NormalizedMobikMeta): AnimationData {
        const fps = clip.fps ?? clip.defaultFPS ?? 12;
        if (typeof fps !== 'number' || fps <= 0) {
            throw new Error('Invalid meta: animation ' + name + ' fps must be a positive number');
        }

        const baseDuration = 1 / fps;
        const rawFrames = Array.isArray(clip.frames) ? clip.frames : [];
        const frames: ParsedFrame[] = [];
        let currentTime = 0;

        if (clip.grid && rawFrames.length === 0) {
            const frameCount = clip.grid.frameCount ?? clip.frameCount ?? (clip.grid.columns * clip.grid.rows);
            for (let i = 0; i < frameCount; i++) {
                const duration = 1;
                const frameDuration = baseDuration * duration;
                frames.push({
                    index: i,
                    sourceFile: this.getClipSourceFile(clip, meta),
                    sourceRect: { x: 0, y: 0, w: 0, h: 0 },
                    pivot: this.toXY(clip.pivot, [0.5, 1.0]),
                    offset: this.toXY(clip.offset, [0, 0]),
                    scale: this.toXY(clip.scale, [1, 1]),
                    duration,
                    startTime: currentTime,
                    endTime: currentTime + frameDuration
                });
                currentTime += frameDuration;
            }
        } else {
            for (let i = 0; i < rawFrames.length; i++) {
                const parsed = this.parseFrame(rawFrames[i], i, clip, meta);
                const frameDuration = baseDuration * parsed.duration;
                frames.push({
                    ...parsed,
                    startTime: currentTime,
                    endTime: currentTime + frameDuration
                });
                currentTime += frameDuration;
            }
        }

        return {
            name,
            fps,
            loop: clip.loop ?? true,
            targetSize: clip.targetSize,
            safeFrames: clip.safeFrames,
            speed: clip.speed ?? 1,
            totalDuration: currentTime,
            frames
        };
    }

    /**
     * Resolve compact grid sourceRects after a spritesheet image is available.
     * Valid explicit sourceRects are preserved. Zero-size frames are resolved
     * when grid metadata exists.
     */
    static resolveCompactFrames(
        animation: AnimationData,
        clip: AnimationClipMeta | undefined,
        meta: NormalizedMobikMeta | RuntimeMeta | any,
        options: GridResolveOptions
    ): void {
        if (!clip?.grid || animation.frames.length === 0) return;

        const normalized = 'animations' in meta && 'legacyAnimation' in meta
            ? meta as NormalizedMobikMeta
            : this.normalizeMobikMeta(meta);

        const grid = clip.grid;
        if (!grid.columns || !grid.rows) return;

        const sheetConfig = normalized.source?.sheetConfig;
        const cellWidth = Math.max(1, Math.floor(sheetConfig?.gridWidth || (options.imageWidth / grid.columns)));
        const cellHeight = Math.max(1, Math.floor(sheetConfig?.gridHeight || (options.imageHeight / grid.rows)));
        const startFrame = grid.startFrame ?? 0;
        const sourceFile = options.sourceFile || this.getClipSourceFile(clip, normalized);

        animation.frames.forEach((frame, localIndex) => {
            const hasValidRect = frame.sourceRect.w > 0 && frame.sourceRect.h > 0;
            if (hasValidRect) return;

            const globalIndex = startFrame + localIndex;
            const col = globalIndex % grid.columns;
            const row = Math.floor(globalIndex / grid.columns);
            frame.sourceFile = frame.sourceFile || sourceFile;
            frame.sourceRect = {
                x: col * cellWidth,
                y: row * cellHeight,
                w: cellWidth,
                h: cellHeight
            };
        });
    }

    static hasZeroSizeFrames(animation: AnimationData): boolean {
        return animation.frames.some(frame => frame.sourceRect.w <= 0 || frame.sourceRect.h <= 0);
    }

    /** Normalize TexturePacker/Phaser-style JSON into Mobik runtime meta. */
    private static normalizeExternalMeta(meta: any): RuntimeMeta {
        if (meta?.animation || meta?.animations || !meta?.frames || !meta?.meta?.image) {
            return meta as RuntimeMeta;
        }

        const frameEntries: Array<[string, any]> = Array.isArray(meta.frames)
            ? meta.frames.map((frame: any, index: number) => [String(frame.filename ?? index), frame] as [string, any])
            : Object.entries(meta.frames) as Array<[string, any]>;

        const sortedEntries = frameEntries.sort(([leftKey], [rightKey]) => {
            const leftNum = parseInt(String(leftKey).match(/\d+/)?.[0] ?? '0', 10);
            const rightNum = parseInt(String(rightKey).match(/\d+/)?.[0] ?? '0', 10);
            return leftNum - rightNum || String(leftKey).localeCompare(String(rightKey));
        });

        const firstDuration = Math.max(1, Number((sortedEntries[0]?.[1] as any)?.duration) || 100);
        const fps = 1000 / firstDuration;
        const imageName = String(meta.meta.image);
        const animationName = imageName.replace(/\.[^/.]+$/, '') || 'animation';

        return {
            version: '1.1',
            spriteSheet: imageName,
            animation: {
                name: animationName,
                fps,
                loop: true,
                frames: sortedEntries.map(([, rawFrame]: [string, any]) => {
                    const rect = rawFrame.frame || rawFrame;
                    const spriteSourceSize = rawFrame.spriteSourceSize || { x: 0, y: 0 };
                    const durationMs = Math.max(1, Number(rawFrame.duration) || firstDuration);
                    return {
                        src: imageName,
                        rect: [Number(rect.x) || 0, Number(rect.y) || 0, Number(rect.w) || 0, Number(rect.h) || 0],
                        pivot: [0.5, 1.0],
                        offset: [Number(spriteSourceSize.x) || 0, Number(spriteSourceSize.y) || 0],
                        scale: [1, 1],
                        dur: durationMs / firstDuration
                    };
                })
            }
        };
    }

    private static parseFrame(rawFrame: any, index: number, clip: AnimationClipMeta, meta?: NormalizedMobikMeta): ParsedFrame {
        const isRuntimeFormat = Array.isArray(rawFrame?.rect);
        const sourceRect = isRuntimeFormat
            ? { x: Number(rawFrame.rect[0]) || 0, y: Number(rawFrame.rect[1]) || 0, w: Number(rawFrame.rect[2]) || 0, h: Number(rawFrame.rect[3]) || 0 }
            : (rawFrame?.sourceRect || { x: 0, y: 0, w: 0, h: 0 });

        return {
            index,
            sourceFile: isRuntimeFormat ? (rawFrame.src || this.getClipSourceFile(clip, meta)) : (rawFrame?.sourceFile || this.getClipSourceFile(clip, meta)),
            sourceRect,
            pivot: isRuntimeFormat ? this.toXY(rawFrame.pivot, [0.5, 1.0]) : this.toXY(rawFrame?.pivot ?? clip.pivot, [0.5, 1.0]),
            offset: isRuntimeFormat ? this.toXY(rawFrame.offset, [0, 0]) : this.toXY(rawFrame?.offset ?? clip.offset, [0, 0]),
            scale: isRuntimeFormat ? this.toXY(rawFrame.scale, [1, 1]) : this.toXY(rawFrame?.scale ?? clip.scale, [1, 1]),
            duration: Math.max(0.001, Number(isRuntimeFormat ? rawFrame.dur : rawFrame?.duration) || 1),
            startTime: 0,
            endTime: 0
        };
    }

    private static getClipSourceFile(clip: AnimationClipMeta, meta?: NormalizedMobikMeta): string {
        const firstFrame = Array.isArray(clip.frames) ? clip.frames[0] as any : null;
        return firstFrame?.src || firstFrame?.sourceFile || meta?.spriteSheet || meta?.source?.files?.[0] || '';
    }

    private static toXY(value: any, fallback: [number, number]): { x: number; y: number } {
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

    static validate(meta: RuntimeMeta): void {
        this.validateNormalized(this.normalizeMobikMeta(meta));
    }

    private static validateNormalized(meta: NormalizedMobikMeta): void {
        const names = Object.keys(meta.animations);
        if (names.length === 0) {
            throw new Error('Invalid meta: missing animation');
        }

        for (const name of names) {
            const clip = meta.animations[name];
            const fps = clip.fps ?? clip.defaultFPS ?? 12;
            if (typeof fps !== 'number' || fps <= 0) {
                throw new Error('Invalid meta: animation ' + name + ' fps must be a positive number');
            }

            if (clip.grid) {
                if (clip.grid.columns <= 0 || clip.grid.rows <= 0) {
                    throw new Error('Invalid meta: animation ' + name + ' grid columns and rows must be positive');
                }
            } else if (!Array.isArray(clip.frames)) {
                throw new Error('Invalid meta: animation ' + name + ' frames must be an array');
            }
        }
    }

    static toRuntimeFormat(data: AnimationData): RuntimeMeta {
        return {
            version: '1.0.0',
            animation: {
                name: data.name,
                fps: data.fps,
                loop: data.loop,
                frames: data.frames.map(f => this.frameToRuntime(f)),
                ...(data.targetSize && { targetSize: data.targetSize })
            }
        };
    }

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

    static getFrameAtTime(data: AnimationData, time: number): number {
        if (data.frames.length === 0) return -1;

        let effectiveTime = time;
        if (data.loop && data.totalDuration > 0) {
            effectiveTime = time % data.totalDuration;
        } else if (time >= data.totalDuration) {
            return data.frames.length - 1;
        }

        for (let i = 0; i < data.frames.length; i++) {
            if (effectiveTime < data.frames[i].endTime) {
                return i;
            }
        }

        return data.frames.length - 1;
    }
}

