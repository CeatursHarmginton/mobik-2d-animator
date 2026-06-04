/**
 * Project Model - Top-level container for animation project
 * @module core/models/Project
 */

import {
    ProjectData,
    ProjectInfo,
    SourceInfo,
    ExportSettings,
    META_VERSION,
    SourceType
} from './types';
import { Animation } from './Animation';

export class Project {
    private _info: ProjectInfo;
    private _source: SourceInfo;
    private _animation: Animation;
    private _exportSettings: ExportSettings;
    private _dirty: boolean = false;
    private _filePath: string | null = null;

    constructor() {
        const now = new Date().toISOString();
        this._info = {
            name: 'untitled',
            created: now,
            modified: now
        };
        this._source = {
            type: 'frames',
            files: [],
            basePath: ''
        };
        this._animation = new Animation();
        this._exportSettings = {
            normalizedSize: { w: 64, h: 64 },
            trimmed: false,
            padding: 0
        };
    }

    // ========================================================================
    // Accessors
    // ========================================================================

    get info(): ProjectInfo {
        return this._info;
    }

    get source(): SourceInfo {
        return this._source;
    }

    get animation(): Animation {
        return this._animation;
    }

    get exportSettings(): ExportSettings {
        return this._exportSettings;
    }

    get isDirty(): boolean {
        return this._dirty;
    }

    get filePath(): string | null {
        return this._filePath;
    }

    get name(): string {
        return this._info.name;
    }

    set name(value: string) {
        this._info.name = value;
        this.markDirty();
    }

    // ========================================================================
    // Source Management
    // ========================================================================

    setSource(type: SourceType, basePath: string, files: string[]): void {
        this._source = {
            type,
            basePath,
            files: [...files]
        };
        this.markDirty();
    }

    setSheetConfig(config: SourceInfo['sheetConfig']): void {
        this._source.sheetConfig = config;
        this.markDirty();
    }

    // ========================================================================
    // Export Settings
    // ========================================================================

    setNormalizedSize(width: number, height: number): void {
        this._exportSettings.normalizedSize = { w: width, h: height };
        this.markDirty();
    }

    setTrimmed(trimmed: boolean): void {
        this._exportSettings.trimmed = trimmed;
        this.markDirty();
    }

    setPadding(padding: number): void {
        this._exportSettings.padding = padding;
        this.markDirty();
    }

    // ========================================================================
    // State Management
    // ========================================================================

    markDirty(): void {
        this._dirty = true;
        this._info.modified = new Date().toISOString();
    }

    clearDirty(): void {
        this._dirty = false;
    }

    // ========================================================================
    // Serialization
    // ========================================================================

    toData(): ProjectData {
        return {
            version: META_VERSION,
            project: { ...this._info },
            source: {
                ...this._source,
                files: [...this._source.files]
            },
            animation: this._animation.toData(),
            export: { ...this._exportSettings }
        };
    }

    toJSON(pretty: boolean = true): string {
        const data = this.toData();
        return JSON.stringify(data, null, pretty ? 2 : 0);
    }

    static fromData(data: ProjectData): Project {
        const project = new Project();

        project._info = {
            name: data.project.name,
            created: data.project.created,
            modified: data.project.modified
        };

        project._source = {
            type: data.source.type,
            basePath: data.source.basePath,
            files: [...data.source.files],
            sheetConfig: data.source.sheetConfig
        };

        project._animation = Animation.fromData(data.animation);

        project._exportSettings = {
            normalizedSize: { ...data.export.normalizedSize },
            trimmed: data.export.trimmed,
            padding: data.export.padding
        };

        project._dirty = false;
        return project;
    }

    static fromJSON(json: string): Project {
        const data = JSON.parse(json) as ProjectData;
        return Project.fromData(data);
    }

    // ========================================================================
    // File Operations (to be used with Electron fs)
    // ========================================================================

    setFilePath(path: string): void {
        this._filePath = path;
    }

    /**
     * Create new empty project
     */
    static createNew(name: string = 'untitled'): Project {
        const project = new Project();
        project._info.name = name;
        return project;
    }
}
