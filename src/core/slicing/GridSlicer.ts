/**
 * Grid Slicer - Slices sprite sheet using regular grid
 * @module core/slicing/GridSlicer
 */

import { Frame } from '../models/Frame';
import { Rect } from '../models/types';

export interface GridSliceConfig {
    cellWidth: number;
    cellHeight: number;
    startX?: number;
    startY?: number;
    columns?: number;
    rows?: number;
    padding?: number;
    spacing?: number;
}

export class GridSlicer {
    private _image: HTMLImageElement;
    private _sourceFile: string;

    constructor(image: HTMLImageElement, sourceFile: string) {
        this._image = image;
        this._sourceFile = sourceFile;
    }

    /**
     * Slice the sprite sheet into frames using grid configuration
     */
    slice(config: GridSliceConfig): Frame[] {
        const frames: Frame[] = [];

        const startX = config.startX ?? 0;
        const startY = config.startY ?? 0;
        const padding = config.padding ?? 0;
        const spacing = config.spacing ?? 0;

        // Calculate columns and rows if not specified
        const columns = config.columns ?? Math.floor(
            (this._image.naturalWidth - startX + spacing) / (config.cellWidth + spacing)
        );
        const rows = config.rows ?? Math.floor(
            (this._image.naturalHeight - startY + spacing) / (config.cellHeight + spacing)
        );

        let frameIndex = 0;

        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < columns; col++) {
                const x = startX + col * (config.cellWidth + spacing) + padding;
                const y = startY + row * (config.cellHeight + spacing) + padding;
                const w = config.cellWidth - padding * 2;
                const h = config.cellHeight - padding * 2;

                // Skip if outside image bounds
                if (x + w > this._image.naturalWidth || y + h > this._image.naturalHeight) {
                    continue;
                }

                const rect: Rect = { x, y, w, h };

                // Check if cell has content (not completely transparent)
                if (this.hasContent(rect)) {
                    const frame = new Frame({
                        index: frameIndex,
                        sourceFile: this._sourceFile,
                        sourceRect: rect
                    });

                    // Store reference to source image
                    (frame as any)._image = {
                        element: this._image,
                        width: this._image.naturalWidth,
                        height: this._image.naturalHeight,
                        loaded: true
                    };

                    frames.push(frame);
                    frameIndex++;
                }
            }
        }

        return frames;
    }

    /**
     * Preview slice regions without creating Frame objects
     */
    previewSlice(config: GridSliceConfig): Rect[] {
        const regions: Rect[] = [];

        const startX = config.startX ?? 0;
        const startY = config.startY ?? 0;
        const spacing = config.spacing ?? 0;

        const columns = config.columns ?? Math.floor(
            (this._image.naturalWidth - startX + spacing) / (config.cellWidth + spacing)
        );
        const rows = config.rows ?? Math.floor(
            (this._image.naturalHeight - startY + spacing) / (config.cellHeight + spacing)
        );

        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < columns; col++) {
                const x = startX + col * (config.cellWidth + spacing);
                const y = startY + row * (config.cellHeight + spacing);

                regions.push({
                    x,
                    y,
                    w: config.cellWidth,
                    h: config.cellHeight
                });
            }
        }

        return regions;
    }

    /**
     * Check if a region contains any non-transparent pixels
     */
    private hasContent(rect: Rect): boolean {
        // Create canvas to check alpha values
        const canvas = document.createElement('canvas');
        canvas.width = rect.w;
        canvas.height = rect.h;

        const ctx = canvas.getContext('2d');
        if (!ctx) return true; // Assume has content if can't check

        ctx.drawImage(
            this._image,
            rect.x, rect.y, rect.w, rect.h,
            0, 0, rect.w, rect.h
        );

        const imageData = ctx.getImageData(0, 0, rect.w, rect.h);
        const data = imageData.data;

        // Check alpha channel (every 4th byte)
        for (let i = 3; i < data.length; i += 4) {
            if (data[i] > 0) return true;
        }

        return false;
    }

    /**
     * Auto-detect optimal grid size based on content analysis
     */
    static detectGridSize(image: HTMLImageElement): GridSliceConfig | null {
        const width = image.naturalWidth;
        const height = image.naturalHeight;

        // Try common sprite sizes
        const commonSizes = [16, 32, 48, 64, 96, 128];

        for (const size of commonSizes) {
            if (width % size === 0 && height % size === 0) {
                return {
                    cellWidth: size,
                    cellHeight: size,
                    columns: width / size,
                    rows: height / size
                };
            }
        }

        // Try to find GCD
        const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
        const cellSize = gcd(width, height);

        if (cellSize >= 8 && cellSize <= 512) {
            return {
                cellWidth: cellSize,
                cellHeight: cellSize,
                columns: width / cellSize,
                rows: height / cellSize
            };
        }

        return null;
    }
}
