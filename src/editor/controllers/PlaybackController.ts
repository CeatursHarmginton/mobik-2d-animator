/**
 * Playback Controller - Handles animation playback
 * @module editor/controllers/PlaybackController
 */

import { Animation } from '../../core/models/Animation';
import { EventEmitter, EditorEvents } from '../../shared/events';
import { createAnimationLoop } from '../../shared/utils';

export class PlaybackController extends EventEmitter {
    private _animation: Animation | null = null;
    private _playing: boolean = false;
    private _currentFrame: number = 0;
    private _loop: boolean = true;
    private _fps: number = 12;

    private _animLoop: { start: () => void; stop: () => void };
    private _frameTime: number = 0;
    private _elapsed: number = 0;
    private _speedMultiplier: number = 1.0;

    constructor() {
        super();

        this._animLoop = createAnimationLoop(this.update.bind(this));
    }

    // ========================================================================
    // Accessors
    // ========================================================================

    get isPlaying(): boolean {
        return this._playing;
    }

    get currentFrame(): number {
        return this._currentFrame;
    }

    set currentFrame(value: number) {
        if (!this._animation) return;
        this._currentFrame = Math.max(0, Math.min(value, this._animation.frameCount - 1));
        this.emit(EditorEvents.PLAYBACK_FRAME_CHANGED, this._currentFrame);
    }

    get fps(): number {
        return this._fps;
    }

    set fps(value: number) {
        this._fps = Math.max(1, Math.min(60, value));
        this._frameTime = 1 / this._fps;
    }

    get loop(): boolean {
        return this._loop;
    }

    set loop(value: boolean) {
        this._loop = value;
    }

    get speedMultiplier(): number {
        return this._speedMultiplier;
    }

    set speedMultiplier(value: number) {
        this._speedMultiplier = Math.max(0.1, Math.min(4, value));
        this.emit(EditorEvents.SPEED_CHANGED, this._speedMultiplier);
    }

    // ========================================================================
    // Animation Management
    // ========================================================================

    setAnimation(animation: Animation | null): void {
        this._animation = animation;
        this._currentFrame = 0;
        this._elapsed = 0;

        if (animation) {
            this._fps = animation.defaultFPS;
            this._frameTime = 1 / this._fps;
            this._loop = animation.loop;
        }

        if (this._playing && !animation) {
            this.stop();
        }
    }

    // ========================================================================
    // Playback Controls
    // ========================================================================

    play(): void {
        if (!this._animation || this._animation.frameCount === 0) return;

        this._playing = true;
        this._elapsed = 0;
        this._animLoop.start();
        this.emit(EditorEvents.PLAYBACK_STARTED);
    }

    pause(): void {
        this._playing = false;
        this._animLoop.stop();
        this.emit(EditorEvents.PLAYBACK_STOPPED);
    }

    stop(): void {
        this._playing = false;
        this._currentFrame = 0;
        this._elapsed = 0;
        this._animLoop.stop();
        this.emit(EditorEvents.PLAYBACK_STOPPED);
        this.emit(EditorEvents.PLAYBACK_FRAME_CHANGED, 0);
    }

    toggle(): void {
        if (this._playing) {
            this.pause();
        } else {
            this.play();
        }
    }

    nextFrame(): void {
        if (!this._animation) return;

        if (this._currentFrame < this._animation.frameCount - 1) {
            this.currentFrame++;
        } else if (this._loop) {
            this.currentFrame = 0;
        }
    }

    prevFrame(): void {
        if (!this._animation) return;

        if (this._currentFrame > 0) {
            this.currentFrame--;
        } else if (this._loop) {
            this.currentFrame = this._animation.frameCount - 1;
        }
    }

    firstFrame(): void {
        this.currentFrame = 0;
    }

    lastFrame(): void {
        if (!this._animation) return;
        this.currentFrame = this._animation.frameCount - 1;
    }

    goToFrame(index: number): void {
        this.currentFrame = index;
    }

    // ========================================================================
    // Update Loop
    // ========================================================================

    private update(deltaTime: number): void {
        if (!this._animation || !this._playing) return;

        const frame = this._animation.getFrame(this._currentFrame);
        if (!frame) return;

        // Get adjusted frame time based on frame duration
        const adjustedFrameTime = this._frameTime * frame.duration;

        // Apply speed multiplier to deltaTime
        this._elapsed += deltaTime * this._speedMultiplier;

        if (this._elapsed >= adjustedFrameTime) {
            this._elapsed -= adjustedFrameTime;

            if (this._currentFrame < this._animation.frameCount - 1) {
                this.currentFrame++;
            } else if (this._loop) {
                this.currentFrame = 0;
            } else {
                this.pause();
            }
        }
    }

    // ========================================================================
    // Time Calculations
    // ========================================================================

    getTotalDuration(): number {
        if (!this._animation) return 0;
        return this._animation.getTotalDuration();
    }

    getCurrentTime(): number {
        if (!this._animation) return 0;

        let time = 0;
        for (let i = 0; i < this._currentFrame; i++) {
            const frame = this._animation.getFrame(i);
            if (frame) {
                time += (1 / this._fps) * frame.duration;
            }
        }
        return time + this._elapsed;
    }

    // ========================================================================
    // Cleanup
    // ========================================================================

    destroy(): void {
        this._animLoop.stop();
        this.removeAllListeners();
    }
}
