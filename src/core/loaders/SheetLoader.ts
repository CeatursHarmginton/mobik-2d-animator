/**
 * Sheet Loader - Loads Type B assets (sprite sheets)
 * @module core/loaders/SheetLoader
 */

import { Frame } from '../models/Frame';
import { SourceInfo, SheetConfig, Rect } from '../models/types';
import { GridSlicer, GridSliceConfig } from '../slicing/GridSlicer';
import { ManualSlicer } from '../slicing/ManualSlicer';

export interface SheetLoaderResult {
    image: HTMLImageElement;
    width: number;
    height: number;
    basePath: string;
    filename: string;
}

export class SheetLoader {
    private _image: HTMLImageElement | null = null;
    private _width: number = 0;
    private _height: number = 0;
    private _filename: string = '';
    private _basePath: string = '';

    get image(): HTMLImageElement | null {
        return this._image;
    }

    get width(): number {
        return this._width;
    }

    get height(): number {
        return this._height;
    }

    /**
     * Load sprite sheet from file path (Electron)
     */
    async loadFromPath(filePath: string): Promise<SheetLoaderResult> {
        const pathParts = filePath.replace(/\\/g, '/').split('/');
        this._filename = pathParts.pop() || '';
        this._basePath = pathParts.join('/');

        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                this._image = img;
                this._width = img.naturalWidth;
                this._height = img.naturalHeight;
                resolve({
                    image: img,
                    width: this._width,
                    height: this._height,
                    basePath: this._basePath,
                    filename: this._filename
                });
            };
            img.onerror = () => reject(new Error(`Failed to load: ${filePath}`));
            img.src = filePath;
        });
    }

    /**
     * Load sprite sheet from File object (browser/drag-drop)
     */
    async loadFromFile(file: File): Promise<SheetLoaderResult> {
        this._filename = file.name;
        this._basePath = '';

        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const img = new Image();
                img.onload = () => {
                    this._image = img;
                    this._width = img.naturalWidth;
                    this._height = img.naturalHeight;
                    resolve({
                        image: img,
                        width: this._width,
                        height: this._height,
                        basePath: '',
                        filename: this._filename
                    });
                };
                img.onerror = () => reject(new Error(`Failed to load: ${file.name}`));
                img.src = reader.result as string;
            };
            reader.onerror = () => reject(new Error(`Failed to read: ${file.name}`));
            reader.readAsDataURL(file);
        });
    }

    /**
     * Slice sprite sheet using grid configuration
     */
    sliceWithGrid(config: GridSliceConfig): Frame[] {
        if (!this._image) {
            throw new Error('No image loaded');
        }

        const slicer = new GridSlicer(this._image, this._filename);
        return slicer.slice(config);
    }

    /**
     * Slice sprite sheet using manual regions
     */
    sliceWithManual(regions: Rect[]): Frame[] {
        if (!this._image) {
            throw new Error('No image loaded');
        }

        const slicer = new ManualSlicer(this._image, this._filename);
        return slicer.slice(regions);
    }

    /**
     * Auto-detect grid configuration based on image dimensions
     */
    detectGridConfig(cellWidth: number, cellHeight: number): GridSliceConfig {
        if (!this._image) {
            throw new Error('No image loaded');
        }

        const columns = Math.floor(this._width / cellWidth);
        const rows = Math.floor(this._height / cellHeight);

        return {
            cellWidth,
            cellHeight,
            columns,
            rows,
            startX: 0,
            startY: 0
        };
    }

    /**
     * Create SourceInfo for sprite sheet
     */
    createSourceInfo(config?: SheetConfig): SourceInfo {
        return {
            type: 'sheet',
            basePath: this._basePath,
            files: [this._filename],
            sheetConfig: config
        };
    }

    /**
     * Get suggested cell sizes based on common sprite dimensions
     */
    getSuggestedCellSizes(): { width: number; height: number }[] {
        const sizes: { width: number; height: number }[] = [];
        const commonSizes = [16, 32, 48, 64, 96, 128, 256];

        for (const w of commonSizes) {
            for (const h of commonSizes) {
                if (this._width % w === 0 && this._height % h === 0) {
                    const cols = this._width / w;
                    const rows = this._height / h;
                    // Only suggest if it results in reasonable frame count
                    if (cols * rows >= 2 && cols * rows <= 100) {
                        sizes.push({ width: w, height: h });
                    }
                }
            }
        }

        return sizes;
    }
}
