/**
 * Settings Manager - Handles persisting user preferences
 * @module shared/SettingsManager
 */

export interface AppSettings {
    // Layout
    rightPanelWidth: number;
    timelineHeight: number;

    // View
    fps: number;
    gridEnabled: boolean;
    onionSkinEnabled: boolean;

    // Reference Mode
    referenceOpacity: number;

    // Sprite Sheet
    sliceCols: number;
    sliceRows: number;

    // Preview Panel
    previewPanelPosition: { x: number; y: number } | null;
}

const DEFAULT_SETTINGS: AppSettings = {
    rightPanelWidth: 280,
    timelineHeight: 120,
    fps: 12,
    gridEnabled: true,
    onionSkinEnabled: false,
    referenceOpacity: 40,
    sliceCols: 4,
    sliceRows: 1,
    previewPanelPosition: null
};

const STORAGE_KEY = 'mobik-animator-settings';

export class SettingsManager {
    private static _instance: SettingsManager;
    private _settings: AppSettings;

    private constructor() {
        this._settings = this.load();
    }

    static get instance(): SettingsManager {
        if (!this._instance) {
            this._instance = new SettingsManager();
        }
        return this._instance;
    }

    get settings(): AppSettings {
        return { ...this._settings };
    }

    get<K extends keyof AppSettings>(key: K): AppSettings[K] {
        return this._settings[key];
    }

    set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
        this._settings[key] = value;
        this.save();
    }

    update(partial: Partial<AppSettings>): void {
        this._settings = { ...this._settings, ...partial };
        this.save();
    }

    private load(): AppSettings {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                const parsed = JSON.parse(stored);
                return { ...DEFAULT_SETTINGS, ...parsed };
            }
        } catch (error) {
            console.warn('Failed to load settings:', error);
        }
        return { ...DEFAULT_SETTINGS };
    }

    private save(): void {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this._settings));
        } catch (error) {
            console.warn('Failed to save settings:', error);
        }
    }

    reset(): void {
        this._settings = { ...DEFAULT_SETTINGS };
        this.save();
    }
}

// Export singleton instance
export const settings = SettingsManager.instance;
