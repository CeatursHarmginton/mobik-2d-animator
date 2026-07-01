/**
 * Animation Player - Standalone runtime animation player
 * Can be used with legacy Mobik meta JSON or extended interactive mascot JSON.
 * @module core/runtime/AnimationPlayer
 */

import {
    AnimationClipMeta,
    AnimationData,
    NormalizedMobikMeta,
    ParsedFrame,
    PlaybackState,
    RenderOptions,
    RuntimeMeta
} from './types';
import { MetaParser } from './MetaParser';

export interface PlayOptions {
    restart?: boolean;
    transitionMs?: number;
    speed?: number;
    startFrame?: number;
}

export class AnimationPlayer {
    private _spriteSheet: HTMLImageElement | null = null;
    private _spriteSheets: Map<string, HTMLImageElement> = new Map();
    private _meta: NormalizedMobikMeta | null = null;
    private _clips: Record<string, AnimationClipMeta> = {};
    private _animations: Map<string, AnimationData> = new Map();
    private _animationData: AnimationData | null = null;
    private _currentAnimationName: string = '';
    private _targetSize: { w: number; h: number } | null = null;

    private _playing: boolean = false;
    private _finished: boolean = false;
    private _currentTime: number = 0;
    private _currentFrameIndex: number = 0;
    private _speedMultiplier: number = 1.0;
    private _loop: boolean = true;

    // Crossfade transition: dissolve from the previous clip's frame to the new clip.
    private _transitionFrom: { frame: ParsedFrame; targetSize: { w: number; h: number } | null } | null = null;
    private _transitionElapsed: number = 0;
    private _transitionDuration: number = 0;

    private _onFrameChange: ((index: number) => void) | null = null;
    private _onComplete: (() => void) | null = null;

    async load(spriteSheetUrl: string, metaOrMetaUrl: RuntimeMeta | string): Promise<void> {
        const meta = typeof metaOrMetaUrl === 'string'
            ? await this.fetchMeta(metaOrMetaUrl)
            : metaOrMetaUrl;
        this.loadMeta(meta);
        await this.loadSpriteSheet(spriteSheetUrl);
    }

    async loadSpriteSheet(image: HTMLImageElement | string, key?: string): Promise<void> {
        if (typeof image === 'string') {
            return new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => {
                    this.registerSpriteSheet(img, key || this.filenameFromUrl(image));
                    resolve();
                };
                img.onerror = () => reject(new Error('Failed to load sprite sheet: ' + image));
                img.src = image;
            });
        }

        this.registerSpriteSheet(image, key);
    }

    loadMeta(meta: string | RuntimeMeta): void {
        const rawMeta = typeof meta === 'string' ? JSON.parse(meta) as RuntimeMeta : meta;
        this._meta = MetaParser.normalizeMobikMeta(rawMeta);
        this._clips = this._meta.animations;
        this._animations = new Map(Object.entries(MetaParser.parseAnimations(rawMeta)));

        const defaultName = MetaParser.getDefaultAnimationName(this._meta);
        const fallbackName = this._animations.has(defaultName) ? defaultName : (this.listAnimations()[0] || '');
        this.setCurrentAnimation(fallbackName, { restart: true });
        this.resolveAllCompactFrames();
    }

    get isReady(): boolean {
        return (this._spriteSheet !== null || this._spriteSheets.size > 0) && this._animationData !== null;
    }

    play(animationName?: string | PlayOptions, options: PlayOptions = {}): void {
        if (typeof animationName === 'object') {
            options = animationName;
            animationName = undefined;
        }

        const targetName = animationName || this._currentAnimationName || this.listAnimations()[0];
        if (!targetName || !this._animations.has(targetName)) return;

        const changed = targetName !== this._currentAnimationName;
        if (changed || options.restart) {
            this.beginTransition(options.transitionMs);
            this.setCurrentAnimation(targetName, { ...options, restart: true });
        } else if (options.speed !== undefined) {
            this._speedMultiplier = Math.max(0.1, Math.min(10, options.speed));
        }

        this._playing = true;
        this._finished = false;
    }

    pause(): void {
        this._playing = false;
    }

    resume(): void {
        if (!this.isReady || this._finished) return;
        this._playing = true;
    }

    stop(): void {
        this._playing = false;
        this._finished = false;
        this._currentTime = 0;
        this._currentFrameIndex = 0;
        this._notifyFrameChange();
    }

    toggle(): void {
        if (this._playing) this.pause(); else this.resume();
    }

    stepForward(): void {
        if (!this._animationData) return;
        this.pause();
        const frameCount = this._animationData.frames.length;
        if (this._currentFrameIndex < frameCount - 1) {
            this._currentFrameIndex++;
        } else if (this._loop) {
            this._currentFrameIndex = 0;
        }
        this._syncTimeToFrame();
        this._notifyFrameChange();
    }

    stepBackward(): void {
        if (!this._animationData) return;
        this.pause();
        if (this._currentFrameIndex > 0) {
            this._currentFrameIndex--;
        } else if (this._loop) {
            this._currentFrameIndex = this._animationData.frames.length - 1;
        }
        this._syncTimeToFrame();
        this._notifyFrameChange();
    }

    goToFrame(index: number): void {
        if (!this._animationData) return;
        this._currentFrameIndex = Math.max(0, Math.min(index, this._animationData.frames.length - 1));
        this._syncTimeToFrame();
        this._notifyFrameChange();
    }

    goToTime(time: number): void {
        if (!this._animationData) return;
        this._currentTime = Math.max(0, time);
        this._currentFrameIndex = MetaParser.getFrameAtTime(this._animationData, this._currentTime);
        this._notifyFrameChange();
    }

    update(deltaTime: number): void {
        if (this._transitionFrom) {
            this._transitionElapsed += deltaTime;
            if (this._transitionDuration <= 0 || this._transitionElapsed >= this._transitionDuration) {
                this._transitionFrom = null;
            }
        }

        if (!this._playing || !this._animationData || this._animationData.frames.length === 0) return;

        const previousFrame = this._currentFrameIndex;
        const speed = this._speedMultiplier * (this._animationData.speed || 1);
        this._currentTime += deltaTime * speed;

        if (this._currentTime >= this._animationData.totalDuration) {
            if (this._loop && this._animationData.totalDuration > 0) {
                this._currentTime = this._currentTime % this._animationData.totalDuration;
            } else {
                this._currentTime = this._animationData.totalDuration;
                this._currentFrameIndex = this._animationData.frames.length - 1;
                this._playing = false;
                this._finished = true;
                this._notifyFrameChange();
                this._onComplete?.();
                return;
            }
        }

        this._currentFrameIndex = MetaParser.getFrameAtTime(this._animationData, this._currentTime);
        if (this._currentFrameIndex !== previousFrame) this._notifyFrameChange();
    }

    render(ctx: CanvasRenderingContext2D, x: number, y: number, options: RenderOptions = {}): void {
        const frame = this.currentFrame;

        if (this._transitionFrom && this._transitionDuration > 0) {
            const t = Math.max(0, Math.min(1, this._transitionElapsed / this._transitionDuration));
            const baseAlpha = ctx.globalAlpha;
            const prev = this._transitionFrom;

            ctx.globalAlpha = baseAlpha * (1 - t);
            this.drawFrame(ctx, prev.frame, x, y, 1, 1, prev.targetSize, {});

            if (frame) {
                ctx.globalAlpha = baseAlpha * t;
                const targetSize = this._targetSize || this._animationData?.targetSize || null;
                this.drawFrame(ctx, frame, x, y, 1, 1, targetSize, options);
            }

            ctx.globalAlpha = baseAlpha;
            return;
        }

        if (!frame) return;
        this.renderFrame(ctx, frame, x, y, 1, 1, options);
    }

    renderScaled(
        ctx: CanvasRenderingContext2D,
        x: number,
        y: number,
        scaleX: number = 1,
        scaleY: number = 1,
        options: RenderOptions = {}
    ): void {
        const frame = this.currentFrame;
        if (!frame) return;
        this.renderFrame(ctx, frame, x, y, scaleX, scaleY, options);
    }

    renderFrame(
        ctx: CanvasRenderingContext2D,
        frame: ParsedFrame,
        x: number,
        y: number,
        scaleX: number = 1,
        scaleY: number = 1,
        options: RenderOptions = {}
    ): void {
        const targetSize = this._targetSize || this._animationData?.targetSize || null;
        this.drawFrame(ctx, frame, x, y, scaleX, scaleY, targetSize, options);
    }

    private drawFrame(
        ctx: CanvasRenderingContext2D,
        frame: ParsedFrame,
        x: number,
        y: number,
        scaleX: number,
        scaleY: number,
        targetSize: { w: number; h: number } | null,
        options: RenderOptions = {}
    ): void {
        const spriteSheet = this.getSpriteSheetForFrame(frame);
        if (!spriteSheet || frame.sourceRect.w <= 0 || frame.sourceRect.h <= 0) return;

        const totalScaleX = frame.scale.x * scaleX;
        const totalScaleY = frame.scale.y * scaleY;
        const scaledW = frame.sourceRect.w * totalScaleX;
        const scaledH = frame.sourceRect.h * totalScaleY;

        const pivotBaseW = targetSize ? targetSize.w * scaleX : scaledW;
        const pivotBaseH = targetSize ? targetSize.h * scaleY : scaledH;
        const pivotX = frame.pivot.x * pivotBaseW;
        const pivotY = frame.pivot.y * pivotBaseH;
        const drawX = x - pivotX + frame.offset.x * totalScaleX;
        const drawY = y - pivotY + frame.offset.y * totalScaleY;

        ctx.drawImage(
            spriteSheet,
            frame.sourceRect.x, frame.sourceRect.y,
            frame.sourceRect.w, frame.sourceRect.h,
            drawX, drawY,
            scaledW, scaledH
        );

        if (options.showBoundingBox) {
            ctx.strokeStyle = options.boundingBoxColor || '#00ff00';
            ctx.lineWidth = 1;
            ctx.strokeRect(drawX, drawY, scaledW, scaledH);
        }

        if (options.showPivot) {
            this.drawPivot(ctx, x, y, options.pivotColor);
        }
    }

    hasAnimation(name: string): boolean {
        return this._animations.has(name);
    }

    listAnimations(): string[] {
        return Array.from(this._animations.keys());
    }

    getCurrentAnimation(): AnimationData | null {
        return this._animationData;
    }

    getCurrentFrame(): ParsedFrame | null {
        return this.currentFrame;
    }

    getCurrentFrameIndex(): number {
        return this._currentFrameIndex;
    }

    isFinished(): boolean {
        return this._finished;
    }

    getSpriteSheetForFrame(frame: ParsedFrame): HTMLImageElement | null {
        return this._spriteSheets.get(frame.sourceFile) || this._spriteSheet;
    }

    get normalizedMeta(): NormalizedMobikMeta | null {
        return this._meta;
    }

    get animations(): Map<string, AnimationData> {
        return this._animations;
    }

    get isPlaying(): boolean { return this._playing; }
    get currentFrameIndex(): number { return this._currentFrameIndex; }
    get currentFrame(): ParsedFrame | null { return this._animationData?.frames[this._currentFrameIndex] ?? null; }
    get currentTime(): number { return this._currentTime; }
    get totalDuration(): number { return this._animationData?.totalDuration ?? 0; }
    get frameCount(): number { return this._animationData?.frames.length ?? 0; }
    get fps(): number { return this._animationData?.fps ?? 0; }
    get animationName(): string { return this._currentAnimationName || this._animationData?.name || ''; }
    get speedMultiplier(): number { return this._speedMultiplier; }
    set speedMultiplier(value: number) { this._speedMultiplier = Math.max(0.1, Math.min(10, value)); }
    get loop(): boolean { return this._loop; }
    set loop(value: boolean) { this._loop = value; }
    get spriteSheet(): HTMLImageElement | null { return this._spriteSheet; }
    get animationData(): AnimationData | null { return this._animationData; }

    set onFrameChange(callback: ((index: number) => void) | null) { this._onFrameChange = callback; }
    set onComplete(callback: (() => void) | null) { this._onComplete = callback; }

    getState(): PlaybackState {
        return {
            playing: this._playing,
            currentFrameIndex: this._currentFrameIndex,
            currentTime: this._currentTime,
            speedMultiplier: this._speedMultiplier,
            loop: this._loop
        };
    }

    setState(state: Partial<PlaybackState>): void {
        if (state.playing !== undefined) this._playing = state.playing;
        if (state.currentFrameIndex !== undefined) this._currentFrameIndex = state.currentFrameIndex;
        if (state.currentTime !== undefined) this._currentTime = state.currentTime;
        if (state.speedMultiplier !== undefined) this._speedMultiplier = state.speedMultiplier;
        if (state.loop !== undefined) this._loop = state.loop;
    }

    private beginTransition(transitionMs?: number): void {
        const frame = this.currentFrame;
        if (!transitionMs || transitionMs <= 0 || !frame) {
            this._transitionFrom = null;
            this._transitionDuration = 0;
            return;
        }
        this._transitionFrom = {
            frame,
            targetSize: this._targetSize || this._animationData?.targetSize || null
        };
        this._transitionElapsed = 0;
        this._transitionDuration = transitionMs / 1000;
    }

    private setCurrentAnimation(name: string, options: PlayOptions = {}): void {
        const animation = this._animations.get(name);
        if (!animation) return;

        this._currentAnimationName = name;
        this._animationData = animation;
        this._targetSize = animation.targetSize || null;
        this._loop = animation.loop;
        this._finished = false;
        this._speedMultiplier = options.speed !== undefined ? Math.max(0.1, Math.min(10, options.speed)) : 1;

        if (options.restart || this._currentFrameIndex >= animation.frames.length) {
            this._currentFrameIndex = Math.max(0, Math.min(options.startFrame ?? 0, animation.frames.length - 1));
            this._syncTimeToFrame();
            this._notifyFrameChange();
        }
    }

    private registerSpriteSheet(image: HTMLImageElement, key?: string): void {
        this._spriteSheet = image;
        if (key) this._spriteSheets.set(key, image);
        this.resolveAllCompactFrames();
    }

    private resolveAllCompactFrames(): void {
        if (!this._meta || !this._spriteSheet) return;

        for (const [name, animation] of this._animations.entries()) {
            const clip = this._clips[name];
            const frame = animation.frames[0];
            const image = frame ? this.getSpriteSheetForFrame(frame) || this._spriteSheet : this._spriteSheet;
            MetaParser.resolveCompactFrames(animation, clip, this._meta, {
                imageWidth: image.naturalWidth,
                imageHeight: image.naturalHeight,
                sourceFile: frame?.sourceFile || this._meta.spriteSheet
            });
        }
    }

    private _syncTimeToFrame(): void {
        if (!this._animationData) return;
        const frame = this._animationData.frames[this._currentFrameIndex];
        this._currentTime = frame?.startTime ?? 0;
    }

    private _notifyFrameChange(): void {
        this._onFrameChange?.(this._currentFrameIndex);
    }

    private drawPivot(ctx: CanvasRenderingContext2D, x: number, y: number, color?: string): void {
        const pivotColor = color || '#ff0000';
        const size = 8;
        ctx.strokeStyle = pivotColor;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x - size, y);
        ctx.lineTo(x + size, y);
        ctx.moveTo(x, y - size);
        ctx.lineTo(x, y + size);
        ctx.stroke();
        ctx.fillStyle = pivotColor;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
    }

    private async fetchMeta(url: string): Promise<RuntimeMeta> {
        const response = await fetch(url);
        if (!response.ok) throw new Error('Failed to load meta: ' + url);
        return await response.json() as RuntimeMeta;
    }

    private filenameFromUrl(url: string): string {
        return url.replace(/\\/g, '/').split('/').pop() || url;
    }
}

