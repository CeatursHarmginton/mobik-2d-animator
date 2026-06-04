/**
 * Meta Exporter - Exports animation metadata to JSON
 * @module core/export/MetaExporter
 */

import { Project } from '../models/Project';
import { ProjectData, META_VERSION } from '../models/types';
import { ColorAdjustments } from './SpritesheetExporter';

export interface ExportResult {
    json: string;
    data: ProjectData;
    size: number;
}

export interface ValidationError {
    field: string;
    message: string;
}

export class MetaExporter {
    /**
     * Export project to JSON string
     * Uses compact grid format when all frames share the same pivot/offset/scale
     */
    static export(project: Project, pretty: boolean = true, colorAdj?: ColorAdjustments): ExportResult {
        const data = project.toData();
        const frames = data.animation.frames;

        // Check if all frames share same pivot, offset, scale
        const canUseCompact = frames.length > 0 && this._allFramesUniform(frames);

        let exportData: any;

        if (canUseCompact && data.source.sheetConfig) {
            // Compact grid format
            const first = frames[0];
            exportData = {
                version: data.version,
                project: data.project,
                source: {
                    ...data.source,
                    basePath: '.'
                },
                spriteSheet: data.source.files[0] || null,
                animation: {
                    name: data.animation.name,
                    frameCount: data.animation.frameCount,
                    defaultFPS: data.animation.defaultFPS,
                    loop: data.animation.loop,
                    grid: {
                        columns: data.source.sheetConfig.columns,
                        rows: data.source.sheetConfig.rows,
                        frameCount: frames.length
                    },
                    pivot: { x: first.pivot.x, y: first.pivot.y },
                    offset: { x: first.offset.x, y: first.offset.y },
                    scale: { x: first.scale?.x ?? 1, y: first.scale?.y ?? 1 },
                    ...(data.animation.targetSize && { targetSize: data.animation.targetSize }),
                    frames: [] // Empty — reconstructed from grid on import
                }
            };
        } else {
            // Full per-frame format (fallback)
            exportData = {
                ...data,
                source: {
                    ...data.source,
                    basePath: '.'
                },
                spriteSheet: data.source.files[0] || null
            };
        }

        // Add color adjustments if any are non-zero
        if (colorAdj && (colorAdj.brightness !== 0 || colorAdj.contrast !== 0 ||
            colorAdj.saturation !== 0 || colorAdj.hue !== 0 || colorAdj.invert !== 0)) {
            exportData.colorAdjustments = { ...colorAdj };
        }

        const json = JSON.stringify(exportData, null, pretty ? 2 : 0);

        return {
            json,
            data,
            size: new Blob([json]).size
        };
    }

    /**
     * Export project to minimal JSON (runtime-only data)
     * Strips editor-specific fields for smaller file size
     */
    static exportRuntime(project: Project): ExportResult {
        const fullData = project.toData();

        // Create minimal runtime data
        const runtimeData = {
            version: fullData.version,
            animation: {
                name: fullData.animation.name,
                fps: fullData.animation.defaultFPS,
                loop: fullData.animation.loop,
                frames: fullData.animation.frames.map(f => ({
                    src: f.sourceFile,
                    rect: [f.sourceRect.x, f.sourceRect.y, f.sourceRect.w, f.sourceRect.h],
                    pivot: [f.pivot.x, f.pivot.y],
                    offset: [f.offset.x, f.offset.y],
                    scale: [f.scale?.x ?? 1, f.scale?.y ?? 1],
                    dur: f.duration
                })),
                // Include targetSize for consistent pivot alignment across animations
                ...(fullData.animation.targetSize && { targetSize: fullData.animation.targetSize })
            }
        };

        const json = JSON.stringify(runtimeData);

        return {
            json,
            data: fullData,
            size: new Blob([json]).size
        };
    }

    /**
     * Validate project data before export
     */
    static validate(project: Project): ValidationError[] {
        const errors: ValidationError[] = [];
        const data = project.toData();

        // Check project name
        if (!data.project.name || data.project.name.trim() === '') {
            errors.push({ field: 'project.name', message: 'Project name is required' });
        }

        // Check animation
        if (!data.animation.name || data.animation.name.trim() === '') {
            errors.push({ field: 'animation.name', message: 'Animation name is required' });
        }

        if (data.animation.frameCount === 0) {
            errors.push({ field: 'animation.frames', message: 'Animation has no frames' });
        }

        if (data.animation.defaultFPS <= 0 || data.animation.defaultFPS > 120) {
            errors.push({ field: 'animation.fps', message: 'FPS must be between 1 and 120' });
        }

        // Check frames
        data.animation.frames.forEach((frame, index) => {
            if (!frame.sourceFile) {
                errors.push({
                    field: `frames[${index}].sourceFile`,
                    message: `Frame ${index} has no source file`
                });
            }

            if (frame.sourceRect.w <= 0 || frame.sourceRect.h <= 0) {
                errors.push({
                    field: `frames[${index}].sourceRect`,
                    message: `Frame ${index} has invalid dimensions`
                });
            }

            if (frame.pivot.x < 0 || frame.pivot.x > 1 ||
                frame.pivot.y < 0 || frame.pivot.y > 1) {
                errors.push({
                    field: `frames[${index}].pivot`,
                    message: `Frame ${index} pivot must be normalized (0-1)`
                });
            }
        });

        // Check source files
        if (data.source.files.length === 0) {
            errors.push({ field: 'source.files', message: 'No source files specified' });
        }

        return errors;
    }

    /**
     * Generate export filename from project
     */
    static generateFilename(project: Project, extension: string = 'json'): string {
        const name = project.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_|_$/g, '');

        return `${name}_meta.${extension}`;
    }

    /**
     * Get version info
     */
    static getVersion(): string {
        return META_VERSION;
    }

    /**
     * Check if JSON data is compatible with current version
     */
    static isCompatible(json: string): { compatible: boolean; version: string } {
        try {
            const data = JSON.parse(json);
            const version = data.version || '0.0.0';

            // Major version must match
            const currentMajor = parseInt(META_VERSION.split('.')[0]);
            const dataMajor = parseInt(version.split('.')[0]);

            return {
                compatible: currentMajor === dataMajor,
                version
            };
        } catch {
            return { compatible: false, version: 'unknown' };
        }
    }

    /**
     * Import project from JSON string
     */
    static import(json: string): Project {
        const { compatible, version } = this.isCompatible(json);

        if (!compatible) {
            throw new Error(`Incompatible version: ${version}. Current: ${META_VERSION}`);
        }

        return Project.fromJSON(json);
    }

    /**
     * Check if all frames have the same pivot, offset, and scale
     */
    private static _allFramesUniform(frames: any[]): boolean {
        if (frames.length <= 1) return true;
        const f0 = frames[0];
        const p = f0.pivot;
        const o = f0.offset;
        const s = f0.scale ?? { x: 1, y: 1 };

        return frames.every(f => {
            const fp = f.pivot;
            const fo = f.offset;
            const fs = f.scale ?? { x: 1, y: 1 };
            return fp.x === p.x && fp.y === p.y &&
                fo.x === o.x && fo.y === o.y &&
                fs.x === s.x && fs.y === s.y;
        });
    }
}
