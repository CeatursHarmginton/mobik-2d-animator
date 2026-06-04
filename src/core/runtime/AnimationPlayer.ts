/**
 * Animation Player - Standalone runtime animation player
 * This module has ZERO dependencies on editor code
 * Can be used with just sprite_sheet.png and meta.json
 * @module core/runtime/AnimationPlayer
 */

import { RuntimeMeta, AnimationData, ParsedFrame, PlaybackState, RenderOptions } from './types';
import { MetaParser } from './MetaParser';

/**
 * Standalone animation player that works with exported sprite sheets
 * 
 * Usage:
 * ```typescript
 * const player = new AnimationPlayer();
 * await player.loadSpriteSheet(spriteSheetImage);
 * player.loadMeta(metaJsonString);
 * player.play();
 * 
 * // In your game loop:
 * player.update(deltaTime);
 * player.render(ctx, x, y);
 * ```
 */
export class AnimationPlayer {
    private _spriteSheet: HTMLImageElement | null = null;
    private _animationData: AnimationData | null = null;
    private _targetSize: { w: number; h: number } | null = null;

    private _playing: boolean = false;
    private _currentTime: number = 0;
    private _currentFrameIndex: number = 0;
    private _speedMultiplier: number = 1.0;
    private _loop: boolean = true;

    // Callbacks
    private _onFrameChange: ((index: number) => void) | null = null;
    private _onComplete: (() => void) | null = null;

    // ========================================================================
    // Loading
    // ========================================================================

    /**
     * Load sprite sheet image
     * @param image - Preloaded HTMLImageElement or image URL
     */
    async loadSpriteSheet(image: HTMLImageElement | string): Promise<void> {
        if (typeof image === 'string') {
            return new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => {
                    this._spriteSheet = img;
                    resolve();
                };
                img.onerror = () => reject(new Error(`Failed to load sprite sheet: ${image}`));
                img.src = image;
            });
        } else {
            this._spriteSheet = image;
        }
    }

    /**
     * Load animation metadata from JSON string or object
     */
    loadMeta(meta: string | RuntimeMeta): void {
        if (typeof meta === 'string') {
            this._animationData = MetaParser.parse(meta);
            // Parse targetSize from string is not supported, needs to be done via parseObject
        } else {
            this._animationData = MetaParser.parseObject(meta);
            // Store targetSize from meta for consistent pivot alignment
            this._targetSize = meta.animation?.targetSize || null;
        }

        // Sync loop setting from meta
        this._loop = this._animationData.loop;
        this._currentFrameIndex = 0;
        this._currentTime = 0;
    }

    /**
     * Check if player is ready to play
     */
    get isReady(): boolean {
        return this._spriteSheet !== null && this._animationData !== null;
    }

    // ========================================================================
    // Playback Controls
    // ========================================================================

    /**
     * Start or resume playback
     */
    play(): void {
        if (!this.isReady) return;
        this._playing = true;
    }

    /**
     * Pause playback
     */
    pause(): void {
        this._playing = false;
    }

    /**
     * Stop playback and reset to start
     */
    stop(): void {
        this._playing = false;
        this._currentTime = 0;
        this._currentFrameIndex = 0;
        this._notifyFrameChange();
    }

    /**
     * Toggle play/pause
     */
    toggle(): void {
        if (this._playing) {
            this.pause();
        } else {
            this.play();
        }
    }

    /**
     * Step forward one frame
     */
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

    /**
     * Step backward one frame
     */
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

    /**
     * Go to specific frame
     */
    goToFrame(index: number): void {
        if (!this._animationData) return;

        this._currentFrameIndex = Math.max(0, Math.min(index, this._animationData.frames.length - 1));
        this._syncTimeToFrame();
        this._notifyFrameChange();
    }

    /**
     * Go to specific time
     */
    goToTime(time: number): void {
        if (!this._animationData) return;

        this._currentTime = Math.max(0, time);
        this._currentFrameIndex = MetaParser.getFrameAtTime(this._animationData, this._currentTime);
        this._notifyFrameChange();
    }

    // ========================================================================
    // Update Loop
    // ========================================================================

    /**
     * Update animation state - call this every frame with deltaTime in seconds
     */
    update(deltaTime: number): void {
        if (!this._playing || !this._animationData) return;

        const previousFrame = this._currentFrameIndex;

        // Apply speed multiplier
        this._currentTime += deltaTime * this._speedMultiplier;

        // Check for animation end
        if (this._currentTime >= this._animationData.totalDuration) {
            if (this._loop) {
                this._currentTime = this._currentTime % this._animationData.totalDuration;
            } else {
                this._currentTime = this._animationData.totalDuration;
                this._currentFrameIndex = this._animationData.frames.length - 1;
                this._playing = false;
                this._onComplete?.();
                return;
            }
        }

        // Find current frame
        this._currentFrameIndex = MetaParser.getFrameAtTime(this._animationData, this._currentTime);

        if (this._currentFrameIndex !== previousFrame) {
            this._notifyFrameChange();
        }
    }

    // ========================================================================
    // Rendering
    // ========================================================================

    /**
     * Render current frame to canvas context
     * @param ctx - Canvas 2D rendering context
     * @param x - X position to render (anchor point, affected by pivot)
     * @param y - Y position to render (anchor point, affected by pivot)
     * @param options - Optional render settings
     */
    render(
        ctx: CanvasRenderingContext2D,
        x: number,
        y: number,
        options: RenderOptions = {}
    ): void {
        if (!this._spriteSheet || !this._animationData) return;

        const frame = this._animationData.frames[this._currentFrameIndex];
        if (!frame) return;

        // Apply frame scale to dimensions
        const scaledW = frame.sourceRect.w * frame.scale.x;
        const scaledH = frame.sourceRect.h * frame.scale.y;

        // Calculate draw position using pivot and scaled dimensions
        const pivotX = frame.pivot.x * scaledW;
        const pivotY = frame.pivot.y * scaledH;
        const drawX = x - pivotX + frame.offset.x * frame.scale.x;
        const drawY = y - pivotY + frame.offset.y * frame.scale.y;

        // Draw frame with scale applied
        ctx.drawImage(
            this._spriteSheet,
            frame.sourceRect.x, frame.sourceRect.y,
            frame.sourceRect.w, frame.sourceRect.h,
            drawX, drawY,
            scaledW, scaledH
        );

        // Draw debug visualizations if requested
        if (options.showBoundingBox) {
            this._drawBoundingBox(ctx, drawX, drawY, frame, options.boundingBoxColor);
        }

        if (options.showPivot) {
            this._drawPivot(ctx, x, y, options.pivotColor);
        }
    }

    /**
     * Render at scaled size
     */
    renderScaled(
        ctx: CanvasRenderingContext2D,
        x: number,
        y: number,
        scaleX: number = 1,
        scaleY: number = 1,
        options: RenderOptions = {}
    ): void {
        if (!this._spriteSheet || !this._animationData) return;

        const frame = this._animationData.frames[this._currentFrameIndex];
        if (!frame) return;

        // Apply both frame's internal scale and external slot scale
        const totalScaleX = frame.scale.x * scaleX;
        const totalScaleY = frame.scale.y * scaleY;

        const scaledW = frame.sourceRect.w * totalScaleX;
        const scaledH = frame.sourceRect.h * totalScaleY;

        // Use targetSize for pivot calculation if available (for consistent alignment)
        // Otherwise fall back to scaled dimensions
        let pivotBaseW, pivotBaseH;
        if (this._targetSize) {
            pivotBaseW = this._targetSize.w * scaleX;
            pivotBaseH = this._targetSize.h * scaleY;
        } else {
            pivotBaseW = scaledW;
            pivotBaseH = scaledH;
        }
        const pivotX = frame.pivot.x * pivotBaseW;
        const pivotY = frame.pivot.y * pivotBaseH;

        // Apply offset with scale
        const drawX = x - pivotX + frame.offset.x * totalScaleX;
        const drawY = y - pivotY + frame.offset.y * totalScaleY;

        ctx.drawImage(
            this._spriteSheet,
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
            this._drawPivot(ctx, x, y, options.pivotColor);
        }
    }

    private _drawBoundingBox(
        ctx: CanvasRenderingContext2D,
        x: number,
        y: number,
        frame: ParsedFrame,
        color?: string
    ): void {
        ctx.strokeStyle = color || '#00ff00';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(x, y, frame.sourceRect.w, frame.sourceRect.h);
        ctx.setLineDash([]);
    }

    private _drawPivot(
        ctx: CanvasRenderingContext2D,
        x: number,
        y: number,
        color?: string
    ): void {
        const pivotColor = color || '#ff0000';
        const size = 8;

        ctx.strokeStyle = pivotColor;
        ctx.lineWidth = 2;

        // Crosshair
        ctx.beginPath();
        ctx.moveTo(x - size, y);
        ctx.lineTo(x + size, y);
        ctx.moveTo(x, y - size);
        ctx.lineTo(x, y + size);
        ctx.stroke();

        // Center dot
        ctx.fillStyle = pivotColor;
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
    }

    // ========================================================================
    // Accessors
    // ========================================================================

    get isPlaying(): boolean {
        return this._playing;
    }

    get currentFrameIndex(): number {
        return this._currentFrameIndex;
    }

    get currentFrame(): ParsedFrame | null {
        return this._animationData?.frames[this._currentFrameIndex] ?? null;
    }

    get currentTime(): number {
        return this._currentTime;
    }

    get totalDuration(): number {
        return this._animationData?.totalDuration ?? 0;
    }

    get frameCount(): number {
        return this._animationData?.frames.length ?? 0;
    }

    get fps(): number {
        return this._animationData?.fps ?? 0;
    }

    get animationName(): string {
        return this._animationData?.name ?? '';
    }

    get speedMultiplier(): number {
        return this._speedMultiplier;
    }

    set speedMultiplier(value: number) {
        this._speedMultiplier = Math.max(0.1, Math.min(10, value));
    }

    get loop(): boolean {
        return this._loop;
    }

    set loop(value: boolean) {
        this._loop = value;
    }

    get spriteSheet(): HTMLImageElement | null {
        return this._spriteSheet;
    }

    get animationData(): AnimationData | null {
        return this._animationData;
    }

    // ========================================================================
    // Callbacks
    // ========================================================================

    set onFrameChange(callback: ((index: number) => void) | null) {
        this._onFrameChange = callback;
    }

    set onComplete(callback: (() => void) | null) {
        this._onComplete = callback;
    }

    // ========================================================================
    // State
    // ========================================================================

    /**
     * Get current playback state (useful for serialization)
     */
    getState(): PlaybackState {
        return {
            playing: this._playing,
            currentFrameIndex: this._currentFrameIndex,
            currentTime: this._currentTime,
            speedMultiplier: this._speedMultiplier,
            loop: this._loop
        };
    }

    /**
     * Set playback state
     */
    setState(state: Partial<PlaybackState>): void {
        if (state.playing !== undefined) this._playing = state.playing;
        if (state.currentFrameIndex !== undefined) this._currentFrameIndex = state.currentFrameIndex;
        if (state.currentTime !== undefined) this._currentTime = state.currentTime;
        if (state.speedMultiplier !== undefined) this._speedMultiplier = state.speedMultiplier;
        if (state.loop !== undefined) this._loop = state.loop;
    }

    // ========================================================================
    // Internals
    // ========================================================================

    private _syncTimeToFrame(): void {
        if (!this._animationData) return;
        const frame = this._animationData.frames[this._currentFrameIndex];
        if (frame) {
            this._currentTime = frame.startTime;
        }
    }

    private _notifyFrameChange(): void {
        this._onFrameChange?.(this._currentFrameIndex);
    }
}
