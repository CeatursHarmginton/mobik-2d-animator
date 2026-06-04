/**
 * Animation Model - Container for animation frames and playback settings
 * @module core/models/Animation
 */

import { AnimationData, FrameData, Point, Size } from './types';
import { Frame } from './Frame';

export class Animation implements AnimationData {
    name: string;
    defaultFPS: number;
    loop: boolean;
    targetSize?: Size;

    private _frames: Frame[] = [];

    constructor(data?: Partial<AnimationData>) {
        this.name = data?.name ?? 'untitled';
        this.defaultFPS = data?.defaultFPS ?? 12;
        this.loop = data?.loop ?? true;
        this.targetSize = data?.targetSize;

        if (data?.frames) {
            this._frames = data.frames.map(f => Frame.fromData(f));
        }
    }

    // ========================================================================
    // Frame Access
    // ========================================================================

    get frames(): Frame[] {
        return this._frames;
    }

    get frameCount(): number {
        return this._frames.length;
    }

    getFrame(index: number): Frame | undefined {
        return this._frames[index];
    }

    getFrameByOrder(order: number): Frame | undefined {
        return this._frames.find(f => f.index === order);
    }

    // ========================================================================
    // Frame Management
    // ========================================================================

    addFrame(frame: Frame): void {
        frame.index = this._frames.length;
        this._frames.push(frame);
    }

    addFrames(frames: Frame[]): void {
        frames.forEach(f => this.addFrame(f));
    }

    removeFrame(index: number): Frame | undefined {
        const removed = this._frames.splice(index, 1)[0];
        this.reindexFrames();
        return removed;
    }

    insertFrame(frame: Frame, atIndex: number): void {
        this._frames.splice(atIndex, 0, frame);
        this.reindexFrames();
    }

    moveFrame(fromIndex: number, toIndex: number): void {
        if (fromIndex === toIndex) return;
        if (fromIndex < 0 || fromIndex >= this._frames.length) return;
        if (toIndex < 0 || toIndex >= this._frames.length) return;

        const [frame] = this._frames.splice(fromIndex, 1);
        this._frames.splice(toIndex, 0, frame);
        this.reindexFrames();
    }

    swapFrames(indexA: number, indexB: number): void {
        if (indexA === indexB) return;
        const temp = this._frames[indexA];
        this._frames[indexA] = this._frames[indexB];
        this._frames[indexB] = temp;
        this.reindexFrames();
    }

    clearFrames(): void {
        this._frames = [];
    }

    private reindexFrames(): void {
        this._frames.forEach((frame, idx) => {
            frame.index = idx;
        });
    }

    // ========================================================================
    // Batch Operations
    // ========================================================================

    /**
     * Set pivot for all frames
     */
    setAllPivots(pivot: Point): void {
        this._frames.forEach(frame => {
            frame.pivot = { ...pivot };
        });
    }

    /**
     * Set duration for all frames
     */
    setAllDurations(duration: number): void {
        this._frames.forEach(frame => {
            frame.duration = duration;
        });
    }

    /**
     * Align all frames to a common center
     */
    alignFramesToCenter(): void {
        if (this._frames.length === 0) return;

        // Find max dimensions
        let maxWidth = 0;
        let maxHeight = 0;
        this._frames.forEach(frame => {
            maxWidth = Math.max(maxWidth, frame.width);
            maxHeight = Math.max(maxHeight, frame.height);
        });

        // Center each frame
        this._frames.forEach(frame => {
            frame.offset = {
                x: (maxWidth - frame.width) / 2,
                y: (maxHeight - frame.height) / 2
            };
        });
    }

    /**
     * Align all frames to bottom-center (common for character sprites)
     */
    alignFramesToBottom(): void {
        if (this._frames.length === 0) return;

        let maxWidth = 0;
        let maxHeight = 0;
        this._frames.forEach(frame => {
            maxWidth = Math.max(maxWidth, frame.width);
            maxHeight = Math.max(maxHeight, frame.height);
        });

        this._frames.forEach(frame => {
            frame.offset = {
                x: (maxWidth - frame.width) / 2,
                y: maxHeight - frame.height
            };
        });
    }

    // ========================================================================
    // Playback Calculations
    // ========================================================================

    /**
     * Get total animation duration in seconds
     */
    getTotalDuration(): number {
        const frameDuration = 1 / this.defaultFPS;
        return this._frames.reduce((sum, frame) => {
            return sum + frameDuration * frame.duration;
        }, 0);
    }

    /**
     * Get frame index at specific time
     */
    getFrameAtTime(time: number): number {
        if (this._frames.length === 0) return -1;

        const totalDuration = this.getTotalDuration();
        if (this.loop && time >= totalDuration) {
            time = time % totalDuration;
        }

        const frameDuration = 1 / this.defaultFPS;
        let elapsed = 0;

        for (let i = 0; i < this._frames.length; i++) {
            elapsed += frameDuration * this._frames[i].duration;
            if (time < elapsed) return i;
        }

        return this._frames.length - 1;
    }

    // ========================================================================
    // Loading
    // ========================================================================

    async loadAllImages(basePath: string): Promise<void> {
        await Promise.all(this._frames.map(frame => frame.loadImage(basePath)));
    }

    // ========================================================================
    // Serialization
    // ========================================================================

    toData(): AnimationData {
        return {
            name: this.name,
            frameCount: this.frameCount,
            defaultFPS: this.defaultFPS,
            loop: this.loop,
            frames: this._frames.map(f => f.toData()),
            ...(this.targetSize && { targetSize: this.targetSize })
        };
    }

    static fromData(data: AnimationData): Animation {
        return new Animation(data);
    }
}
