/**
 * Manual Slicer - Slices sprite sheet using user-defined regions
 * @module core/slicing/ManualSlicer
 */

import { Frame } from '../models/Frame';
import { Rect, Point } from '../models/types';

export interface ManualSliceRegion {
    rect: Rect;
    order?: number;
    name?: string;
}

export class ManualSlicer {
    private _image: HTMLImageElement;
    private _sourceFile: string;

    constructor(image: HTMLImageElement, sourceFile: string) {
        this._image = image;
        this._sourceFile = sourceFile;
    }

    /**
     * Slice sprite sheet using manually defined rectangles
     */
    slice(regions: Rect[]): Frame[] {
        return regions.map((rect, index) => {
            const frame = new Frame({
                index,
                sourceFile: this._sourceFile,
                sourceRect: { ...rect }
            });

            // Store reference to source image
            (frame as any)._image = {
                element: this._image,
                width: this._image.naturalWidth,
                height: this._image.naturalHeight,
                loaded: true
            };

            return frame;
        });
    }

    /**
     * Slice with named regions (for complex sprite sheets)
     */
    sliceWithMetadata(regions: ManualSliceRegion[]): Frame[] {
        // Sort by order if specified
        const sorted = [...regions].sort((a, b) => {
            return (a.order ?? 0) - (b.order ?? 0);
        });

        return sorted.map((region, index) => {
            const frame = new Frame({
                index,
                sourceFile: this._sourceFile,
                sourceRect: { ...region.rect },
                userData: region.name ? { name: region.name } : {}
            });

            (frame as any)._image = {
                element: this._image,
                width: this._image.naturalWidth,
                height: this._image.naturalHeight,
                loaded: true
            };

            return frame;
        });
    }

    /**
     * Auto-detect sprites using flood fill algorithm
     * Finds connected regions of non-transparent pixels
     */
    autoDetect(minSize: number = 4, padding: number = 0): Rect[] {
        const canvas = document.createElement('canvas');
        canvas.width = this._image.naturalWidth;
        canvas.height = this._image.naturalHeight;

        const ctx = canvas.getContext('2d');
        if (!ctx) return [];

        ctx.drawImage(this._image, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        const width = canvas.width;
        const height = canvas.height;

        // Create visited map
        const visited = new Uint8Array(width * height);
        const regions: Rect[] = [];

        const getAlpha = (x: number, y: number): number => {
            if (x < 0 || x >= width || y < 0 || y >= height) return 0;
            return data[(y * width + x) * 4 + 3];
        };

        const isVisited = (x: number, y: number): boolean => {
            return visited[y * width + x] === 1;
        };

        const setVisited = (x: number, y: number): void => {
            visited[y * width + x] = 1;
        };

        // Flood fill to find connected region bounds
        const floodFill = (startX: number, startY: number): Rect | null => {
            const stack: Point[] = [{ x: startX, y: startY }];
            let minX = startX, maxX = startX;
            let minY = startY, maxY = startY;
            let pixelCount = 0;

            while (stack.length > 0) {
                const { x, y } = stack.pop()!;

                if (x < 0 || x >= width || y < 0 || y >= height) continue;
                if (isVisited(x, y)) continue;
                if (getAlpha(x, y) === 0) continue;

                setVisited(x, y);
                pixelCount++;

                minX = Math.min(minX, x);
                maxX = Math.max(maxX, x);
                minY = Math.min(minY, y);
                maxY = Math.max(maxY, y);

                // Add neighbors (4-connected)
                stack.push({ x: x + 1, y });
                stack.push({ x: x - 1, y });
                stack.push({ x, y: y + 1 });
                stack.push({ x, y: y - 1 });
            }

            if (pixelCount < minSize * minSize) return null;

            return {
                x: Math.max(0, minX - padding),
                y: Math.max(0, minY - padding),
                w: Math.min(width, maxX + 1 + padding) - Math.max(0, minX - padding),
                h: Math.min(height, maxY + 1 + padding) - Math.max(0, minY - padding)
            };
        };

        // Scan image for unvisited non-transparent pixels
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (!isVisited(x, y) && getAlpha(x, y) > 0) {
                    const rect = floodFill(x, y);
                    if (rect && rect.w >= minSize && rect.h >= minSize) {
                        regions.push(rect);
                    }
                }
            }
        }

        // Sort regions by position (top-to-bottom, left-to-right)
        regions.sort((a, b) => {
            if (Math.abs(a.y - b.y) < 20) {
                return a.x - b.x;
            }
            return a.y - b.y;
        });

        return regions;
    }

    /**
     * Merge overlapping regions
     */
    static mergeRegions(regions: Rect[], threshold: number = 0): Rect[] {
        const merged: Rect[] = [];
        const used = new Set<number>();

        for (let i = 0; i < regions.length; i++) {
            if (used.has(i)) continue;

            let current = { ...regions[i] };
            used.add(i);

            let changed = true;
            while (changed) {
                changed = false;
                for (let j = 0; j < regions.length; j++) {
                    if (used.has(j)) continue;

                    if (this.rectsOverlap(current, regions[j], threshold)) {
                        current = this.mergeRects(current, regions[j]);
                        used.add(j);
                        changed = true;
                    }
                }
            }

            merged.push(current);
        }

        return merged;
    }

    private static rectsOverlap(a: Rect, b: Rect, threshold: number): boolean {
        return !(a.x - threshold > b.x + b.w ||
            a.x + a.w + threshold < b.x ||
            a.y - threshold > b.y + b.h ||
            a.y + a.h + threshold < b.y);
    }

    private static mergeRects(a: Rect, b: Rect): Rect {
        const x = Math.min(a.x, b.x);
        const y = Math.min(a.y, b.y);
        return {
            x,
            y,
            w: Math.max(a.x + a.w, b.x + b.w) - x,
            h: Math.max(a.y + a.h, b.y + b.h) - y
        };
    }
}
