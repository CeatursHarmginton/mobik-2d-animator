/**
 * Spritesheet Exporter - Exports scaled spritesheet with color corrections
 * @module core/export/SpritesheetExporter
 */

import { Project } from '../models/Project';
import { Frame } from '../models/Frame';
import {
    PaletteMatchOptions,
    ReferencePalette,
    applyPaletteMatch,
    extractReferencePalette
} from '../color/ReferencePaletteMatcher';

export interface ColorAdjustments {
    brightness: number;    // -50 to +50, default 0
    contrast: number;      // -50 to +50, default 0
    saturation: number;    // -100 to +100, default 0
    hue: number;           // -180 to +180, default 0
    invert: number;        // 0 to 100, default 0
}

export interface ReferencePaletteMatchExportOptions extends PaletteMatchOptions {
    enabled: boolean;
    referenceIndex: number;
    referenceImageData?: ImageData;
    targetIndices?: number[];
}

export interface SpritesheetExportOptions extends ColorAdjustments {
    paletteMatch?: ReferencePaletteMatchExportOptions;
}

export interface SpritesheetExportResult {
    canvas: HTMLCanvasElement;
    frameWidth: number;
    frameHeight: number;
    columns: number;
    rows: number;
    totalFrames: number;
    paletteMatchApplied?: boolean;
    paletteMatchChangedPixels?: number;
}

export class SpritesheetExporter {
    /**
     * Build a CSS filter string from legacy color adjustments.
     * Only includes filters that differ from defaults.
     */
    static buildFilterString(adj: Partial<ColorAdjustments>): string {
        const parts: string[] = [];

        const brightness = adj.brightness ?? 0;
        const contrast = adj.contrast ?? 0;
        const saturation = adj.saturation ?? 0;
        const hue = adj.hue ?? 0;
        const invert = adj.invert ?? 0;

        if (brightness !== 0) parts.push(`brightness(${1 + brightness / 100})`);
        if (contrast !== 0) parts.push(`contrast(${1 + contrast / 100})`);
        if (saturation !== 0) parts.push(`saturate(${1 + saturation / 100})`);
        if (hue !== 0) parts.push(`hue-rotate(${hue}deg)`);
        if (invert !== 0) parts.push(`invert(${invert}%)`);

        return parts.length > 0 ? parts.join(' ') : 'none';
    }

    /**
     * Generate a scaled spritesheet. Reference Palette Match is the preferred
     * color path; CSS filters are kept only as a legacy fallback.
     */
    static generateScaledSpritesheet(
        project: Project,
        options: Partial<SpritesheetExportOptions> = {}
    ): SpritesheetExportResult | null {
        const animation = project.animation;
        const frames = animation.frames;

        if (frames.length === 0) return null;

        const sheetConfig = project.source.sheetConfig;
        const totalFrames = frames.length;
        let columns: number;
        let rows: number;

        if (sheetConfig && sheetConfig.columns > 0 && sheetConfig.rows > 0) {
            columns = sheetConfig.columns;
            rows = sheetConfig.rows;
        } else {
            columns = totalFrames;
            rows = 1;
        }

        let maxScaledW = 0;
        let maxScaledH = 0;

        for (const frame of frames) {
            const scaledW = Math.ceil(frame.sourceRect.w * frame.scale.x);
            const scaledH = Math.ceil(frame.sourceRect.h * frame.scale.y);
            maxScaledW = Math.max(maxScaledW, scaledW);
            maxScaledH = Math.max(maxScaledH, scaledH);
        }

        if (maxScaledW === 0 || maxScaledH === 0) return null;

        const canvas = document.createElement('canvas');
        canvas.width = columns * maxScaledW;
        canvas.height = rows * maxScaledH;

        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        ctx.imageSmoothingEnabled = false;

        const paletteMatch = options.paletteMatch;
        const usePaletteMatch = Boolean(paletteMatch?.enabled);
        let referencePalette: ReferencePalette | null = null;
        let paletteMatchChangedPixels = 0;
        const targetIndices = new Set(paletteMatch?.targetIndices ?? frames.map((_, index) => index));

        if (usePaletteMatch && paletteMatch) {
            const referenceData = paletteMatch.referenceImageData ?? (() => {
                const referenceFrame = frames[Math.max(0, Math.min(frames.length - 1, paletteMatch.referenceIndex))];
                return this.getFrameImageData(referenceFrame);
            })();
            if (referenceData) {
                referencePalette = extractReferencePalette(referenceData, paletteMatch);
            }
        } else {
            const filterStr = SpritesheetExporter.buildFilterString(options);
            if (filterStr !== 'none') ctx.filter = filterStr;
        }

        for (let i = 0; i < frames.length; i++) {
            const frame = frames[i];
            if (!frame.image?.element) continue;

            const col = i % columns;
            const row = Math.floor(i / columns);
            const scaledW = Math.ceil(frame.sourceRect.w * frame.scale.x);
            const scaledH = Math.ceil(frame.sourceRect.h * frame.scale.y);
            const cellX = col * maxScaledW;
            const cellY = row * maxScaledH;

            if (usePaletteMatch && paletteMatch && referencePalette && targetIndices.has(i)) {
                const frameData = this.getFrameImageData(frame);
                if (!frameData) continue;
                const matched = applyPaletteMatch(frameData, referencePalette, paletteMatch);
                paletteMatchChangedPixels += this.countChangedOpaquePixels(frameData, matched, paletteMatch.alphaThreshold ?? 10);
                const frameCanvas = this.imageDataToCanvas(matched);
                ctx.drawImage(frameCanvas, 0, 0, frame.sourceRect.w, frame.sourceRect.h, cellX, cellY, scaledW, scaledH);
            } else {
                ctx.drawImage(
                    frame.image.element,
                    frame.sourceRect.x, frame.sourceRect.y,
                    frame.sourceRect.w, frame.sourceRect.h,
                    cellX, cellY,
                    scaledW, scaledH
                );
            }
        }

        return {
            canvas,
            frameWidth: maxScaledW,
            frameHeight: maxScaledH,
            columns,
            rows,
            totalFrames,
            paletteMatchApplied: usePaletteMatch && Boolean(referencePalette),
            paletteMatchChangedPixels
        };
    }

    private static countChangedOpaquePixels(before: ImageData, after: ImageData, alphaThreshold: number): number {
        let count = 0;
        for (let i = 0; i < before.data.length; i += 4) {
            if (before.data[i + 3] <= alphaThreshold) continue;
            const dr = Math.abs(before.data[i] - after.data[i]);
            const dg = Math.abs(before.data[i + 1] - after.data[i + 1]);
            const db = Math.abs(before.data[i + 2] - after.data[i + 2]);
            if (dr + dg + db >= 3) count++;
        }
        return count;
    }
    static getFrameImageData(frame: Frame): ImageData | null {
        if (!frame.image?.element || frame.sourceRect.w <= 0 || frame.sourceRect.h <= 0) return null;
        const canvas = document.createElement('canvas');
        canvas.width = frame.sourceRect.w;
        canvas.height = frame.sourceRect.h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return null;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(
            frame.image.element,
            frame.sourceRect.x, frame.sourceRect.y,
            frame.sourceRect.w, frame.sourceRect.h,
            0, 0,
            frame.sourceRect.w, frame.sourceRect.h
        );
        return ctx.getImageData(0, 0, frame.sourceRect.w, frame.sourceRect.h);
    }

    static imageDataToCanvas(imageData: ImageData): HTMLCanvasElement {
        const canvas = document.createElement('canvas');
        canvas.width = imageData.width;
        canvas.height = imageData.height;
        const ctx = canvas.getContext('2d');
        ctx?.putImageData(imageData, 0, 0);
        return canvas;
    }

    static canvasToBase64(canvas: HTMLCanvasElement): string {
        const dataUrl = canvas.toDataURL('image/png');
        return dataUrl.split(',')[1];
    }

    static generateFilename(project: Project): string {
        const name = project.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_|_$/g, '');

        return `${name}_scaled.png`;
    }
}




