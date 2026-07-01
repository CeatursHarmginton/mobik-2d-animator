/**
 * Normalize by Reference - renderer panel controller.
 * @module renderer/NormalizeByReferenceController
 *
 * Self-contained UI controller for the "Normalize by Reference" tool. It is
 * deliberately decoupled from the main editor / animation player: it only talks
 * to its own DOM (the `#normalize-panel` markup), the DOM-free core
 * (`SpriteSheetNormalizer`) and Electron IPC for file IO. Instantiate it once.
 */

import { SpriteSheetNormalizer } from '../core/normalize/SpriteSheetNormalizer';
import {
    AnchorMode,
    NORMALIZE_PRESETS,
    NormalizeOptions,
    NormalizePresetName,
    NormalizeResult,
    RgbaImage,
    ScaleMode
} from '../core/normalize/types';
import { IPC_CHANNELS } from '../shared/constants';
import {
    dataUrlToBase64,
    imageElementToRgba,
    loadImageFromPath,
    rgbaToCanvas,
    rgbaToDataUrl
} from './normalizeAdapters';

// Electron is available directly because contextIsolation is disabled.
const { ipcRenderer } = require('electron');
const path = require('path');

export class NormalizeByReferenceController {
    private panel: HTMLElement | null = null;

    private referencePath: string | null = null;
    private sheetPath: string | null = null;
    private referenceRgba: RgbaImage | null = null;
    private sheetRgba: RgbaImage | null = null;

    /** Cached result of the last preview/run so export reuses it. */
    private lastResult: NormalizeResult | null = null;

    constructor() {
        // Defer to DOM-ready if necessary so element lookups succeed.
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.init());
        } else {
            this.init();
        }
    }

    // ------------------------------------------------------------------
    // Wiring
    // ------------------------------------------------------------------

    private init(): void {
        this.panel = document.getElementById('normalize-panel');
        if (!this.panel) return; // markup not present -> nothing to wire

        document.getElementById('btn-open-normalize')?.addEventListener('click', () => this.open());
        document.getElementById('btn-close-normalize')?.addEventListener('click', () => this.close());

        document.getElementById('nz-pick-reference')?.addEventListener('click', () => this.pickReference());
        document.getElementById('nz-pick-sheet')?.addEventListener('click', () => this.pickSheet());
        document.getElementById('nz-preview-btn')?.addEventListener('click', () => this.preview());
        document.getElementById('nz-run-btn')?.addEventListener('click', () => this.run());

        // Preset buttons
        this.panel.querySelectorAll('[data-normalize-preset]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.applyPreset((btn as HTMLElement).dataset.normalizePreset as NormalizePresetName);
            });
        });

        // Live slider labels + scale-mode enable/disable
        this.bindSlider('nz-scale-ratio', 'nz-scale-ratio-value', v => (v / 100).toFixed(2));
        this.bindSlider('nz-target-height', 'nz-target-height-value', v => (v / 100).toFixed(2));
        document.getElementById('nz-scale-mode')?.addEventListener('change', () => this.syncScaleModeControls());

        // Re-render preview overlays when toggles change (only if we have a result)
        ['nz-show-bbox', 'nz-show-safe', 'nz-show-reference', 'nz-preview-frame'].forEach(id => {
            document.getElementById(id)?.addEventListener('input', () => {
                if (this.lastResult) this.renderPreview(this.lastResult);
            });
        });

        this.syncScaleModeControls();
    }

    private bindSlider(sliderId: string, labelId: string, fmt: (v: number) => string): void {
        const slider = document.getElementById(sliderId) as HTMLInputElement | null;
        const label = document.getElementById(labelId);
        if (!slider || !label) return;
        const update = () => { label.textContent = fmt(Number(slider.value)); };
        slider.addEventListener('input', update);
        update();
    }

    /** Grey out scale controls that don't apply to the selected scale mode. */
    private syncScaleModeControls(): void {
        const mode = this.getSelectValue('nz-scale-mode') as ScaleMode;
        this.setDisabled('nz-scale-ratio', mode !== 'match_reference_height');
        this.setDisabled('nz-target-height', mode !== 'fit_safe_area');
        this.setDisabled('nz-manual-scale', mode !== 'manual_scale');
    }

    open(): void {
        this.panel?.classList.remove('hidden');
        this.panel?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    close(): void {
        this.panel?.classList.add('hidden');
    }

    // ------------------------------------------------------------------
    // Presets
    // ------------------------------------------------------------------

    private applyPreset(name: NormalizePresetName): void {
        const preset = NORMALIZE_PRESETS[name];
        if (!preset) return;

        if (preset.anchorMode) this.setSelectValue('nz-anchor', preset.anchorMode);
        if (preset.scaleMode) this.setSelectValue('nz-scale-mode', preset.scaleMode);
        if (preset.scaleRatio !== undefined) this.setSlider('nz-scale-ratio', 'nz-scale-ratio-value', preset.scaleRatio * 100, (preset.scaleRatio).toFixed(2));
        if (preset.targetHeightRatio !== undefined) this.setSlider('nz-target-height', 'nz-target-height-value', preset.targetHeightRatio * 100, preset.targetHeightRatio.toFixed(2));
        if (preset.topOffset !== undefined) this.setNumber('nz-top-offset', preset.topOffset);
        if (preset.smoothing !== undefined) this.setChecked('nz-smoothing', preset.smoothing);

        // highlight the active preset button
        this.panel?.querySelectorAll('[data-normalize-preset]').forEach(b => {
            b.classList.toggle('active', (b as HTMLElement).dataset.normalizePreset === name);
        });

        this.syncScaleModeControls();
        if (this.canRun()) this.preview();
    }

    // ------------------------------------------------------------------
    // File pickers
    // ------------------------------------------------------------------

    private async pickReference(): Promise<void> {
        const file = await this.pickImage('Select Reference Image');
        if (!file) return;
        this.referencePath = file;
        this.setText('nz-reference-name', path.basename(file));
        try {
            const img = await loadImageFromPath(file);
            this.referenceRgba = imageElementToRgba(img);
        } catch (err) {
            alert(`Failed to load reference: ${err}`);
            return;
        }
        if (this.canRun()) this.preview();
    }

    private async pickSheet(): Promise<void> {
        const file = await this.pickImage('Select Sprite Sheet');
        if (!file) return;
        this.sheetPath = file;
        this.setText('nz-sheet-name', path.basename(file));
        try {
            const img = await loadImageFromPath(file);
            this.sheetRgba = imageElementToRgba(img);
        } catch (err) {
            alert(`Failed to load sprite sheet: ${err}`);
            return;
        }
        if (this.canRun()) this.preview();
    }

    private async pickImage(title: string): Promise<string | null> {
        const result = await ipcRenderer.invoke(IPC_CHANNELS.OPEN_FILE_DIALOG, {
            title,
            filters: [{ name: 'Images', extensions: ['png', 'webp'] }],
            properties: ['openFile']
        });
        if (result.canceled || !result.filePaths?.[0]) return null;
        return result.filePaths[0] as string;
    }

    // ------------------------------------------------------------------
    // Options / normalizer
    // ------------------------------------------------------------------

    private canRun(): boolean {
        return !!(this.referenceRgba && this.sheetRgba);
    }

    private readOptions(): Partial<NormalizeOptions> & { columns: number; rows: number } {
        return {
            columns: Math.max(1, this.getNumber('nz-columns', 1)),
            rows: Math.max(1, this.getNumber('nz-rows', 1)),
            anchorMode: this.getSelectValue('nz-anchor') as AnchorMode,
            scaleMode: this.getSelectValue('nz-scale-mode') as ScaleMode,
            scaleRatio: this.getNumber('nz-scale-ratio', 100) / 100,
            targetHeightRatio: this.getNumber('nz-target-height', 85) / 100,
            manualScale: this.getNumber('nz-manual-scale', 1),
            safePadding: this.getNumber('nz-safe-padding', 40),
            alphaThreshold: this.getNumber('nz-alpha-threshold', 10),
            bboxPadding: this.getNumber('nz-bbox-padding', 2),
            topOffset: this.getNumber('nz-top-offset', 0),
            smoothing: this.getChecked('nz-smoothing'),
            autoReduceScale: this.getChecked('nz-auto-reduce'),
            // Debug flags: `getChecked` returns false when the control is absent,
            // so this is a safe no-op passthrough on markup without debug toggles.
            debugOverlay: this.getChecked('nz-debug-overlay'),
            includeBeforeAfterPreview: this.getChecked('nz-before-after'),
            debugMetadata: this.getChecked('nz-debug-metadata')
        };
    }

    private compute(): NormalizeResult | null {
        if (!this.referenceRgba || !this.sheetRgba) {
            alert('Pick both a reference image and a sprite sheet first.');
            return null;
        }
        const normalizer = new SpriteSheetNormalizer(this.readOptions());
        const result = normalizer.normalize(this.referenceRgba, this.sheetRgba);
        this.lastResult = result;
        return result;
    }

    // ------------------------------------------------------------------
    // Preview
    // ------------------------------------------------------------------

    private preview(): void {
        const result = this.compute();
        if (result) this.renderPreview(result);
    }

    private renderPreview(result: NormalizeResult): void {
        const total = result.frames.length;
        const index = Math.max(0, Math.min(total - 1, this.getNumber('nz-preview-frame', 0)));

        const showBBox = this.getChecked('nz-show-bbox');
        const showSafe = this.getChecked('nz-show-safe');
        const showRef = this.getChecked('nz-show-reference');
        const safePad = result.metadata.safe_padding;
        const ref = result.reference;

        // --- Reference canvas (with character bounds) ---------------------
        if (this.referenceRgba) {
            this.paint('nz-canvas-reference', this.referenceRgba, (ctx) => {
                if (showRef && !ref.bbox.empty) {
                    this.strokeRect(ctx, ref.bbox.x, ref.bbox.y, ref.bbox.w, ref.bbox.h, '#4fc3f7');
                }
            });
        }

        // --- Before canvas (source cell + detected bbox) ------------------
        const placement = result.placements[index];
        const sourceFrames = new SpriteSheetNormalizer(this.readOptions()).splitSheet(this.sheetRgba!).frames;
        const sourceFrame = sourceFrames[index];
        if (sourceFrame) {
            this.paint('nz-canvas-before', sourceFrame, (ctx) => {
                if (showBBox && placement && !placement.bbox.empty) {
                    this.strokeRect(ctx, placement.bbox.x, placement.bbox.y, placement.bbox.w, placement.bbox.h, '#ffb74d');
                }
            });
        }

        // --- After canvas (normalized frame + safe area + ref bounds) -----
        const afterFrame = result.frames[index];
        if (afterFrame) {
            this.paint('nz-canvas-after', afterFrame, (ctx) => {
                if (showSafe) {
                    this.strokeRect(ctx, safePad, safePad, ref.width - 2 * safePad, ref.height - 2 * safePad, '#66bb6a');
                }
                if (showRef && !ref.bbox.empty) {
                    this.strokeRect(ctx, ref.bbox.x, ref.bbox.y, ref.bbox.w, ref.bbox.h, '#4fc3f7');
                }
                if (showBBox && placement && !placement.empty) {
                    this.strokeRect(ctx, placement.x, placement.y, placement.scaledWidth, placement.scaledHeight, '#ef5350');
                }
            });
        }

        this.renderInfo(result, index);
        this.renderWarnings(result);
    }

    private renderInfo(result: NormalizeResult, index: number): void {
        const info = document.getElementById('nz-info');
        if (!info) return;
        const m = result.metadata;
        info.textContent =
            `frame ${index + 1}/${result.frames.length} · ${m.frame_width}×${m.frame_height} · ` +
            `scale ${m.global_scale}${result.autoReduced ? ' (reduced)' : ''} · ` +
            `medianH ${m.bbox_stats.median_bbox_height} maxH ${m.bbox_stats.max_bbox_height}`;
    }

    private renderWarnings(result: NormalizeResult): void {
        const box = document.getElementById('nz-warnings');
        if (!box) return;
        box.innerHTML = '';
        if (result.warnings.length === 0) {
            box.textContent = 'No warnings.';
            box.className = 'nz-warnings ok';
            return;
        }
        box.className = 'nz-warnings';
        for (const w of result.warnings) {
            const div = document.createElement('div');
            div.className = 'nz-warning';
            div.textContent = `⚠ ${w.message}`;
            box.appendChild(div);
        }
    }

    // ------------------------------------------------------------------
    // Export
    // ------------------------------------------------------------------

    private async run(): Promise<void> {
        // Always recompute from the current UI so the export reflects the
        // latest settings, even if the user tweaked controls after previewing.
        const result = this.compute();
        if (!result) return;
        this.renderPreview(result);

        const defaultName = this.sheetPath
            ? `${path.basename(this.sheetPath, path.extname(this.sheetPath))}_normalized.png`
            : 'normalized.png';

        const save = await ipcRenderer.invoke(IPC_CHANNELS.SAVE_FILE_DIALOG, {
            title: 'Export Normalized Sprite Sheet',
            defaultPath: defaultName,
            filters: [{ name: 'PNG Image', extensions: ['png'] }]
        });
        if (save.canceled || !save.filePath) return;

        const pngPath: string = save.filePath;
        try {
            // 1) The combined normalized sheet.
            await this.writePng(pngPath, result.sheet);

            // 2) Metadata JSON next to the PNG.
            if (this.getChecked('nz-export-metadata')) {
                const metaPath = pngPath.replace(/\.png$/i, '') + '.normalize.json';
                await ipcRenderer.invoke(IPC_CHANNELS.WRITE_FILE, metaPath, SpriteSheetNormalizer.metadataToJson(result.metadata));
            }

            // 3) Optional individual frames.
            if (this.getChecked('nz-export-frames')) {
                const stem = pngPath.replace(/\.png$/i, '');
                const pad = String(result.frames.length - 1).length;
                for (let i = 0; i < result.frames.length; i++) {
                    const framePath = `${stem}_frame_${String(i).padStart(pad, '0')}.png`;
                    await this.writePng(framePath, result.frames[i]);
                }
            }

            // 4) Optional debug outputs (present only when the debug flag was on).
            const stem = pngPath.replace(/\.png$/i, '');
            if (result.overlaySheet) {
                await this.writePng(`${stem}_overlay.png`, result.overlaySheet);
            }
            if (result.beforeSheet) {
                await this.writePng(`${stem}_before.png`, result.beforeSheet);
            }

            const extras: string[] = [];
            if (this.getChecked('nz-export-metadata')) extras.push('metadata JSON');
            if (this.getChecked('nz-export-frames')) extras.push(`${result.frames.length} frames`);
            if (result.overlaySheet) extras.push('debug overlay');
            if (result.beforeSheet) extras.push('before sheet');
            alert(`Normalized sheet exported to:\n${pngPath}${extras.length ? `\n+ ${extras.join(' + ')}` : ''}`);
        } catch (err) {
            console.error('Normalize export failed:', err);
            alert(`Export failed: ${err}`);
        }
    }

    private async writePng(filePath: string, img: RgbaImage): Promise<void> {
        const base64 = dataUrlToBase64(rgbaToDataUrl(img));
        await ipcRenderer.invoke(IPC_CHANNELS.WRITE_FILE, { filePath, data: base64, encoding: 'base64' });
    }

    // ------------------------------------------------------------------
    // Canvas painting helpers
    // ------------------------------------------------------------------

    /** Draw an RgbaImage into a target <canvas> (sized to the image) + overlay. */
    private paint(canvasId: string, img: RgbaImage, overlay?: (ctx: CanvasRenderingContext2D) => void): void {
        const target = document.getElementById(canvasId) as HTMLCanvasElement | null;
        if (!target) return;
        target.width = img.width;
        target.height = img.height;
        const ctx = target.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, img.width, img.height);
        ctx.drawImage(rgbaToCanvas(img), 0, 0);
        if (overlay) overlay(ctx);
    }

    private strokeRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string): void {
        // Line width scales with image size so it stays visible on big sheets.
        ctx.lineWidth = Math.max(1, Math.round(Math.max(ctx.canvas.width, ctx.canvas.height) / 200));
        ctx.strokeStyle = color;
        ctx.strokeRect(x + 0.5, y + 0.5, Math.max(1, w - 1), Math.max(1, h - 1));
    }

    // ------------------------------------------------------------------
    // Small DOM helpers
    // ------------------------------------------------------------------

    private getNumber(id: string, fallback: number): number {
        const el = document.getElementById(id) as HTMLInputElement | null;
        if (!el) return fallback;
        const n = Number(el.value);
        return Number.isFinite(n) ? n : fallback;
    }

    private setNumber(id: string, value: number): void {
        const el = document.getElementById(id) as HTMLInputElement | null;
        if (el) el.value = String(value);
    }

    private getChecked(id: string): boolean {
        const el = document.getElementById(id) as HTMLInputElement | null;
        return !!el?.checked;
    }

    private setChecked(id: string, value: boolean): void {
        const el = document.getElementById(id) as HTMLInputElement | null;
        if (el) el.checked = value;
    }

    private getSelectValue(id: string): string {
        const el = document.getElementById(id) as HTMLSelectElement | null;
        return el ? el.value : '';
    }

    private setSelectValue(id: string, value: string): void {
        const el = document.getElementById(id) as HTMLSelectElement | null;
        if (el) el.value = value;
    }

    private setSlider(sliderId: string, labelId: string, value: number, label: string): void {
        const slider = document.getElementById(sliderId) as HTMLInputElement | null;
        const labelEl = document.getElementById(labelId);
        if (slider) slider.value = String(value);
        if (labelEl) labelEl.textContent = label;
    }

    private setText(id: string, text: string): void {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    }

    private setDisabled(id: string, disabled: boolean): void {
        const el = document.getElementById(id) as HTMLInputElement | null;
        if (el) {
            el.disabled = disabled;
            el.closest('.panel-section')?.classList.toggle('nz-disabled', disabled);
        }
    }
}
