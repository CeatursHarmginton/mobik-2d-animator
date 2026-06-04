/**
 * Frame Model - Represents a single animation frame
 * @module core/models/Frame
 */

import { FrameData, FrameImage, Point, Rect } from './types';

export class Frame implements FrameData {
    index: number;
    sourceFile: string;
    sourceRect: Rect;
    pivot: Point;
    offset: Point;
    duration: number;
    scale: Point;
    userData: Record<string, unknown>;

    private _image: FrameImage | null = null;

    constructor(data: Partial<FrameData> & { index: number; sourceFile: string }) {
        this.index = data.index;
        this.sourceFile = data.sourceFile;
        this.sourceRect = data.sourceRect ?? { x: 0, y: 0, w: 0, h: 0 };
        this.pivot = data.pivot ?? { x: 0.5, y: 1.0 }; // Default: bottom-center
        this.offset = data.offset ?? { x: 0, y: 0 };
        this.duration = data.duration ?? 1.0;
        this.scale = data.scale ?? { x: 1.0, y: 1.0 };
        this.userData = data.userData ?? {};
    }

    // ========================================================================
    // Image Management
    // ========================================================================

    get image(): FrameImage | null {
        return this._image;
    }

    get isLoaded(): boolean {
        return this._image?.loaded ?? false;
    }

    get width(): number {
        return this.sourceRect.w || this._image?.width || 0;
    }

    get height(): number {
        return this.sourceRect.h || this._image?.height || 0;
    }

    async loadImage(basePath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                this._image = {
                    element: img,
                    width: img.naturalWidth,
                    height: img.naturalHeight,
                    loaded: true
                };

                // Auto-set sourceRect if not defined
                if (this.sourceRect.w === 0 && this.sourceRect.h === 0) {
                    this.sourceRect = {
                        x: 0,
                        y: 0,
                        w: img.naturalWidth,
                        h: img.naturalHeight
                    };
                }

                resolve();
            };
            img.onerror = () => reject(new Error(`Failed to load image: ${this.sourceFile}`));
            img.src = `${basePath}/${this.sourceFile}`;
        });
    }

    // ========================================================================
    // Pivot Operations
    // ========================================================================

    /**
     * Get pivot position in pixels (relative to frame top-left)
     */
    getPivotPixels(): Point {
        return {
            x: this.pivot.x * this.width,
            y: this.pivot.y * this.height
        };
    }

    /**
     * Set pivot from pixel coordinates
     */
    setPivotFromPixels(pixelX: number, pixelY: number): void {
        this.pivot = {
            x: Math.max(0, Math.min(1, pixelX / this.width)),
            y: Math.max(0, Math.min(1, pixelY / this.height))
        };
    }

    /**
     * Get the world position where this frame should be drawn
     * (accounting for pivot and offset)
     */
    getDrawPosition(worldX: number, worldY: number): Point {
        const pivotPx = this.getPivotPixels();
        return {
            x: worldX - pivotPx.x + this.offset.x,
            y: worldY - pivotPx.y + this.offset.y
        };
    }

    // ========================================================================
    // Serialization
    // ========================================================================

    toData(): FrameData {
        return {
            index: this.index,
            sourceFile: this.sourceFile,
            sourceRect: { ...this.sourceRect },
            pivot: { ...this.pivot },
            offset: { ...this.offset },
            duration: this.duration,
            scale: { ...this.scale },
            userData: { ...this.userData }
        };
    }

    clone(): Frame {
        const frame = new Frame({
            index: this.index,
            sourceFile: this.sourceFile,
            sourceRect: { ...this.sourceRect },
            pivot: { ...this.pivot },
            offset: { ...this.offset },
            duration: this.duration,
            scale: { ...this.scale },
            userData: { ...this.userData }
        });
        frame._image = this._image;
        return frame;
    }

    static fromData(data: FrameData): Frame {
        return new Frame(data);
    }
}
