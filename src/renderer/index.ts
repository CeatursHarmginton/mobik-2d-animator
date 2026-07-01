/**
 * Mobik Animator - Renderer Entry Point
 * @module renderer/index
 */

import { Project } from '../core/models/Project';
import { Animation } from '../core/models/Animation';
import { Frame } from '../core/models/Frame';
import { FrameLoader } from '../core/loaders/FrameLoader';
import { SheetLoader } from '../core/loaders/SheetLoader';
import { GridSlicer } from '../core/slicing/GridSlicer';
import { MetaExporter } from '../core/export/MetaExporter';
import { SpritesheetExporter } from '../core/export/SpritesheetExporter';
import { PaletteSize, PaletteConsistencyMode, PaletteMatchPlan, ReferencePalette, applyPaletteMatch, applyPaletteMatchAcrossFrames, applyPaletteMatchPlan, buildPaletteMatchPlan, extractReferencePalette } from '../core/color/ReferencePaletteMatcher';
import { Canvas } from '../editor/components/Canvas';
import { Timeline } from '../editor/components/Timeline';
import { PivotEditor } from '../editor/components/PivotEditor';
import { Toolbar, ToolbarAction } from '../editor/components/Toolbar';
import { PlaybackController } from '../editor/controllers/PlaybackController';
import { PlayerModeController, AnimationSlot } from '../editor/player';
import { PlayerModeTimeline } from '../editor/components/PlayerModeTimeline';
import { MetaParser } from '../core/runtime/MetaParser';
import type { InteractiveConfig, MascotHitAreaConfig, MascotQueueStep, MascotRuleConfig, MascotStateConfig, PoseSetConfig, RuntimeFrame } from '../core/runtime/types';
import { EditorEvents, globalEvents } from '../shared/events';
import { IPC_CHANNELS } from '../shared/constants';
import { round } from '../shared/utils';
import { settings } from '../shared/SettingsManager';
import { ImageFingerprint } from '../shared/ImageFingerprint';
import { InteractiveEditor } from './InteractiveEditor';
import { NormalizeByReferenceController } from './NormalizeByReferenceController';

// Electron IPC
const { ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');

interface MergeAnimationPart {
    id: string;
    metaPath: string;
    name: string;
    fps: number;
    frameCount: number;
    frames: RuntimeFrame[];
    spriteSheets: { filename: string; path: string }[];
    targetSize?: { w: number; h: number };
    slotId?: string;
}

class MobikEditor {
    private _project: Project;
    private _canvas: Canvas;
    private _timeline: Timeline;
    private _pivotEditor: PivotEditor;
    private _toolbar: Toolbar;
    private _playback: PlaybackController;
    private _sheetLoader: SheetLoader | null = null;

    // Normalized preview
    private _previewCanvas: HTMLCanvasElement | null = null;
    private _previewCtx: CanvasRenderingContext2D | null = null;
    private _previewScale: number = 1;

    // Reference Mode
    private _isReferenceMode: boolean = false;
    private _refMirrorEnabled: boolean = false;
    private _refPivot: { x: number; y: number } = { x: 0.5, y: 1.0 }; // Default: bottom-center
    private _refImage: HTMLImageElement | null = null;
    private _colorAdj = { brightness: 0, contrast: 0, saturation: 0, hue: 0, invert: 0 };
    private _paletteMatchOptions = { enabled: false, referenceSource: 'frame' as 'frame' | 'loaded-reference', referenceIndex: 0, paletteSize: 32 as PaletteSize, strength: 0.65, preserveShading: 0.75, lightnessTolerance: 0.5, alphaThreshold: 10, applyTo: 'all' as 'current' | 'selected' | 'all', protectTransparent: true, paletteConsistency: 'global_sheet' as PaletteConsistencyMode };
    private _paletteCache: { key: string; palette: ReferencePalette } | null = null;
    /** Cached cross-frame plan so live tuning reuses one mapping (invalidated by key). */
    private _palettePlanCache: { key: string; plan: PaletteMatchPlan | null } | null = null;
    private _paletteTuning = false;
    private _palettePreviewAnimationTimer: number | null = null;
    private _palettePreviewFrameIndex: number = 0;
    private _mergeParts: MergeAnimationPart[] = [];
    private _mergeExportFps: number | null = null;

    // Player Mode
    private _isPlayerMode: boolean = false;
    private _playerModeKind: 'player' | 'merge' | null = null;
    private _playerController: PlayerModeController | null = null;
    private _playerTimeline: PlayerModeTimeline | null = null;
    private _playerCanvas: HTMLCanvasElement | null = null;
    private _playerCtx: CanvasRenderingContext2D | null = null;
    private _interactiveEditor: InteractiveEditor | null = null;

    constructor() {
        this._project = Project.createNew('untitled');

        // Initialize components
        this._canvas = new Canvas({
            container: document.getElementById('canvas-container')!
        });

        this._timeline = new Timeline({
            container: document.getElementById('timeline-container')!
        });

        this._pivotEditor = new PivotEditor({
            container: document.getElementById('pivot-editor-container')!
        });

        this._toolbar = new Toolbar({
            container: document.getElementById('toolbar-container')!
        });

        this._playback = new PlaybackController();

        this.setupEventListeners();
        this.setupMenuListeners();
        this.setupUIListeners();
        this.setupNormalizedPreview();
        this.setupReferenceModeListeners();
        this.setupInteractiveEditor();
        this.setupResizableLayout();
        this.applySettings();
        this.setupPlayerMode();
    }

    // ========================================================================
    // Event Setup
    // ========================================================================

    private setupEventListeners(): void {
        // Timeline events
        this._timeline.on(EditorEvents.FRAME_SELECTED, (index: number) => {
            this.selectFrame(index);
        });

        this._timeline.on(EditorEvents.ANIMATION_UPDATED, () => {
            this._project.markDirty();
            this._canvas.render();
        });

        // Canvas events
        this._canvas.on(EditorEvents.PIVOT_CHANGED, () => {
            this._pivotEditor.updateInputs();
            this._project.markDirty();
        });

        this._canvas.on(EditorEvents.ZOOM_CHANGED, (zoom: number) => {
            this.updateZoomDisplay(zoom);
        });

        // Context menu event
        this._timeline.on(EditorEvents.FRAME_CONTEXT_MENU, (data: { index: number, x: number, y: number }) => {
            this.showFrameContextMenu(data.index, data.x, data.y);
        });

        // Close context menu on click outside
        document.addEventListener('click', () => {
            this.hideFrameContextMenu();
        });

        // Pivot editor events
        this._pivotEditor.on(EditorEvents.PIVOT_CHANGED, () => {
            this._canvas.render();
            this._project.markDirty();
        });

        this._pivotEditor.on('apply-all', (data: { pivot: any; offset: any }) => {
            this._project.animation.setAllPivots(data.pivot);
            this._timeline.refreshFrameList();
            this._canvas.render();
            this._project.markDirty();
        });

        this._pivotEditor.on('align-center', () => {
            this._project.animation.alignFramesToCenter();
            this._timeline.refreshFrameList();
            this._canvas.render();
            this._project.markDirty();
        });

        this._pivotEditor.on('align-bottom', () => {
            this._project.animation.alignFramesToBottom();
            this._timeline.refreshFrameList();
            this._canvas.render();
            this._project.markDirty();
        });

        // Canvas events - frame scale changed (from drag-resize)
        // Only applies scale/offset to ALL frames when resize ENDS (has frameIndex)
        this._canvas.on(EditorEvents.FRAME_SCALE_CHANGED, (data: { scaleX?: number, scaleY?: number, frameIndex?: number, scale?: { x: number, y: number }, offset?: { x: number, y: number } }) => {
            const scaleXSlider = document.getElementById('ref-scale-x') as HTMLInputElement;
            const scaleXValue = document.getElementById('ref-scale-x-value');
            const scaleYSlider = document.getElementById('ref-scale-y') as HTMLInputElement;
            const scaleYValue = document.getElementById('ref-scale-y-value');

            // Get scale values from either format
            const scaleX = data?.scale?.x ?? data?.scaleX ?? 1;
            const scaleY = data?.scale?.y ?? data?.scaleY ?? 1;

            // Update UI - separate X and Y sliders
            if (scaleXSlider) scaleXSlider.value = String(Math.round(scaleX * 100));
            if (scaleXValue) scaleXValue.textContent = `${Math.round(scaleX * 100)}%`;
            if (scaleYSlider) scaleYSlider.value = String(Math.round(scaleY * 100));
            if (scaleYValue) scaleYValue.textContent = `${Math.round(scaleY * 100)}%`;

            const offsetXInput = document.getElementById('ref-offset-x') as HTMLInputElement | null;
            const offsetYInput = document.getElementById('ref-offset-y') as HTMLInputElement | null;
            if (data?.offset) {
                if (offsetXInput) offsetXInput.value = String(Math.round(data.offset.x));
                if (offsetYInput) offsetYInput.value = String(Math.round(data.offset.y));
            }

            // Only apply to ALL frames when resize ENDS (has frameIndex)
            // This prevents applying wrong values when switching frames
            if (data?.frameIndex !== undefined) {
                this.applyScaleToAllFrames(scaleX, scaleY);
                if (data?.offset) {
                    this.applyOffsetToAllFrames(data.offset.x, data.offset.y);
                }
            }
        });

        // Toolbar events
        this._toolbar.on('action', (action: ToolbarAction) => {
            this.handleToolbarAction(action);
        });

        this._toolbar.on('fps-changed', (fps: number) => {
            this._project.animation.defaultFPS = fps;
            this._playback.fps = fps;
            this._project.markDirty();
        });

        // Playback events
        this._playback.on(EditorEvents.PLAYBACK_FRAME_CHANGED, (index: number) => {
            this.selectFrame(index, false);
            this._timeline.setPlayingIndex(index);
        });

        this._playback.on(EditorEvents.PLAYBACK_STOPPED, () => {
            this._toolbar.isPlaying = false;
            this._timeline.setPlayingIndex(-1);
        });
    }

    private setupMenuListeners(): void {
        ipcRenderer.on('menu-new-project', () => this.newProject());
        ipcRenderer.on('menu-open-project', () => this.openProject());
        ipcRenderer.on('menu-save-project', () => this.saveProject());
        ipcRenderer.on('menu-load-frames', () => this.loadFrames());
        ipcRenderer.on('menu-load-sheet', () => this.loadSheet());
        ipcRenderer.on('menu-export', () => this.exportMeta());
        ipcRenderer.on('menu-reset-zoom', () => this._canvas.resetView());
        ipcRenderer.on('menu-zoom-in', () => this._canvas.zoomIn());
        ipcRenderer.on('menu-zoom-out', () => this._canvas.zoomOut());
        ipcRenderer.on('menu-toggle-onion', () => this.toggleOnionSkin());
        ipcRenderer.on('menu-play-pause', () => this._playback.toggle());
        ipcRenderer.on('menu-prev-frame', () => this._playback.prevFrame());
        ipcRenderer.on('menu-next-frame', () => this._playback.nextFrame());
        ipcRenderer.on('menu-first-frame', () => this._playback.firstFrame());
        ipcRenderer.on('menu-last-frame', () => this._playback.lastFrame());
    }

    private setupUIListeners(): void {
        // Animation name
        const animNameInput = document.getElementById('anim-name') as HTMLInputElement;
        animNameInput?.addEventListener('change', () => {
            this._project.animation.name = animNameInput.value;
            this._project.markDirty();
        });

        // Animation FPS
        const animFpsInput = document.getElementById('anim-fps') as HTMLInputElement;
        animFpsInput?.addEventListener('change', () => {
            const fps = parseInt(animFpsInput.value) || 12;
            this._project.animation.defaultFPS = fps;
            this._playback.fps = fps;
            this._toolbar.setFPS(fps);
            this._project.markDirty();
        });

        // Animation loop
        const animLoopInput = document.getElementById('anim-loop') as HTMLInputElement;
        animLoopInput?.addEventListener('change', () => {
            this._project.animation.loop = animLoopInput.checked;
            this._playback.loop = animLoopInput.checked;
            this._project.markDirty();
        });

        // Export button - opens choice dialog
        const exportBtn = document.getElementById('btn-export');
        exportBtn?.addEventListener('click', () => this.showExportDialog());

        document.getElementById('btn-merge-import-json')?.addEventListener('click', () => this.importMergeAnimationParts());
        document.getElementById('btn-merge-export-json')?.addEventListener('click', () => this.exportMergedAnimationJson());

        // Export size inputs
        const exportWidth = document.getElementById('export-width') as HTMLInputElement;
        const exportHeight = document.getElementById('export-height') as HTMLInputElement;
        exportWidth?.addEventListener('change', () => {
            this._project.setNormalizedSize(
                parseInt(exportWidth.value) || 64,
                parseInt(exportHeight.value) || 64
            );
        });
        exportHeight?.addEventListener('change', () => {
            this._project.setNormalizedSize(
                parseInt(exportWidth.value) || 64,
                parseInt(exportHeight.value) || 64
            );
        });

        // Slice dialog
        this.setupSliceDialog();

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => this.handleKeyboard(e));
    }

    private setupSliceDialog(): void {
        const dialog = document.getElementById('slice-dialog');
        const cancelBtn = document.getElementById('slice-cancel');
        const confirmBtn = document.getElementById('slice-confirm');
        const widthInput = document.getElementById('slice-width') as HTMLInputElement;
        const heightInput = document.getElementById('slice-height') as HTMLInputElement;
        const colsInput = document.getElementById('slice-cols') as HTMLInputElement;
        const rowsInput = document.getElementById('slice-rows') as HTMLInputElement;

        // Load cached cols/rows values
        if (colsInput) colsInput.value = String(settings.get('sliceCols'));
        if (rowsInput) rowsInput.value = String(settings.get('sliceRows'));

        cancelBtn?.addEventListener('click', () => {
            dialog?.classList.add('hidden');
        });

        confirmBtn?.addEventListener('click', () => {
            if (this._sheetLoader) {
                const cols = parseInt(colsInput.value) || 1;
                const rows = parseInt(rowsInput.value) || 1;
                const cellWidth = Math.floor(this._sheetLoader.width / cols);
                const cellHeight = Math.floor(this._sheetLoader.height / rows);

                const config = { cellWidth, cellHeight };
                const frames = this._sheetLoader.sliceWithGrid(config);
                this.loadFramesToProject(frames);

                this._project.setSheetConfig({
                    gridWidth: cellWidth,
                    gridHeight: cellHeight,
                    columns: cols,
                    rows: rows
                });

                // Save to cache
                settings.set('sliceCols', cols);
                settings.set('sliceRows', rows);
            }
            dialog?.classList.add('hidden');
        });

        // When cols/rows change, auto-calculate cell size and update preview
        colsInput?.addEventListener('input', () => {
            this.updateSliceFromColsRows();
            settings.set('sliceCols', parseInt(colsInput.value) || 4);
        });
        rowsInput?.addEventListener('input', () => {
            this.updateSliceFromColsRows();
            settings.set('sliceRows', parseInt(rowsInput.value) || 1);
        });

        // When cell width/height change, auto-calculate cols/rows and update preview
        widthInput?.addEventListener('input', () => this.updateSliceFromCellSize());
        heightInput?.addEventListener('input', () => this.updateSliceFromCellSize());
    }

    private updateSliceFromColsRows(): void {
        if (!this._sheetLoader) return;

        const colsInput = document.getElementById('slice-cols') as HTMLInputElement;
        const rowsInput = document.getElementById('slice-rows') as HTMLInputElement;
        const widthInput = document.getElementById('slice-width') as HTMLInputElement;
        const heightInput = document.getElementById('slice-height') as HTMLInputElement;

        const colsValue = parseInt(colsInput.value, 10);
        const rowsValue = parseInt(rowsInput.value, 10);

        // 0 or NaN means auto - skip recalculating width/height
        const cols = isNaN(colsValue) || colsValue <= 0 ? null : colsValue;
        const rows = isNaN(rowsValue) || rowsValue <= 0 ? null : rowsValue;

        // Only auto-calculate cell size if both cols and rows are specified
        if (cols !== null && rows !== null) {
            const cellWidth = Math.floor(this._sheetLoader.width / cols);
            const cellHeight = Math.floor(this._sheetLoader.height / rows);

            widthInput.value = String(cellWidth);
            heightInput.value = String(cellHeight);
        }

        this.updateSlicePreview();
    }

    private updateSliceFromCellSize(): void {
        if (!this._sheetLoader) return;

        const widthInput = document.getElementById('slice-width') as HTMLInputElement;
        const heightInput = document.getElementById('slice-height') as HTMLInputElement;
        const colsInput = document.getElementById('slice-cols') as HTMLInputElement;
        const rowsInput = document.getElementById('slice-rows') as HTMLInputElement;

        const cellWidth = parseInt(widthInput.value) || 64;
        const cellHeight = parseInt(heightInput.value) || 64;

        // Auto-calculate cols/rows from cell size
        const cols = Math.floor(this._sheetLoader.width / cellWidth);
        const rows = Math.floor(this._sheetLoader.height / cellHeight);

        colsInput.value = String(cols);
        rowsInput.value = String(rows);

        this.updateSlicePreview();
    }

    // ========================================================================
    // Normalized Preview
    // ========================================================================

    private setupNormalizedPreview(): void {
        this._previewCanvas = document.getElementById('preview-canvas') as HTMLCanvasElement;
        if (this._previewCanvas) {
            this._previewCtx = this._previewCanvas.getContext('2d');
        }

        // Scale button handlers
        const scaleButtons = document.querySelectorAll('.preview-scale-btn');
        scaleButtons.forEach(btn => {
            btn.addEventListener('click', (e) => {
                const target = e.currentTarget as HTMLElement;
                const scale = parseInt(target.dataset.scale || '1');

                // Update active state
                scaleButtons.forEach(b => b.classList.remove('active'));
                target.classList.add('active');

                this._previewScale = scale;
                this.updateNormalizedPreview();
            });
        });

        // Update preview when export size changes
        const exportWidth = document.getElementById('export-width');
        const exportHeight = document.getElementById('export-height');
        exportWidth?.addEventListener('input', () => this.updateNormalizedPreview());
        exportHeight?.addEventListener('input', () => this.updateNormalizedPreview());

        // Setup drag, collapse, hide functionality
        this.setupPreviewDragAndControls();
    }

    private setupPreviewDragAndControls(): void {
        const panel = document.getElementById('normalized-preview');
        const dragHandle = document.getElementById('preview-drag-handle');
        const collapseBtn = document.getElementById('preview-collapse-btn');
        const hideBtn = document.getElementById('preview-hide-btn');

        if (!panel || !dragHandle) return;

        // Restore position from settings
        const savedPos = settings.get('previewPanelPosition') as { x: number; y: number } | null;
        if (savedPos) {
            panel.style.top = `${savedPos.y}px`;
            panel.style.left = `${savedPos.x}px`;
            panel.style.right = 'auto';
        }

        // Drag functionality
        let isDragging = false;
        let startX = 0;
        let startY = 0;
        let initialLeft = 0;
        let initialTop = 0;

        dragHandle.addEventListener('mousedown', (e) => {
            // Don't start drag if clicking on buttons
            if ((e.target as HTMLElement).closest('button')) return;

            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;

            const rect = panel.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;

            panel.style.right = 'auto';
            panel.style.left = `${initialLeft}px`;
            panel.style.top = `${initialTop}px`;

            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;

            const deltaX = e.clientX - startX;
            const deltaY = e.clientY - startY;

            const newLeft = Math.max(0, Math.min(window.innerWidth - 150, initialLeft + deltaX));
            const newTop = Math.max(0, Math.min(window.innerHeight - 100, initialTop + deltaY));

            panel.style.left = `${newLeft}px`;
            panel.style.top = `${newTop}px`;
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                // Save position
                settings.set('previewPanelPosition', {
                    x: parseInt(panel.style.left),
                    y: parseInt(panel.style.top)
                });
            }
        });

        // Collapse functionality
        collapseBtn?.addEventListener('click', () => {
            const isCollapsed = panel.classList.toggle('collapsed');
            collapseBtn.textContent = isCollapsed ? '▲' : '▼';
            collapseBtn.title = isCollapsed ? 'Expand' : 'Collapse';
        });

        // Hide functionality
        hideBtn?.addEventListener('click', () => {
            panel.classList.add('hidden');
            // Add show button to toolbar
            this.showPreviewShowButton();
        });
    }

    private showPreviewShowButton(): void {
        // Check if button already exists
        if (document.getElementById('preview-show-btn')) return;

        // Add a small button to canvas info bar to show preview again
        const canvasInfo = document.getElementById('canvas-info');
        if (canvasInfo) {
            const showBtn = document.createElement('button');
            showBtn.id = 'preview-show-btn';
            showBtn.textContent = '👁 Preview';
            showBtn.style.cssText = `
                background: var(--color-surface);
                border: 1px solid var(--color-border);
                color: var(--color-text-secondary);
                padding: 2px 8px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 11px;
            `;
            showBtn.addEventListener('click', () => {
                const panel = document.getElementById('normalized-preview');
                panel?.classList.remove('hidden');
                showBtn.remove();
            });
            canvasInfo.appendChild(showBtn);
        }
    }

    private updateNormalizedPreview(): void {
        if (!this._previewCanvas || !this._previewCtx) return;

        const frame = this._canvas['_currentFrame'] as Frame | null;
        if (!frame?.image?.element) {
            // Clear canvas if no frame
            this._previewCanvas.width = 64 * this._previewScale;
            this._previewCanvas.height = 64 * this._previewScale;
            this._previewCtx.fillStyle = 'rgba(0,0,0,0.3)';
            this._previewCtx.fillRect(0, 0, this._previewCanvas.width, this._previewCanvas.height);
            return;
        }

        // Get normalized (export) size
        const normWidth = this._project.exportSettings.normalizedSize.w;
        const normHeight = this._project.exportSettings.normalizedSize.h;

        // Apply scale
        const displayWidth = normWidth * this._previewScale;
        const displayHeight = normHeight * this._previewScale;

        this._previewCanvas.width = displayWidth;
        this._previewCanvas.height = displayHeight;

        const ctx = this._previewCtx;
        ctx.imageSmoothingEnabled = false; // Pixel-perfect

        // Calculate how to fit the frame into normalized size
        // Apply frame's stored scale to source dimensions
        const srcW = frame.sourceRect.w * frame.scale.x;
        const srcH = frame.sourceRect.h * frame.scale.y;

        // Scale to fit while maintaining aspect ratio
        const scaleX = normWidth / srcW;
        const scaleY = normHeight / srcH;
        const fitScale = Math.min(scaleX, scaleY);

        const destW = srcW * fitScale * this._previewScale;
        const destH = srcH * fitScale * this._previewScale;

        // Center in preview
        const destX = (displayWidth - destW) / 2;
        const destY = (displayHeight - destH) / 2;

        ctx.drawImage(
            frame.image.element,
            frame.sourceRect.x, frame.sourceRect.y,
            frame.sourceRect.w, frame.sourceRect.h,
            destX, destY,
            destW, destH
        );

        // Update size label
        const sizeLabel = document.getElementById('preview-size');
        if (sizeLabel) {
            sizeLabel.textContent = `${normWidth}×${normHeight}`;
        }
    }

    // ========================================================================
    // Actions
    // ========================================================================

    private handleToolbarAction(action: ToolbarAction): void {
        switch (action) {
            case 'load-frames':
                this.loadFrames();
                break;
            case 'load-sheet':
                this.loadSheet();
                break;
            case 'save-project':
                this.saveProject();
                break;
            case 'export':
                this.showExportDialog();
                break;
            case 'play-pause':
                if (this._isPlayerMode && this._playerController) {
                    this._playerController.toggle();
                    this._toolbar.isPlaying = this._playerController.isPlaying;
                } else {
                    this._playback.toggle();
                    this._toolbar.isPlaying = this._playback.isPlaying;
                }
                break;
            case 'prev-frame':
                this._playback.prevFrame();
                break;
            case 'next-frame':
                this._playback.nextFrame();
                break;
            case 'first-frame':
                this._playback.firstFrame();
                break;
            case 'last-frame':
                this._playback.lastFrame();
                break;
            case 'toggle-onion':
                this.toggleOnionSkin();
                break;
            case 'toggle-grid':
                this._canvas.showGrid = !this._canvas.showGrid;
                this._toolbar.gridEnabled = this._canvas.showGrid;
                break;
            case 'toggle-reference':
                this.toggleReferenceMode();
                break;
            case 'reset-view':
                this._canvas.resetView();
                break;
            case 'zoom-in':
                this._canvas.zoomIn();
                break;
            case 'zoom-out':
                this._canvas.zoomOut();
                break;
        }
    }

    private handleKeyboard(e: KeyboardEvent): void {
        // Don't capture if typing in input
        if ((e.target as HTMLElement).tagName === 'INPUT') return;

        switch (e.code) {
            case 'Space':
                e.preventDefault();
                if (this._isPlayerMode && this._playerController) {
                    this._playerController.toggle();
                    this._toolbar.isPlaying = this._playerController.isPlaying;
                } else {
                    this._playback.toggle();
                    this._toolbar.isPlaying = this._playback.isPlaying;
                }
                break;
            case 'ArrowLeft':
                this._playback.prevFrame();
                break;
            case 'ArrowRight':
                this._playback.nextFrame();
                break;
            case 'Home':
                this._playback.firstFrame();
                break;
            case 'End':
                this._playback.lastFrame();
                break;
            case 'KeyO':
                this.toggleOnionSkin();
                break;
            case 'KeyG':
                this._canvas.showGrid = !this._canvas.showGrid;
                this._toolbar.gridEnabled = this._canvas.showGrid;
                break;
            case 'KeyR':
                this.toggleReferenceMode();
                break;
        }
    }

    // ========================================================================
    // Frame Management
    // ========================================================================

    private selectFrame(index: number, updateTimeline: boolean = true): void {
        const frame = this._project.animation.getFrame(index);

        this._canvas.setPalettePreviewImage(null);
        this._canvas.setCurrentFrame(frame || null);
        this._pivotEditor.setFrame(frame || null);

        if (updateTimeline) {
            this._timeline.selectedIndex = index;
        }

        // Update onion skin frames
        if (this._canvas.showOnionSkin) {
            this.updateOnionSkinFrames(index);
        }

        // Update frame size display
        if (frame) {
            const sizeDisplay = document.getElementById('frame-size');
            if (sizeDisplay) {
                sizeDisplay.textContent = `${frame.sourceRect.w} x ${frame.sourceRect.h}`;
            }
        }

        // Update normalized preview
        this.updateNormalizedPreview();
        this.updatePaletteMatchPreview();
    }

    private updateOnionSkinFrames(currentIndex: number): void {
        const prev: Frame[] = [];
        const next: Frame[] = [];

        // Get previous frames
        for (let i = 1; i <= 2; i++) {
            const frame = this._project.animation.getFrame(currentIndex - i);
            if (frame) prev.push(frame);
        }

        // Get next frames
        for (let i = 1; i <= 2; i++) {
            const frame = this._project.animation.getFrame(currentIndex + i);
            if (frame) next.push(frame);
        }

        this._canvas.setOnionFrames(prev, next);
    }

    private toggleOnionSkin(): void {
        this._canvas.showOnionSkin = !this._canvas.showOnionSkin;
        this._toolbar.onionEnabled = this._canvas.showOnionSkin;

        if (this._canvas.showOnionSkin) {
            this.updateOnionSkinFrames(this._timeline.selectedIndex);
        }
    }

    private async loadReferenceImage(): Promise<void> {
        try {
            const result = await ipcRenderer.invoke(IPC_CHANNELS.OPEN_FILE_DIALOG, {
                title: 'Select Reference Image',
                filters: [
                    { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }
                ],
                properties: ['openFile']
            });

            if (result.canceled || !result.filePaths[0]) return;

            // Load the image with Promise to properly await
            const refImage = await new Promise<HTMLImageElement>((resolve, reject) => {
                const img = new Image();
                img.onload = () => {
                    this._canvas.setReferenceImage(img);
                    this._toolbar.referenceEnabled = true;
                    this._refImage = img; // Store reference image for offset calculation
                    resolve(img);
                };
                img.onerror = () => {
                    reject(new Error('Failed to load reference image'));
                };

                // Convert file path to file:// URL for loading
                const filePath = result.filePaths[0].replace(/\\/g, '/');
                img.src = `file:///${filePath}`;
            });

            this._paletteMatchOptions.referenceSource = 'loaded-reference';
            this.refreshPaletteReferencePicker();
            this._paletteCache = null;
            this.updatePaletteMatchPreview();

            // Check if reference matches frame 0 (same image, different size)
            await this.checkAutoScaleMatch(refImage);

        } catch (error) {
            console.error('Failed to load reference image:', error);
            alert(`Failed to load reference image: ${error}`);
        }
    }

    /**
     * Check if reference image matches frame 0 and offer auto-scale
     */
    private async checkAutoScaleMatch(refImage: HTMLImageElement): Promise<void> {
        const firstFrame = this._project.animation.getFrame(0);
        if (!firstFrame?.image?.element) return;

        const frameImage = firstFrame.image.element;

        // Compare images using perceptual hash
        const similarity = ImageFingerprint.compareImages(refImage, frameImage);
        const sizesDifferent = ImageFingerprint.sizesAreDifferent(refImage, frameImage);

        console.log(`[AutoScale] Similarity: ${(similarity * 100).toFixed(1)}%, Sizes different: ${sizesDifferent}`);

        // Always set targetSize from reference image dimensions
        // This ensures all animations can align to the same target size
        this._project.animation.targetSize = {
            w: refImage.naturalWidth,
            h: refImage.naturalHeight
        };
        console.log(`[AutoScale] Set targetSize: ${refImage.naturalWidth} × ${refImage.naturalHeight}`);

        // If images are similar (>90%) and sizes are different, offer auto-scale
        if (similarity >= 0.9 && sizesDifferent) {
            const scale = ImageFingerprint.calculateScaleToMatch(refImage, frameImage);
            const shouldAutoScale = await this.showAutoScaleDialog(refImage, frameImage, scale);

            if (shouldAutoScale) {
                this.applyAutoScale(scale.scaleX, scale.scaleY);
            }
        }
    }

    /**
     * Show auto-scale confirmation dialog and return user's choice
     */
    private showAutoScaleDialog(
        refImage: HTMLImageElement,
        frameImage: HTMLImageElement,
        scale: { scaleX: number; scaleY: number }
    ): Promise<boolean> {
        return new Promise((resolve) => {
            const dialog = document.getElementById('auto-scale-dialog');
            if (!dialog) {
                resolve(false);
                return;
            }

            // Update dialog content
            const refSizeEl = document.getElementById('auto-scale-ref-size');
            const frameSizeEl = document.getElementById('auto-scale-frame-size');
            const scaleFactorEl = document.getElementById('auto-scale-factor');

            if (refSizeEl) refSizeEl.textContent = `${refImage.naturalWidth} × ${refImage.naturalHeight}`;
            if (frameSizeEl) frameSizeEl.textContent = `${frameImage.naturalWidth} × ${frameImage.naturalHeight}`;
            if (scaleFactorEl) {
                // Show scale as percentage (uniform if same, otherwise show both)
                if (Math.abs(scale.scaleX - scale.scaleY) < 0.01) {
                    scaleFactorEl.textContent = `${Math.round(scale.scaleX * 100)}%`;
                } else {
                    scaleFactorEl.textContent = `${Math.round(scale.scaleX * 100)}% × ${Math.round(scale.scaleY * 100)}%`;
                }
            }

            // Show dialog
            dialog.classList.remove('hidden');

            // Handle button clicks
            const yesBtn = document.getElementById('auto-scale-yes');
            const noBtn = document.getElementById('auto-scale-no');

            const cleanup = () => {
                dialog.classList.add('hidden');
                yesBtn?.removeEventListener('click', onYes);
                noBtn?.removeEventListener('click', onNo);
            };

            const onYes = () => {
                cleanup();
                resolve(true);
            };

            const onNo = () => {
                cleanup();
                resolve(false);
            };

            yesBtn?.addEventListener('click', onYes);
            noBtn?.addEventListener('click', onNo);
        });
    }

    /**
     * Apply auto-scale to all frames and calculate offset for pivot alignment
     */
    private applyAutoScale(scaleX: number, scaleY: number): void {
        // Clamp scale to valid range
        const clampedX = Math.max(0.5, Math.min(2.0, scaleX));
        const clampedY = Math.max(0.5, Math.min(2.0, scaleY));

        // Apply to canvas
        this._canvas.setFrameScale(clampedX, clampedY);

        // Apply scale to all frames
        this.applyScaleToAllFrames(clampedX, clampedY);

        // Calculate offset to align pivot with reference
        if (this._refImage) {
            const firstFrame = this._project.animation.getFrame(0);
            if (firstFrame) {
                // Scaled dimensions of the frame
                const scaledW = firstFrame.sourceRect.w * clampedX;
                const scaledH = firstFrame.sourceRect.h * clampedY;

                // Reference dimensions
                const refW = this._refImage.naturalWidth;
                const refH = this._refImage.naturalHeight;

                // Calculate offset to align pivot points
                // When both images have same pivot (e.g., bottom-center 0.5, 1.0):
                // - Pivot in ref: refW * pivotX, refH * pivotY
                // - Pivot in scaled: scaledW * pivotX, scaledH * pivotY
                // - Offset needed: (refPivot - scaledPivot)
                const offsetX = (refW - scaledW) * this._refPivot.x;
                const offsetY = (refH - scaledH) * this._refPivot.y;

                // Apply offset to all frames
                this._canvas.setFrameOffset(offsetX, offsetY);
                this.applyOffsetToAllFrames(offsetX, offsetY);

                // Update offset UI
                const offsetXInput = document.getElementById('ref-offset-x') as HTMLInputElement;
                const offsetYInput = document.getElementById('ref-offset-y') as HTMLInputElement;
                if (offsetXInput) offsetXInput.value = String(Math.round(offsetX));
                if (offsetYInput) offsetYInput.value = String(Math.round(offsetY));

                console.log(`[AutoScale] Calculated offset for pivot (${this._refPivot.x}, ${this._refPivot.y}): (${Math.round(offsetX)}, ${Math.round(offsetY)})`);
            }
        }

        // Update UI sliders
        const scaleXSlider = document.getElementById('ref-scale-x') as HTMLInputElement;
        const scaleXValue = document.getElementById('ref-scale-x-value');
        const scaleYSlider = document.getElementById('ref-scale-y') as HTMLInputElement;
        const scaleYValue = document.getElementById('ref-scale-y-value');

        if (scaleXSlider) scaleXSlider.value = String(Math.round(clampedX * 100));
        if (scaleXValue) scaleXValue.textContent = `${Math.round(clampedX * 100)}%`;
        if (scaleYSlider) scaleYSlider.value = String(Math.round(clampedY * 100));
        if (scaleYValue) scaleYValue.textContent = `${Math.round(clampedY * 100)}%`;

        console.log(`[AutoScale] Applied scale: ${Math.round(clampedX * 100)}% × ${Math.round(clampedY * 100)}%`);
    }

    /**
     * Recalculate offset when pivot changes
     */
    private recalculateOffsetForPivot(): void {
        if (!this._refImage) return;

        const firstFrame = this._project.animation.getFrame(0);
        if (!firstFrame) return;

        // Get current scale
        const scaleX = firstFrame.scale?.x ?? 1;
        const scaleY = firstFrame.scale?.y ?? 1;

        // Scaled dimensions
        const scaledW = firstFrame.sourceRect.w * scaleX;
        const scaledH = firstFrame.sourceRect.h * scaleY;

        // Reference dimensions
        const refW = this._refImage.naturalWidth;
        const refH = this._refImage.naturalHeight;

        // Calculate offset based on pivot
        const offsetX = (refW - scaledW) * this._refPivot.x;
        const offsetY = (refH - scaledH) * this._refPivot.y;

        // Apply offset to all frames
        this._canvas.setFrameOffset(offsetX, offsetY);
        this.applyOffsetToAllFrames(offsetX, offsetY);

        // Update offset UI
        const offsetXInput = document.getElementById('ref-offset-x') as HTMLInputElement;
        const offsetYInput = document.getElementById('ref-offset-y') as HTMLInputElement;
        if (offsetXInput) offsetXInput.value = String(Math.round(offsetX));
        if (offsetYInput) offsetYInput.value = String(Math.round(offsetY));

        console.log(`[Pivot] Recalculated offset for pivot (${this._refPivot.x}, ${this._refPivot.y}): (${Math.round(offsetX)}, ${Math.round(offsetY)})`);
    }

    private toggleReferenceMode(): void {
        if (this._isReferenceMode) {
            this.exitReferenceMode();
        } else {
            this.enterReferenceMode();
        }
    }

    private async enterReferenceMode(): Promise<void> {
        // First, prompt user to load a reference image
        await this.loadReferenceImage();

        // If no reference was loaded, don't enter the mode
        if (!this._canvas.hasReference) {
            return;
        }

        this._isReferenceMode = true;
        this._toolbar.referenceEnabled = true;
        this._canvas.referenceModeEnabled = true;

        // Show the reference mode panel
        const panel = document.getElementById('reference-mode-panel');
        panel?.classList.remove('hidden');

        // Initialize slider value
        const opacitySlider = document.getElementById('ref-opacity') as HTMLInputElement;
        const opacityValue = document.getElementById('ref-opacity-value');
        if (opacitySlider && opacityValue) {
            opacitySlider.value = String(Math.round(this._canvas.referenceOpacity * 100));
            opacityValue.textContent = `${opacitySlider.value}%`;
        }
    }

    private exitReferenceMode(): void {
        this._isReferenceMode = false;
        this._toolbar.referenceEnabled = false;
        this._canvas.referenceModeEnabled = false;

        // Hide the reference mode panel
        const panel = document.getElementById('reference-mode-panel');
        panel?.classList.add('hidden');

        // Clear reference image
        this._canvas.clearReferenceImage();
    }

    private setupReferenceModeListeners(): void {
        // Opacity slider
        const opacitySlider = document.getElementById('ref-opacity') as HTMLInputElement;
        const opacityValue = document.getElementById('ref-opacity-value');
        if (opacitySlider && opacityValue) {
            opacitySlider.addEventListener('input', () => {
                const value = parseInt(opacitySlider.value, 10);
                opacityValue.textContent = `${value}%`;
                this._canvas.referenceOpacity = value / 100;
            });
        }

        // Mirror checkbox
        const mirrorCheckbox = document.getElementById('ref-mirror') as HTMLInputElement;
        if (mirrorCheckbox) {
            mirrorCheckbox.addEventListener('change', () => {
                this._refMirrorEnabled = mirrorCheckbox.checked;
            });
        }

        // Reference Pivot preset buttons
        const pivotXInput = document.getElementById('ref-pivot-x') as HTMLInputElement;
        const pivotYInput = document.getElementById('ref-pivot-y') as HTMLInputElement;
        const pivotCenterBtn = document.getElementById('ref-pivot-center');
        const pivotBottomBtn = document.getElementById('ref-pivot-bottom');
        const pivotTopBtn = document.getElementById('ref-pivot-top');

        const updatePivotUI = () => {
            if (pivotXInput) pivotXInput.value = String(this._refPivot.x);
            if (pivotYInput) pivotYInput.value = String(this._refPivot.y);

            // Update active button
            const isCenter = this._refPivot.x === 0.5 && this._refPivot.y === 0.5;
            const isBottom = this._refPivot.x === 0.5 && this._refPivot.y === 1.0;
            const isTop = this._refPivot.x === 0.5 && this._refPivot.y === 0.0;

            pivotCenterBtn?.classList.toggle('active', isCenter);
            pivotBottomBtn?.classList.toggle('active', isBottom);
            pivotTopBtn?.classList.toggle('active', isTop);
        };

        const onPivotChange = () => {
            // Recalculate offset based on new pivot if reference is loaded
            if (this._refImage) {
                this.recalculateOffsetForPivot();
            }
        };

        pivotCenterBtn?.addEventListener('click', () => {
            this._refPivot = { x: 0.5, y: 0.5 };
            updatePivotUI();
            onPivotChange();
        });

        pivotBottomBtn?.addEventListener('click', () => {
            this._refPivot = { x: 0.5, y: 1.0 };
            updatePivotUI();
            onPivotChange();
        });

        pivotTopBtn?.addEventListener('click', () => {
            this._refPivot = { x: 0.5, y: 0.0 };
            updatePivotUI();
            onPivotChange();
        });

        pivotXInput?.addEventListener('change', () => {
            this._refPivot.x = parseFloat(pivotXInput.value) || 0.5;
            this._refPivot.x = Math.max(0, Math.min(1, this._refPivot.x));
            updatePivotUI();
            onPivotChange();
        });

        pivotYInput?.addEventListener('change', () => {
            this._refPivot.y = parseFloat(pivotYInput.value) || 1.0;
            this._refPivot.y = Math.max(0, Math.min(1, this._refPivot.y));
            updatePivotUI();
            onPivotChange();
        });

        // Apply to All checkbox listener removed - scale/offset now always applies to all frames

        // Load Reference button (inside panel)
        const loadRefBtn = document.getElementById('btn-load-reference');
        if (loadRefBtn) {
            loadRefBtn.addEventListener('click', () => {
                this.loadReferenceImage();
            });
        }

        // Exit Reference Mode button
        const exitRefBtn = document.getElementById('btn-exit-reference');
        if (exitRefBtn) {
            exitRefBtn.addEventListener('click', () => {
                this.exitReferenceMode();
            });
        }

        // Frame Scale X slider - always applies to ALL frames
        const scaleXSlider = document.getElementById('ref-scale-x') as HTMLInputElement;
        const scaleXValue = document.getElementById('ref-scale-x-value');

        // Frame Scale Y slider - always applies to ALL frames
        const scaleYSlider = document.getElementById('ref-scale-y') as HTMLInputElement;
        const scaleYValue = document.getElementById('ref-scale-y-value');

        const updateScale = () => {
            const valueX = parseInt(scaleXSlider?.value || '100', 10);
            const valueY = parseInt(scaleYSlider?.value || '100', 10);
            const scaleX = valueX / 100;
            const scaleY = valueY / 100;

            // Apply scale to canvas (current frame visual)
            this._canvas.setFrameScale(scaleX, scaleY);
            if (scaleXValue) scaleXValue.textContent = `${valueX}%`;
            if (scaleYValue) scaleYValue.textContent = `${valueY}%`;

            // Always apply to ALL frames
            this.applyScaleToAllFrames(scaleX, scaleY);
        };

        scaleXSlider?.addEventListener('input', updateScale);
        scaleYSlider?.addEventListener('input', updateScale);

        // Frame Offset inputs
        const offsetX = document.getElementById('ref-offset-x') as HTMLInputElement;
        const offsetY = document.getElementById('ref-offset-y') as HTMLInputElement;

        const updateOffset = () => {
            const x = parseInt(offsetX?.value || '0', 10);
            const y = parseInt(offsetY?.value || '0', 10);
            this._canvas.setFrameOffset(x, y);

            // Always apply to ALL frames
            this.applyOffsetToAllFrames(x, y);
        };

        offsetX?.addEventListener('input', updateOffset);
        offsetY?.addEventListener('input', updateOffset);

        // Reset Scale & Offset button
        const resetBtn = document.getElementById('btn-reset-scale-offset');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                // Reset to defaults
                this._canvas.setFrameScale(1, 1);
                this._canvas.setFrameOffset(0, 0);
                this.applyScaleToAllFrames(1, 1);
                this.applyOffsetToAllFrames(0, 0);

                // Update UI - Scale X and Scale Y sliders
                if (scaleXSlider) scaleXSlider.value = '100';
                if (scaleXValue) scaleXValue.textContent = '100%';
                if (scaleYSlider) scaleYSlider.value = '100';
                if (scaleYValue) scaleYValue.textContent = '100%';
                if (offsetX) offsetX.value = '0';
                if (offsetY) offsetY.value = '0';
            });
        }

        // Reference Palette Match controls
        this.setupPaletteMatchListeners();
        // Context menu listeners
        this.setupContextMenuListeners();
    }

    private setupPaletteMatchListeners(): void {
        this.refreshPaletteReferencePicker();

        const enabled = document.getElementById('palette-match-enabled') as HTMLInputElement;
        const referenceSelect = document.getElementById('palette-reference-frame') as HTMLSelectElement;
        const paletteSize = document.getElementById('palette-size') as HTMLSelectElement;
        const strength = document.getElementById('palette-strength') as HTMLInputElement;
        const strengthValue = document.getElementById('palette-strength-value');
        const preserve = document.getElementById('palette-preserve-shading') as HTMLInputElement;
        const preserveValue = document.getElementById('palette-preserve-shading-value');
        const huePriority = document.getElementById('palette-hue-priority') as HTMLInputElement;
        const huePriorityValue = document.getElementById('palette-hue-priority-value');
        const alpha = document.getElementById('palette-alpha-threshold') as HTMLInputElement;
        const applyTo = document.getElementById('palette-apply-to') as HTMLSelectElement;
        const consistency = document.getElementById('palette-consistency') as HTMLSelectElement;

        const invalidateAndPreview = () => {
            this._paletteCache = null;
            this._palettePlanCache = null;
            this.readPaletteMatchOptionsFromUI();
            this.previewPaletteWhileTuning();
        };

        enabled?.addEventListener('change', () => {
            this.readPaletteMatchOptionsFromUI();
            this.previewPaletteWhileTuning();
        });
        referenceSelect?.addEventListener('change', invalidateAndPreview);
        paletteSize?.addEventListener('change', invalidateAndPreview);
        alpha?.addEventListener('change', invalidateAndPreview);
        consistency?.addEventListener('change', invalidateAndPreview);
        applyTo?.addEventListener('change', invalidateAndPreview);

        strength?.addEventListener('input', () => {
            strengthValue && (strengthValue.textContent = `${strength.value}%`);
            this.readPaletteMatchOptionsFromUI();
            this.previewPaletteWhileTuning();
        });

        preserve?.addEventListener('input', () => {
            preserveValue && (preserveValue.textContent = `${preserve.value}%`);
            this.readPaletteMatchOptionsFromUI();
            this.previewPaletteWhileTuning();
        });

        huePriority?.addEventListener('input', () => {
            huePriorityValue && (huePriorityValue.textContent = `${huePriority.value}%`);
            this.readPaletteMatchOptionsFromUI();
            this.previewPaletteWhileTuning();
        });

        document.getElementById('btn-preview-palette-match')?.addEventListener('click', () => {
            this._paletteCache = null;
            this._palettePlanCache = null;
            this.previewPaletteWhileTuning();
        });

        document.getElementById('btn-play-palette-preview')?.addEventListener('click', () => {
            this.togglePaletteAnimationPreview();
        });

        document.getElementById('btn-apply-palette-match')?.addEventListener('click', () => {
            this.applyPaletteMatchToTargetFrames();
        });
    }

    private refreshPaletteReferencePicker(): void {
        const select = document.getElementById('palette-reference-frame') as HTMLSelectElement | null;
        if (!select) return;

        const previous = this._paletteMatchOptions.referenceSource === 'loaded-reference'
            ? 'loaded-reference'
            : String(this._paletteMatchOptions.referenceIndex);
        select.innerHTML = '';

        if (this._refImage) {
            const option = document.createElement('option');
            option.value = 'loaded-reference';
            option.textContent = 'Loaded Reference Image';
            select.appendChild(option);
        }

        for (let i = 0; i < this._project.animation.frames.length; i++) {
            const option = document.createElement('option');
            option.value = String(i);
            option.textContent = `Sprite Frame ${i + 1}`;
            select.appendChild(option);
        }

        const fallback = this._refImage
            ? 'loaded-reference'
            : String(Math.min(this._paletteMatchOptions.referenceIndex, Math.max(0, this._project.animation.frames.length - 1)));
        select.value = Array.from(select.options).some(option => option.value === previous) ? previous : fallback;
        this._paletteMatchOptions.referenceSource = select.value === 'loaded-reference' ? 'loaded-reference' : 'frame';
        this._paletteMatchOptions.referenceIndex = this._paletteMatchOptions.referenceSource === 'frame'
            ? parseInt(select.value || '0', 10)
            : this._paletteMatchOptions.referenceIndex;
    }

    private readPaletteMatchOptionsFromUI(): void {
        const enabled = document.getElementById('palette-match-enabled') as HTMLInputElement | null;
        const referenceSelect = document.getElementById('palette-reference-frame') as HTMLSelectElement | null;
        const paletteSize = document.getElementById('palette-size') as HTMLSelectElement | null;
        const strength = document.getElementById('palette-strength') as HTMLInputElement | null;
        const preserve = document.getElementById('palette-preserve-shading') as HTMLInputElement | null;
        const huePriority = document.getElementById('palette-hue-priority') as HTMLInputElement | null;
        const alpha = document.getElementById('palette-alpha-threshold') as HTMLInputElement | null;
        const applyTo = document.getElementById('palette-apply-to') as HTMLSelectElement | null;
        const consistency = document.getElementById('palette-consistency') as HTMLSelectElement | null;

        const referenceValue = referenceSelect?.value || (this._refImage ? 'loaded-reference' : '0');
        const referenceSource = referenceValue === 'loaded-reference' ? 'loaded-reference' : 'frame';

        this._paletteMatchOptions = {
            enabled: Boolean(enabled?.checked),
            referenceSource,
            referenceIndex: referenceSource === 'frame'
                ? Math.max(0, parseInt(referenceValue, 10) || 0)
                : this._paletteMatchOptions.referenceIndex,
            paletteSize: (parseInt(paletteSize?.value || '32', 10) as PaletteSize) || 32,
            strength: Math.max(0, Math.min(1, (parseInt(strength?.value || '65', 10) || 0) / 100)),
            preserveShading: Math.max(0, Math.min(1, (parseInt(preserve?.value || '75', 10) || 0) / 100)),
            // "Hue Priority" is the intuitive inverse of lightnessTolerance:
            // high priority => ignore lightness differences when matching parts.
            lightnessTolerance: Math.max(0, Math.min(1, 1 - (parseInt(huePriority?.value || '50', 10) || 0) / 100)),
            alphaThreshold: Math.max(0, Math.min(255, parseInt(alpha?.value || '10', 10) || 0)),
            applyTo: (applyTo?.value as 'current' | 'selected' | 'all') || 'all',
            protectTransparent: true,
            paletteConsistency: (consistency?.value as PaletteConsistencyMode) || 'global_sheet'
        };
    }

    private getPaletteMatchTargetIndices(): number[] {
        const frames = this._project.animation.frames;
        if (frames.length === 0) return [];
        if (this._paletteMatchOptions.applyTo === 'all') return frames.map((_, index) => index);

        const selected = Math.max(0, Math.min(frames.length - 1, this._timeline.selectedIndex));
        return [selected];
    }

    /**
     * Build (and cache) the shared cross-frame palette plan for the current
     * mode. Returns null for `per_frame` (which uses the per-frame path). The
     * cache key covers everything that changes the plan - the reference palette
     * signature, the mode, the hue/lightness weighting and the target frames'
     * identity - so live tuning of strength/preserve-shading reuses one plan
     * (fast) while a reference / palette-size / frame change rebuilds it. Using
     * this exact plan for the preview guarantees preview == applied result.
     */
    private getPaletteMatchPlan(palette: ReferencePalette): PaletteMatchPlan | null {
        const mode = this._paletteMatchOptions.paletteConsistency;
        if (mode === 'per_frame') return null;

        const allFrames = this._project.animation.frames;
        const targets = this.getPaletteMatchTargetIndices();
        const targetsSig = targets
            .map(i => {
                const r = allFrames[i]?.sourceRect;
                return r ? `${i}:${r.x},${r.y},${r.w},${r.h}` : `${i}:x`;
            })
            .join(';');
        const key = [
            this._paletteCache?.key ?? 'nokey',
            mode,
            this._paletteMatchOptions.lightnessTolerance,
            targetsSig
        ].join('|');

        if (this._palettePlanCache?.key === key) return this._palettePlanCache.plan;

        const sourceByIndex = allFrames.map(frame => SpritesheetExporter.getFrameImageData(frame));
        const placeholder = new ImageData(1, 1);
        const dense = sourceByIndex.map(data => data ?? placeholder);
        const effectiveTargets = targets.filter(index => sourceByIndex[index] != null);

        const plan = buildPaletteMatchPlan(dense, palette, {
            ...this._paletteMatchOptions,
            targetIndices: effectiveTargets,
            paletteConsistency: mode
        });
        this._palettePlanCache = { key, plan };
        return plan;
    }

    private getReferencePalette(): ReferencePalette | null {
        this.readPaletteMatchOptionsFromUI();

        let referenceData: ImageData | null = null;
        let sourceKey = '';

        if (this._paletteMatchOptions.referenceSource === 'loaded-reference') {
            referenceData = this.getLoadedReferenceImageData();
            if (this._refImage) {
                sourceKey = `loaded-reference:${this._refImage.src}:${this._refImage.naturalWidth}x${this._refImage.naturalHeight}`;
            }
        } else {
            const frame = this._project.animation.getFrame(this._paletteMatchOptions.referenceIndex);
            if (!frame) return null;
            referenceData = SpritesheetExporter.getFrameImageData(frame);
            sourceKey = [
                'frame',
                this._paletteMatchOptions.referenceIndex,
                frame.sourceFile,
                frame.sourceRect.x,
                frame.sourceRect.y,
                frame.sourceRect.w,
                frame.sourceRect.h
            ].join(':');
        }

        if (!referenceData) return null;

        const cacheKey = [
            sourceKey,
            this._paletteMatchOptions.paletteSize,
            this._paletteMatchOptions.alphaThreshold
        ].join(':');

        if (this._paletteCache?.key === cacheKey) return this._paletteCache.palette;

        const palette = extractReferencePalette(referenceData, this._paletteMatchOptions);
        this._paletteCache = { key: cacheKey, palette };
        return palette;
    }

    private getLoadedReferenceImageData(): ImageData | null {
        if (!this._refImage) return null;
        const canvas = document.createElement('canvas');
        canvas.width = this._refImage.naturalWidth;
        canvas.height = this._refImage.naturalHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return null;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(this._refImage, 0, 0);
        return ctx.getImageData(0, 0, canvas.width, canvas.height);
    }

    private getPaletteReferenceImageData(): ImageData | null {
        this.readPaletteMatchOptionsFromUI();

        if (this._paletteMatchOptions.referenceSource === 'loaded-reference') {
            return this.getLoadedReferenceImageData();
        }

        const referenceFrame = this._project.animation.getFrame(this._paletteMatchOptions.referenceIndex);
        return referenceFrame ? SpritesheetExporter.getFrameImageData(referenceFrame) : null;
    }

    /**
     * Refresh the palette preview as a direct result of the user adjusting a
     * palette control. Temporarily forces the large on-canvas overlay on (even
     * if the export toggle is off) so the effect is clearly visible while
     * tuning; the overlay is cleared again on the next frame navigation.
     */
    private previewPaletteWhileTuning(): void {
        this._paletteTuning = true;
        try {
            this.updatePaletteMatchPreview();
        } finally {
            this._paletteTuning = false;
        }
    }

    private updatePaletteMatchPreview(frameIndex: number = this._timeline.selectedIndex): void {
        const frame = this._project.animation.getFrame(Math.max(0, frameIndex));
        if (!frame) return;

        const before = SpritesheetExporter.getFrameImageData(frame);
        if (!before) return;

        this.readPaletteMatchOptionsFromUI();

        // Compute the matched result for the side-by-side preview cells live,
        // regardless of the "Enabled" export toggle, so adjusting any control
        // (strength, hue priority, reference, ...) immediately shows its effect.
        // The large on-canvas overlay still only appears when the effect is
        // enabled, so normal frame editing isn't unexpectedly recolored.
        // Only do the (relatively heavy) palette work when the effect is
        // engaged - either enabled for export, or being actively previewed /
        // tuned - so normal frame navigation stays cheap for projects that do
        // not use palette matching. When engaged, the cells AND the on-canvas
        // overlay update live as controls change.
        const engaged = this._paletteMatchOptions.enabled || this._paletteTuning;
        const palette = engaged ? this.getReferencePalette() : null;
        const hasPalette = !!palette && palette.colors.length > 0;
        // Use the SAME shared cross-frame plan the full apply will use (for
        // global_sheet / reference_locked) so the preview matches the applied
        // result exactly. Falls back to the per-frame path for `per_frame`.
        let after = before;
        if (hasPalette) {
            const plan = this.getPaletteMatchPlan(palette as ReferencePalette);
            after = plan
                ? applyPaletteMatchPlan(before, plan, this._paletteMatchOptions)
                : applyPaletteMatch(before, palette as ReferencePalette, this._paletteMatchOptions);
        }

        if (frameIndex === this._timeline.selectedIndex) {
            this._canvas.setPalettePreviewImage(hasPalette ? SpritesheetExporter.imageDataToCanvas(after) : null);
        }

        const reference = this.getPaletteReferenceImageData();
        if (reference) {
            this.drawImageDataPreview('palette-preview-reference', reference);
        } else {
            this.clearImageDataPreview('palette-preview-reference', 'No reference');
        }
        this.drawImageDataPreview('palette-preview-before', before);
        this.drawImageDataPreview('palette-preview-after', after);
        this.drawImageDataPreview('palette-animation-preview', after);
    }

    private drawImageDataPreview(canvasId: string, imageData: ImageData): void {
        const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Size the backing store to the element's displayed box (× device pixel
        // ratio) so the preview is crisp and keeps the sprite's aspect ratio,
        // instead of being stretched by CSS from a fixed 128×96 buffer.
        const dpr = window.devicePixelRatio || 1;
        const cssW = Math.max(1, canvas.clientWidth || 128);
        const cssH = Math.max(1, canvas.clientHeight || 96);
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        ctx.imageSmoothingEnabled = false;
        this.drawCheckerboard(ctx, cssW, cssH, 8);
        const source = SpritesheetExporter.imageDataToCanvas(imageData);
        const scale = Math.min(cssW / imageData.width, cssH / imageData.height);
        const w = Math.max(1, Math.floor(imageData.width * scale));
        const h = Math.max(1, Math.floor(imageData.height * scale));
        const x = Math.floor((cssW - w) / 2);
        const y = Math.floor((cssH - h) / 2);
        ctx.drawImage(source, x, y, w, h);
    }

    private clearImageDataPreview(canvasId: string, message: string): void {
        const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const dpr = window.devicePixelRatio || 1;
        const cssW = Math.max(1, canvas.clientWidth || 128);
        const cssH = Math.max(1, canvas.clientHeight || 96);
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        this.drawCheckerboard(ctx, cssW, cssH, 8);
        ctx.fillStyle = '#9ca3af';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(message, cssW / 2, cssH / 2);
    }


    private drawCheckerboard(ctx: CanvasRenderingContext2D, width: number, height: number, size: number): void {
        for (let y = 0; y < height; y += size) {
            for (let x = 0; x < width; x += size) {
                ctx.fillStyle = ((x / size + y / size) % 2 === 0) ? '#242424' : '#303030';
                ctx.fillRect(x, y, size, size);
            }
        }
    }

    private togglePaletteAnimationPreview(): void {
        const btn = document.getElementById('btn-play-palette-preview');
        if (this._palettePreviewAnimationTimer !== null) {
            window.clearInterval(this._palettePreviewAnimationTimer);
            this._palettePreviewAnimationTimer = null;
            if (btn) btn.textContent = 'Play Preview';
            return;
        }

        if (btn) btn.textContent = 'Stop Preview';
        this._palettePreviewFrameIndex = 0;
        const fps = Math.max(1, this._project.animation.defaultFPS || 12);
        this._palettePreviewAnimationTimer = window.setInterval(() => {
            const count = this._project.animation.frameCount;
            if (count === 0) return;
            this._paletteTuning = true;
            this.updatePaletteMatchPreview(this._palettePreviewFrameIndex % count);
            this._paletteTuning = false;
            this._palettePreviewFrameIndex++;
        }, Math.max(33, Math.round(1000 / fps)));
    }

    private async applyPaletteMatchToTargetFrames(): Promise<void> {
        const palette = this.getReferencePalette();
        if (!palette || palette.colors.length === 0) {
            alert('Reference frame does not contain enough visible pixels for palette matching.');
            return;
        }

        const targetIndices = this.getPaletteMatchTargetIndices();
        if (targetIndices.length === 0) return;

        let changedFrames = 0;
        let changedPixels = 0;

        // Rasterize every frame so the palette mapping can be shared across the
        // whole animation (global_sheet) -> stable colors with no per-frame
        // flicker, while each frame keeps its own shading.
        const allFrames = this._project.animation.frames;
        const sourceByIndex = allFrames.map(frame => SpritesheetExporter.getFrameImageData(frame));
        const placeholder = new ImageData(1, 1);
        const dense = sourceByIndex.map(data => data ?? placeholder);
        const effectiveTargets = targetIndices.filter(index => sourceByIndex[index] != null);
        if (effectiveTargets.length === 0) return;

        const matchedByIndex = applyPaletteMatchAcrossFrames(dense, palette, {
            ...this._paletteMatchOptions,
            targetIndices: effectiveTargets,
            paletteConsistency: this._paletteMatchOptions.paletteConsistency
        });

        for (const index of effectiveTargets) {
            const frame = allFrames[index];
            if (!frame) continue;
            const sourceData = sourceByIndex[index];
            const matched = matchedByIndex[index];
            if (!sourceData || !matched) continue;

            const diffPixels = this.countChangedOpaquePixels(sourceData, matched);
            if (diffPixels > 0) {
                changedFrames++;
                changedPixels += diffPixels;
            }
            await this.replaceFrameImageWithImageData(frame, matched);
        }

        this._paletteCache = null;
        this._palettePlanCache = null;
        this._canvas.setPalettePreviewImage(null);
        this._canvas.render();
        this.updateNormalizedPreview();
        this.updatePaletteMatchPreview();
        this._project.markDirty();
        globalEvents.emit(EditorEvents.ANIMATION_UPDATED);

        if (changedPixels === 0) {
            alert('Reference Palette Match ran, but no visible pixels changed. Try lowering Alpha Threshold or increasing Color Match Strength.');
        } else {
            alert(`Reference Palette Match applied to ${changedFrames}/${targetIndices.length} frame(s). Changed ${changedPixels.toLocaleString()} visible pixels.`);
        }
    }

    private countChangedOpaquePixels(before: ImageData, after: ImageData): number {
        const threshold = this._paletteMatchOptions.alphaThreshold;
        let count = 0;
        for (let i = 0; i < before.data.length; i += 4) {
            if (before.data[i + 3] <= threshold) continue;
            const dr = Math.abs(before.data[i] - after.data[i]);
            const dg = Math.abs(before.data[i + 1] - after.data[i + 1]);
            const db = Math.abs(before.data[i + 2] - after.data[i + 2]);
            if (dr + dg + db >= 3) count++;
        }
        return count;
    }
    private async replaceFrameImageWithImageData(frame: Frame, imageData: ImageData): Promise<void> {
        const canvas = SpritesheetExporter.imageDataToCanvas(imageData);
        const dataUrl = canvas.toDataURL('image/png');
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
            const next = new Image();
            next.onload = () => resolve(next);
            next.onerror = () => reject(new Error('Failed to create palette matched frame image'));
            next.src = dataUrl;
        });

        (frame as any)._image = {
            element: img,
            width: imageData.width,
            height: imageData.height,
            loaded: true
        };
        frame.sourceRect = { x: 0, y: 0, w: imageData.width, h: imageData.height };
    }

    private getPaletteMatchExportOptions() {
        this.readPaletteMatchOptionsFromUI();
        return {
            enabled: this._paletteMatchOptions.enabled && this._project.animation.frameCount > 0,
            referenceIndex: this._paletteMatchOptions.referenceIndex,
            referenceImageData: this._paletteMatchOptions.referenceSource === 'loaded-reference'
                ? this.getLoadedReferenceImageData() ?? undefined
                : undefined,
            paletteSize: this._paletteMatchOptions.paletteSize,
            strength: this._paletteMatchOptions.strength,
            preserveShading: this._paletteMatchOptions.preserveShading,
            lightnessTolerance: this._paletteMatchOptions.lightnessTolerance,
            alphaThreshold: this._paletteMatchOptions.alphaThreshold,
            targetIndices: this.getPaletteMatchTargetIndices(),
            paletteConsistency: this._paletteMatchOptions.paletteConsistency
        };
    }
    // ========================================================================
    // Context Menu
    // ========================================================================

    private _contextMenuFrameIndex: number = -1;

    private setupContextMenuListeners(): void {
        const menu = document.getElementById('frame-context-menu');
        if (!menu) return;

        menu.querySelectorAll('.context-menu-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = (item as HTMLElement).dataset.action;
                this.handleContextMenuAction(action || '');
                this.hideFrameContextMenu();
            });
        });
    }

    private showFrameContextMenu(index: number, x: number, y: number): void {
        this._contextMenuFrameIndex = index;
        const menu = document.getElementById('frame-context-menu');
        if (!menu) return;

        menu.classList.remove('hidden');
        menu.style.left = `${x}px`;
        menu.style.top = `${y}px`;

        // Adjust if menu goes off screen
        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            menu.style.left = `${x - rect.width}px`;
        }
        if (rect.bottom > window.innerHeight) {
            menu.style.top = `${y - rect.height}px`;
        }
    }

    private hideFrameContextMenu(): void {
        const menu = document.getElementById('frame-context-menu');
        menu?.classList.add('hidden');
    }

    private handleContextMenuAction(action: string): void {
        const index = this._contextMenuFrameIndex;
        if (index < 0) return;

        switch (action) {
            case 'export-slice':
                this.exportSlice(index);
                break;
            case 'duplicate':
                this.duplicateFrame(index);
                break;
            case 'delete':
                this.deleteFrame(index);
                break;
        }
    }

    private async exportSlice(index: number): Promise<void> {
        const frame = this._project.animation.getFrame(index);
        if (!frame || !frame.image?.element) {
            alert('No frame to export');
            return;
        }

        try {
            const result = await ipcRenderer.invoke(IPC_CHANNELS.SAVE_FILE_DIALOG, {
                title: `Export Slice ${index}`,
                defaultPath: `slice_${index}.png`,
                filters: [{ name: 'PNG Image', extensions: ['png'] }]
            });

            if (result.canceled || !result.filePath) return;

            // Create canvas and draw slice
            const canvas = document.createElement('canvas');
            canvas.width = frame.sourceRect.w;
            canvas.height = frame.sourceRect.h;
            const ctx = canvas.getContext('2d');
            if (!ctx) return;

            ctx.drawImage(
                frame.image.element,
                frame.sourceRect.x, frame.sourceRect.y,
                frame.sourceRect.w, frame.sourceRect.h,
                0, 0,
                frame.sourceRect.w, frame.sourceRect.h
            );

            // Convert to data URL and save
            const dataUrl = canvas.toDataURL('image/png');
            const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
            await ipcRenderer.invoke(IPC_CHANNELS.WRITE_FILE, {
                filePath: result.filePath,
                data: base64Data,
                encoding: 'base64'
            });

            console.log(`Exported slice ${index} to ${result.filePath}`);
        } catch (error) {
            console.error('Failed to export slice:', error);
            alert(`Failed to export slice: ${error}`);
        }
    }

    private duplicateFrame(index: number): void {
        const frame = this._project.animation.getFrame(index);
        if (!frame) return;

        const clone = frame.clone();
        this._project.animation.insertFrame(clone, index + 1);
        this._timeline.refreshFrameList();
        this._timeline.selectedIndex = index + 1;
        this._project.markDirty();
    }

    private deleteFrame(index: number): void {
        if (this._project.animation.frameCount <= 1) {
            alert('Cannot delete the last frame');
            return;
        }

        this._project.animation.removeFrame(index);
        this._timeline.refreshFrameList();

        // Select previous frame if possible
        const newIndex = Math.min(index, this._project.animation.frameCount - 1);
        this._timeline.selectedIndex = newIndex;
        this.selectFrame(newIndex);
        this._project.markDirty();
    }

    // ========================================================================
    // Resizable Layout
    // ========================================================================

    private setupInteractiveEditor(): void {
        const container = document.getElementById('interactive-editor');
        if (!container) return;
        this._interactiveEditor = new InteractiveEditor({
            container,
            canvas: this._canvas,
            getProject: () => this._project,
            getSelectedFrameIndex: () => this._timeline.selectedIndex,
            markDirty: () => this._project.markDirty()
        });
    }
    private setupResizableLayout(): void {
        const panelHandle = document.getElementById('panel-resize-handle');
        const rightPanel = document.getElementById('right-panel');
        const canvasArea = document.getElementById('canvas-area');

        if (!panelHandle || !rightPanel || !canvasArea) return;

        let isResizing = false;
        let startX = 0;
        let startWidth = 0;

        panelHandle.addEventListener('mousedown', (e) => {
            isResizing = true;
            startX = e.clientX;
            startWidth = rightPanel.offsetWidth;
            panelHandle.classList.add('active');
            document.body.style.cursor = 'ew-resize';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;

            const delta = startX - e.clientX;
            const newWidth = Math.max(200, Math.min(500, startWidth + delta));

            rightPanel.style.width = `${newWidth}px`;
            settings.set('rightPanelWidth', newWidth);

            // Trigger canvas resize
            this._canvas.resize();
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                panelHandle.classList.remove('active');
                document.body.style.cursor = '';
            }
        });
    }

    private applySettings(): void {
        // Apply saved layout
        const rightPanel = document.getElementById('right-panel');
        if (rightPanel) {
            rightPanel.style.width = `${settings.get('rightPanelWidth')}px`;
        }

        // Apply view settings
        this._canvas.showGrid = settings.get('gridEnabled');
        this._toolbar.gridEnabled = settings.get('gridEnabled');
        this._canvas.showOnionSkin = settings.get('onionSkinEnabled');
        this._toolbar.onionEnabled = settings.get('onionSkinEnabled');

        // Apply FPS
        const fpsInput = document.getElementById('fps-input') as HTMLInputElement;
        if (fpsInput) {
            fpsInput.value = String(settings.get('fps'));
            this._playback.fps = settings.get('fps');
        }
    }

    private loadFramesToProject(frames: Frame[]): void {
        this._project.animation.clearFrames();
        this._project.animation.addFrames(frames);

        this._timeline.setAnimation(this._project.animation);
        this._playback.setAnimation(this._project.animation);

        if (frames.length > 0) {
            this.selectFrame(0);
            this._canvas.zoomToFit();
        }

        this.updateUIFromProject();
        this._interactiveEditor?.resetForProject();
        this.refreshPaletteReferencePicker();
        this._paletteCache = null;
        this.updatePaletteMatchPreview();
        this._project.markDirty();
    }

    // ========================================================================
    // File Operations
    // ========================================================================

    private async loadFrames(): Promise<void> {
        try {
            const result = await ipcRenderer.invoke(IPC_CHANNELS.OPEN_FOLDER_DIALOG);
            if (result.canceled || !result.filePaths[0]) return;

            const folderPath = result.filePaths[0];
            const loaderResult = await FrameLoader.loadFromFolder(folderPath);

            // Load images
            for (const frame of loaderResult.frames) {
                await frame.loadImage(loaderResult.basePath);
            }

            this._project.setSource('frames', loaderResult.basePath, loaderResult.files);
            this.loadFramesToProject(loaderResult.frames);

        } catch (error) {
            console.error('Failed to load frames:', error);
            alert(`Failed to load frames: ${error}`);
        }
    }

    private async loadSheet(): Promise<void> {
        try {
            const result = await ipcRenderer.invoke(IPC_CHANNELS.OPEN_FILE_DIALOG, {
                title: 'Select Sprite Sheet',
                filters: [
                    { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }
                ],
                properties: ['openFile']
            });

            if (result.canceled || !result.filePaths[0]) return;

            this._sheetLoader = new SheetLoader();
            const sheetResult = await this._sheetLoader.loadFromPath(result.filePaths[0]);

            this._project.setSource('sheet', sheetResult.basePath, [sheetResult.filename]);

            // Auto-set project and animation name from sprite sheet filename
            const baseName = sheetResult.filename.replace(/\.[^/.]+$/, ''); // Remove extension
            this._project.name = baseName;
            this._project.animation.name = baseName;

            // Update UI
            const animNameInput = document.getElementById('anim-name') as HTMLInputElement;
            if (animNameInput) animNameInput.value = baseName;

            // Show slice dialog
            this.showSliceDialog();

        } catch (error) {
            console.error('Failed to load sprite sheet:', error);
            alert(`Failed to load sprite sheet: ${error}`);
        }
    }

    private showSliceDialog(): void {
        const dialog = document.getElementById('slice-dialog');
        dialog?.classList.remove('hidden');

        if (this._sheetLoader) {
            const widthInput = document.getElementById('slice-width') as HTMLInputElement;
            const heightInput = document.getElementById('slice-height') as HTMLInputElement;
            const colsInput = document.getElementById('slice-cols') as HTMLInputElement;
            const rowsInput = document.getElementById('slice-rows') as HTMLInputElement;

            // Try to guess columns/rows from suggested cell sizes
            const suggested = this._sheetLoader.getSuggestedCellSizes();
            let cols = 8; // Default
            let rows = 1;

            if (suggested.length > 0) {
                cols = Math.floor(this._sheetLoader.width / suggested[0].width);
                rows = Math.floor(this._sheetLoader.height / suggested[0].height);
            } else {
                // Guess based on aspect ratio - assume square cells
                const aspectRatio = this._sheetLoader.width / this._sheetLoader.height;
                if (aspectRatio > 4) {
                    // Wide image - likely horizontal strip
                    cols = Math.round(aspectRatio);
                    rows = 1;
                } else if (aspectRatio > 1) {
                    cols = Math.round(Math.sqrt(aspectRatio) * 4);
                    rows = Math.round(cols / aspectRatio);
                } else {
                    // Tall or square - likely multiple rows
                    rows = Math.round(1 / aspectRatio);
                    cols = 1;
                }
            }

            // Ensure at least 1
            cols = Math.max(1, cols);
            rows = Math.max(1, rows);

            // Set cols/rows first
            colsInput.value = String(cols);
            rowsInput.value = String(rows);

            // Calculate cell size from cols/rows
            const cellWidth = Math.floor(this._sheetLoader.width / cols);
            const cellHeight = Math.floor(this._sheetLoader.height / rows);
            widthInput.value = String(cellWidth);
            heightInput.value = String(cellHeight);

            this.updateSlicePreview();
        }
    }

    private updateSlicePreview(): void {
        if (!this._sheetLoader?.image) return;

        const canvas = document.getElementById('slice-preview-canvas') as HTMLCanvasElement;
        if (!canvas) return;

        const widthInput = document.getElementById('slice-width') as HTMLInputElement;
        const heightInput = document.getElementById('slice-height') as HTMLInputElement;

        const cellWidth = parseInt(widthInput.value) || 64;
        const cellHeight = parseInt(heightInput.value) || 64;

        // Draw preview
        canvas.width = this._sheetLoader.width;
        canvas.height = this._sheetLoader.height;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        ctx.drawImage(this._sheetLoader.image, 0, 0);

        // Draw grid overlay
        ctx.strokeStyle = 'rgba(79, 195, 247, 0.8)';
        ctx.lineWidth = 1;

        for (let x = 0; x <= this._sheetLoader.width; x += cellWidth) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, this._sheetLoader.height);
            ctx.stroke();
        }

        for (let y = 0; y <= this._sheetLoader.height; y += cellHeight) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(this._sheetLoader.width, y);
            ctx.stroke();
        }

        // Update columns/rows display
        const colsInput = document.getElementById('slice-cols') as HTMLInputElement;
        const rowsInput = document.getElementById('slice-rows') as HTMLInputElement;
        colsInput.value = String(Math.floor(this._sheetLoader.width / cellWidth));
        rowsInput.value = String(Math.floor(this._sheetLoader.height / cellHeight));
    }

    private newProject(): void {
        if (this._project.isDirty) {
            if (!confirm('You have unsaved changes. Create new project anyway?')) {
                return;
            }
        }

        this._project = Project.createNew('untitled');
        this._timeline.setAnimation(null);
        this._playback.setAnimation(null);
        this._canvas.setCurrentFrame(null);
        this._pivotEditor.setFrame(null);
        this.updateUIFromProject();
        this._interactiveEditor?.resetForProject();
    }

    private async openProject(): Promise<void> {
        try {
            const result = await ipcRenderer.invoke(IPC_CHANNELS.OPEN_FILE_DIALOG, {
                title: 'Open Project',
                filters: [
                    { name: 'Mobik Project', extensions: ['mobik', 'json'] }
                ],
                properties: ['openFile']
            });

            if (result.canceled || !result.filePaths[0]) return;

            const json = await ipcRenderer.invoke(IPC_CHANNELS.READ_FILE, result.filePaths[0]);
            const rawMeta = JSON.parse(json);
            this._project = MetaExporter.import(json);
            this._project.setFilePath(result.filePaths[0]);

            // Reload images
            await this._project.animation.loadAllImages(this._project.source.basePath);

            this._timeline.setAnimation(this._project.animation);
            this._playback.setAnimation(this._project.animation);

            if (this._project.animation.frameCount > 0) {
                this.selectFrame(0);
            }

            this.updateUIFromProject();
            this._interactiveEditor?.setFromMeta(rawMeta);
            this.refreshPaletteReferencePicker();
            this._paletteCache = null;
            this.updatePaletteMatchPreview();

        } catch (error) {
            console.error('Failed to open project:', error);
            alert(`Failed to open project: ${error}`);
        }
    }

    private async saveProject(): Promise<void> {
        try {
            let filePath = this._project.filePath;

            if (!filePath) {
                const result = await ipcRenderer.invoke(IPC_CHANNELS.SAVE_FILE_DIALOG, {
                    title: 'Save Project',
                    defaultPath: `${this._project.name}.mobik`,
                    filters: [
                        { name: 'Mobik Project', extensions: ['mobik'] }
                    ]
                });

                if (result.canceled) return;
                filePath = result.filePath;
            }

            const json = this._project.toJSON();
            await ipcRenderer.invoke(IPC_CHANNELS.WRITE_FILE, filePath, json);

            this._project.setFilePath(filePath!);
            this._project.clearDirty();

        } catch (error) {
            console.error('Failed to save project:', error);
            alert(`Failed to save project: ${error}`);
        }
    }

    // ========================================================================
    // Merge Animation Parts
    // ========================================================================

    private async importMergeAnimationParts(): Promise<void> {
        try {
            const result = await ipcRenderer.invoke(IPC_CHANNELS.OPEN_FILE_DIALOG, {
                title: 'Import Animation Part JSON',
                filters: [{ name: 'Meta JSON', extensions: ['json'] }],
                properties: ['openFile', 'multiSelections']
            });

            if (result.canceled || !result.filePaths?.length) return;

            for (const metaPath of result.filePaths) {
                await this.addMergeAnimationPartFromPath(metaPath);
            }

            this.renderMergePartsList();
            this.syncPlayerSlotOrderWithMergeParts();
            this.renderPlayerMode();
        } catch (error) {
            console.error('Failed to import merge parts:', error);
            alert(`Failed to import merge parts: ${error}`);
        }
    }

    private async addMergeAnimationPartFromPath(metaPath: string): Promise<void> {
        const part = await this.loadMergeAnimationPart(metaPath);
        if (!part) return;

        if (this._mergeExportFps === null) this._mergeExportFps = part.fps;

        if (this._playerController && part.spriteSheets[0]) {
            const slot = await this._playerController.addSlot(part.spriteSheets[0].path, metaPath);
            slot.name = part.name;
            part.slotId = slot.id;
        }

        this._mergeParts.push(part);
    }

    private async loadMergeAnimationPart(metaPath: string): Promise<MergeAnimationPart | null> {
        const metaJson = fs.readFileSync(metaPath, 'utf-8');
        const rawMeta = JSON.parse(metaJson);
        const parsed = MetaParser.parseObject(rawMeta);
        const dir = path.dirname(metaPath);
        const mergedFps = this._mergeExportFps || parsed.fps || this._project.animation.defaultFPS || 12;
        const spriteSheets = new Map<string, { filename: string; path: string }>();

        const frames: RuntimeFrame[] = parsed.frames.map((frame) => {
            const filename = path.basename(frame.sourceFile || rawMeta.spriteSheet || rawMeta.meta?.image || 'spritesheet.png');
            const spritePath = this.resolveMergeSpriteSheetPath(dir, frame.sourceFile || filename, rawMeta);
            spriteSheets.set(filename, { filename, path: spritePath });

            return {
                src: filename,
                rect: [frame.sourceRect.x, frame.sourceRect.y, frame.sourceRect.w, frame.sourceRect.h],
                pivot: [frame.pivot.x, frame.pivot.y],
                offset: [frame.offset.x, frame.offset.y],
                scale: [frame.scale.x, frame.scale.y],
                dur: Math.max(0.001, (frame.duration / parsed.fps) * mergedFps)
            };
        });

        await this.resolveCompactMergeFrames(rawMeta, frames, Array.from(spriteSheets.values()));

        return {
            id: `merge_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            metaPath,
            name: parsed.name || path.basename(metaPath, path.extname(metaPath)),
            fps: parsed.fps,
            frameCount: frames.length,
            frames,
            spriteSheets: Array.from(spriteSheets.values()),
            targetSize: rawMeta.animation?.targetSize
        };
    }

    private getMergeExportFps(): number {
        return Math.max(1, this._mergeExportFps || this._project.animation.defaultFPS || 12);
    }

    private resolveMergeSpriteSheetPath(dir: string, sourceFile: string, rawMeta: any): string {
        const candidates = [
            sourceFile,
            path.basename(sourceFile || ''),
            rawMeta.spriteSheet,
            rawMeta.meta?.image,
            rawMeta.source?.files?.[0]
        ].filter(Boolean);

        for (const candidate of candidates) {
            const candidatePath = path.isAbsolute(candidate) ? candidate : path.join(dir, candidate);
            if (fs.existsSync(candidatePath)) return candidatePath;
        }

        return path.join(dir, path.basename(sourceFile || rawMeta.spriteSheet || 'spritesheet.png'));
    }

    private async resolveCompactMergeFrames(rawMeta: any, frames: RuntimeFrame[], spriteSheets: { filename: string; path: string }[]): Promise<void> {
        const grid = rawMeta.animation?.grid;
        if (!grid || frames.length === 0 || frames.some(frame => frame.rect[2] > 0 && frame.rect[3] > 0)) return;

        const sheet = spriteSheets[0];
        if (!sheet || !fs.existsSync(sheet.path)) return;

        const size = await this.loadImageSize(sheet.path);
        const cellW = Math.floor(size.width / grid.columns);
        const cellH = Math.floor(size.height / grid.rows);

        frames.forEach((frame, index) => {
            const col = index % grid.columns;
            const row = Math.floor(index / grid.columns);
            frame.rect = [col * cellW, row * cellH, cellW, cellH];
            frame.src = sheet.filename;
        });
    }

    private async loadImageSize(filePath: string): Promise<{ width: number; height: number }> {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
            img.onerror = () => reject(new Error(`Failed to load spritesheet: ${filePath}`));
            img.src = `file:///${filePath.replace(/\\/g, '/')}`;
        });
    }

    private renderMergePartsList(): void {
        const list = document.getElementById('merge-parts-list');
        if (!list) return;

        list.innerHTML = '';
        if (this._mergeParts.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'merge-empty';
            empty.textContent = 'No JSON parts imported';
            list.appendChild(empty);
            return;
        }

        this._mergeParts.forEach((part, index) => {
            const item = document.createElement('div');
            item.className = 'merge-part-item';

            const number = document.createElement('div');
            number.className = 'merge-part-index';
            number.textContent = String(index + 1);

            const info = document.createElement('div');
            const title = document.createElement('div');
            title.className = 'merge-part-title';
            title.textContent = part.name;
            const meta = document.createElement('div');
            meta.className = 'merge-part-meta';
            meta.textContent = `${part.frameCount} frames | ${Math.round(part.fps * 100) / 100} fps | ${path.basename(part.metaPath)}`;
            info.append(title, meta);

            const controls = document.createElement('div');
            controls.className = 'merge-part-controls';
            controls.append(
                this.createMergePartButton('↑', () => this.moveMergePart(index, -1), index === 0),
                this.createMergePartButton('↓', () => this.moveMergePart(index, 1), index === this._mergeParts.length - 1),
                this.createMergePartButton('×', () => this.removeMergePart(index))
            );

            item.append(number, info, controls);
            list.appendChild(item);
        });
    }

    private createMergePartButton(label: string, onClick: () => void, disabled: boolean = false): HTMLButtonElement {
        const button = document.createElement('button');
        button.className = 'btn btn-secondary btn-sm';
        button.textContent = label;
        button.disabled = disabled;
        button.addEventListener('click', onClick);
        return button;
    }

    private moveMergePart(index: number, direction: number): void {
        const next = index + direction;
        if (next < 0 || next >= this._mergeParts.length) return;
        const [part] = this._mergeParts.splice(index, 1);
        this._mergeParts.splice(next, 0, part);
        this.renderMergePartsList();
        this.syncPlayerSlotOrderWithMergeParts();
        this.renderPlayerMode();
    }

    private removeMergePart(index: number): void {
        const [part] = this._mergeParts.splice(index, 1);
        if (part?.slotId) this._playerController?.removeSlot(part.slotId);
        if (this._mergeParts.length === 0) this._mergeExportFps = null;
        this.renderMergePartsList();
        this.syncPlayerSlotOrderWithMergeParts();
        this.renderPlayerMode();
    }

    private syncPlayerSlotOrderWithMergeParts(): void {
        const slotIds = this._mergeParts
            .map(part => part.slotId)
            .filter((slotId): slotId is string => Boolean(slotId));
        this._playerController?.setSlotOrder(slotIds);
    }

    private async exportMergedAnimationJson(): Promise<void> {
        if (this._mergeParts.length === 0) {
            alert('Import at least one JSON part before exporting a merged animation.');
            return;
        }

        const result = await ipcRenderer.invoke(IPC_CHANNELS.SAVE_FILE_DIALOG, {
            title: 'Export Merged Animation JSON',
            defaultPath: `${this.sanitizeFilename(this._mergeParts.map(part => part.name).join('_')) || 'merged'}_merged.json`,
            filters: [{ name: 'JSON', extensions: ['json'] }]
        });

        if (result.canceled || !result.filePath) return;

        const exportDir = path.dirname(result.filePath);
        const mergedFps = this.getMergeExportFps();
        const targetSize = this._mergeParts.find(part => part.targetSize)?.targetSize;
        const pathToExportName = new Map<string, string>();
        const usedFilenames = new Set<string>();
        const frames: RuntimeFrame[] = [];

        for (const part of this._mergeParts) {
            const sheetNameMap = new Map<string, string>();
            for (const sheet of part.spriteSheets) {
                const resolvedSheetPath = path.resolve(sheet.path);
                let exportName = pathToExportName.get(resolvedSheetPath);
                if (!exportName) {
                    exportName = this.getUniqueMergeSpriteFilename(sheet.filename, usedFilenames);
                    pathToExportName.set(resolvedSheetPath, exportName);
                    usedFilenames.add(exportName.toLowerCase());
                    this.copyMergeSpriteSheet(sheet.path, path.join(exportDir, exportName));
                }
                sheetNameMap.set(sheet.filename, exportName);
            }

            for (const frame of part.frames) {
                frames.push({
                    ...frame,
                    src: sheetNameMap.get(frame.src) || frame.src
                });
            }
        }

        const mergedMeta = {
            version: '1.1',
            spriteSheets: Array.from(pathToExportName.values()),
            animation: {
                name: this.sanitizeFilename(this._mergeParts.map(part => part.name).join('_')) || 'merged_animation',
                fps: mergedFps,
                loop: this._project.animation.loop,
                frameCount: frames.length,
                frames,
                ...(targetSize && { targetSize })
            }
        };

        await ipcRenderer.invoke(IPC_CHANNELS.WRITE_FILE, result.filePath, JSON.stringify(mergedMeta, null, 2));
        alert(`Merged animation exported.\nParts: ${this._mergeParts.length}\nFrames: ${frames.length}\nSpritesheets: ${pathToExportName.size}`);
    }

    private getUniqueMergeSpriteFilename(filename: string, used: Set<string>): string {
        const ext = path.extname(filename) || '.png';
        const base = this.sanitizeFilename(path.basename(filename, ext)) || 'spritesheet';
        let candidate = `${base}${ext}`;
        let index = 2;
        while (used.has(candidate.toLowerCase())) {
            candidate = `${base}_${index}${ext}`;
            index++;
        }
        return candidate;
    }

    private copyMergeSpriteSheet(sourcePath: string, targetPath: string): void {
        if (!fs.existsSync(sourcePath)) {
            throw new Error(`Spritesheet not found: ${sourcePath}`);
        }
        if (path.resolve(sourcePath).toLowerCase() === path.resolve(targetPath).toLowerCase()) return;
        fs.copyFileSync(sourcePath, targetPath);
    }

    private sanitizeFilename(name: string): string {
        return name
            .toLowerCase()
            .replace(/\.[^/.\\]+$/, '')
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_|_$/g, '');
    }

    // ========================================================================
    // Export Dialog
    // ========================================================================

    private showExportDialog(): void {
        const dialog = document.getElementById('export-dialog');
        dialog?.classList.remove('hidden');

        // Setup button handlers (remove old listeners by cloning)
        const metaBtn = document.getElementById('export-meta-btn');
        const spritesheetBtn = document.getElementById('export-spritesheet-btn');
        const bundleBtn = document.getElementById('export-bundle-btn');
        const interactiveBtn = document.getElementById('export-interactive-btn');
        const cancelBtn = document.getElementById('export-cancel');

        const closeDialog = () => dialog?.classList.add('hidden');

        // Clone to remove old handlers
        if (metaBtn) {
            const newMetaBtn = metaBtn.cloneNode(true) as HTMLElement;
            metaBtn.parentNode?.replaceChild(newMetaBtn, metaBtn);
            newMetaBtn.addEventListener('click', () => {
                closeDialog();
                this.exportMeta();
            });
        }

        if (spritesheetBtn) {
            const newSpritesheetBtn = spritesheetBtn.cloneNode(true) as HTMLElement;
            spritesheetBtn.parentNode?.replaceChild(newSpritesheetBtn, spritesheetBtn);
            newSpritesheetBtn.addEventListener('click', () => {
                closeDialog();
                this.exportScaledSpritesheet(false);
            });
        }

        if (bundleBtn) {
            const newBundleBtn = bundleBtn.cloneNode(true) as HTMLElement;
            bundleBtn.parentNode?.replaceChild(newBundleBtn, bundleBtn);
            newBundleBtn.addEventListener('click', () => {
                closeDialog();
                this.exportScaledSpritesheet(true);
            });
        }

        cancelBtn?.addEventListener('click', closeDialog, { once: true });
    }

    private async exportMeta(): Promise<void> {
        try {
            // Validate
            const errors = MetaExporter.validate(this._project);
            if (errors.length > 0) {
                const messages = errors.map(e => `${e.field}: ${e.message}`).join('\n');
                alert(`Validation errors:\n${messages}`);
                return;
            }

            const result = await ipcRenderer.invoke(IPC_CHANNELS.SAVE_FILE_DIALOG, {
                title: 'Export Meta JSON',
                defaultPath: MetaExporter.generateFilename(this._project),
                filters: [
                    { name: 'JSON', extensions: ['json'] }
                ]
            });

            if (result.canceled) return;

            const exportResult = MetaExporter.export(this._project, true, this._colorAdj);
            await ipcRenderer.invoke(IPC_CHANNELS.WRITE_FILE, result.filePath, exportResult.json);

            alert(`Exported successfully!\nFile size: ${round(exportResult.size / 1024, 2)} KB`);

        } catch (error) {
            console.error('Failed to export:', error);
            alert(`Failed to export: ${error}`);
        }
    }

    private async exportInteractiveMascot(): Promise<void> {
        try {
            const errors = MetaExporter.validate(this._project);
            if (errors.length > 0) {
                const messages = errors.map(e => e.field + ': ' + e.message).join('\n');
                alert('Validation errors:\n' + messages);
                return;
            }

            const result = await ipcRenderer.invoke(IPC_CHANNELS.SAVE_FILE_DIALOG, {
                title: 'Export Interactive Mascot JSON',
                defaultPath: this.generateInteractiveMascotFilename(),
                filters: [
                    { name: 'Mobik Interactive JSON', extensions: ['json'] }
                ]
            });

            if (result.canceled) return;

            const exportJson = this.buildInteractiveMascotJson();
            await ipcRenderer.invoke(IPC_CHANNELS.WRITE_FILE, result.filePath, exportJson);
            const size = new Blob([exportJson]).size;
            alert('Interactive mascot exported!\nFile size: ' + round(size / 1024, 2) + ' KB');
        } catch (error) {
            console.error('Failed to export interactive mascot:', error);
            alert('Failed to export interactive mascot: ' + error);
        }
    }

    private buildInteractiveMascotJson(): string {
        const legacy = MetaExporter.export(this._project, false, this._colorAdj).data as any;
        const animationName = legacy.animation?.name || 'default';
        const snapshot = this._interactiveEditor?.getSnapshot();
        const interactive = snapshot?.config || {
            defaultState: 'idle',
            defaultTransitionMs: 120,
            states: {
                idle: { type: 'clip', animation: animationName, priority: 0, loop: legacy.animation?.loop ?? true, interruptible: true }
            },
            events: {},
            hitAreas: [],
            pointerTracking: { enabled: false, mode: 'angle', thresholdPx: 24, debounceMs: 80 },
            idleBehavior: { enabled: false, inactiveAfterMs: 5000, minDelayMs: 4000, maxDelayMs: 12000, pool: [{ state: 'idle', weight: 1 }] },
            queues: {},
            rules: [],
            debug: { enabled: false }
        };

        const data = {
            ...legacy,
            format: 'mobik-interactive-mascot',
            source: {
                ...legacy.source,
                basePath: '.'
            },
            spriteSheet: legacy.source?.files?.[0] || null,
            animations: {
                [animationName]: legacy.animation
            },
            poseSets: snapshot?.poseSets || {},
            interactive
        };

        return JSON.stringify(data, null, 2);
    }
    private generateInteractiveMascotFilename(): string {
        const sourceName = this._project.source.files[0]
            ? this._project.source.files[0].replace(/\.[^/.\\]+$/, '')
            : this._project.name;
        const name = sourceName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_|_$/g, '');
        return (name || 'untitled') + '_interactive.mobik.json';
    }
    private async exportScaledSpritesheet(writeCompanionMeta: boolean = false): Promise<void> {
        try {
            // Validate
            const errors = MetaExporter.validate(this._project);
            if (errors.length > 0) {
                const messages = errors.map(e => `${e.field}: ${e.message}`).join('\n');
                alert(`Validation errors:\n${messages}`);
                return;
            }

            // Generate scaled spritesheet with Reference Palette Match baked in.
            const paletteMatch = this.getPaletteMatchExportOptions();
            const spritesheetResult = SpritesheetExporter.generateScaledSpritesheet(
                this._project,
                { ...this._colorAdj, paletteMatch }
            );

            if (!spritesheetResult) {
                alert('Failed to generate spritesheet. Make sure frames are loaded.');
                return;
            }

            if (paletteMatch.enabled && !spritesheetResult.paletteMatchApplied) {
                alert('Reference Palette Match was enabled but could not be applied. Load a reference image in Reference Mode or choose a valid reference frame before exporting.');
                return;
            }

            if (paletteMatch.enabled && (spritesheetResult.paletteMatchChangedPixels ?? 0) === 0) {
                alert('Reference Palette Match exported 0 changed pixels. Increase Color Match Strength, lower Preserve Shading, or make sure the reference image colors differ from the sprite.');
                return;
            }

            // Ask user where to save
            const result = await ipcRenderer.invoke(IPC_CHANNELS.SAVE_FILE_DIALOG, {
                title: 'Export Scaled Spritesheet',
                defaultPath: SpritesheetExporter.generateFilename(this._project),
                filters: [
                    { name: 'PNG Image', extensions: ['png'] }
                ]
            });

            if (result.canceled) return;

            // Convert canvas to base64 and save
            const base64Data = SpritesheetExporter.canvasToBase64(spritesheetResult.canvas);
            await ipcRenderer.invoke(IPC_CHANNELS.WRITE_FILE, {
                filePath: result.filePath,
                data: base64Data,
                encoding: 'base64'
            });

            let companionMetaPath = '';
            if (writeCompanionMeta) {
                companionMetaPath = path.join(path.dirname(result.filePath), MetaExporter.generateFilename(this._project));
                const companionMeta = this.buildScaledSpritesheetMeta(result.filePath, spritesheetResult);
                await ipcRenderer.invoke(IPC_CHANNELS.WRITE_FILE, companionMetaPath, companionMeta);
            }

            // Build color info summary
            const referenceLabel = this._paletteMatchOptions.referenceSource === 'loaded-reference'
                ? 'loaded reference image'
                : `sprite frame ${this._paletteMatchOptions.referenceIndex + 1}`;
            const colorInfo = paletteMatch.enabled
                ? `Reference Palette Match: ${referenceLabel}, ` +
                    `${this._paletteMatchOptions.paletteSize} colors, ` +
                    `strength ${Math.round(this._paletteMatchOptions.strength * 100)}%, ` +
                    `shading ${Math.round(this._paletteMatchOptions.preserveShading * 100)}%, ` +
                    `${(spritesheetResult.paletteMatchChangedPixels ?? 0).toLocaleString()} pixels changed`
                : 'Reference Palette Match: disabled';

            const fileSize = Math.ceil(base64Data.length * 0.75);
            alert(
                `Scaled spritesheet exported!\n` +
                `Size: ${spritesheetResult.frameWidth}×${spritesheetResult.frameHeight} per frame\n` +
                `Layout: ${spritesheetResult.columns}×${spritesheetResult.rows} (${spritesheetResult.totalFrames} frames)\n` +
                `File: ~${round(fileSize / 1024, 1)} KB\n` +
                (writeCompanionMeta ? `Meta: ${path.basename(companionMetaPath)}\n` : '') +
                `Color: ${colorInfo}`
            );

        } catch (error) {
            console.error('Failed to export scaled spritesheet:', error);
            alert(`Failed to export: ${error}`);
        }
    }

    private buildScaledSpritesheetMeta(spritesheetPath: string, spritesheetResult: { frameWidth: number; frameHeight: number; columns: number; rows: number; totalFrames: number }): string {
        const filename = path.basename(spritesheetPath);
        const frames = this._project.animation.frames.map((frame, index) => {
            const col = index % spritesheetResult.columns;
            const row = Math.floor(index / spritesheetResult.columns);
            return {
                src: filename,
                rect: [
                    col * spritesheetResult.frameWidth,
                    row * spritesheetResult.frameHeight,
                    spritesheetResult.frameWidth,
                    spritesheetResult.frameHeight
                ],
                pivot: [frame.pivot.x, frame.pivot.y],
                offset: [frame.offset.x, frame.offset.y],
                scale: [1, 1],
                dur: frame.duration
            };
        });

        const meta = {
            version: '1.1',
            spriteSheet: filename,
            animation: {
                name: this._project.animation.name,
                fps: this._project.animation.defaultFPS,
                loop: this._project.animation.loop,
                frameCount: spritesheetResult.totalFrames,
                frames,
                ...(this._project.animation.targetSize && { targetSize: this._project.animation.targetSize })
            }
        };

        return JSON.stringify(meta, null, 2);
    }

    // ========================================================================
    // Color Adjustment Helpers
    // ========================================================================

    /**
     * Update canvas color filter from current _colorAdj values
     */
    private _updateCanvasFilter(): void {
        if (this._canvas) {
            const filterStr = SpritesheetExporter.buildFilterString(this._colorAdj);
            this._canvas.colorFilter = filterStr;
        }
    }

    /**
     * Sync all color slider UI elements to current _colorAdj values
     */
    private _syncColorSlidersUI(sliders: { id: string, valueId: string, key: string, suffix?: string }[]): void {
        for (const cfg of sliders) {
            const slider = document.getElementById(cfg.id) as HTMLInputElement;
            const valueEl = document.getElementById(cfg.valueId);
            const val = (this._colorAdj as any)[cfg.key] ?? 0;
            if (slider) slider.value = String(val);
            if (valueEl) valueEl.textContent = String(val) + (cfg.suffix || '');
        }
    }

    /**
     * Auto-adjust colors to match first frame with reference image.
     * Analyzes average brightness, contrast, and saturation of both images.
     */
    private _autoAdjustColors(): void {
        const refImage = this._refImage;
        const firstFrame = this._project.animation.frames[0];

        if (!refImage) {
            alert('No reference image loaded. Import a reference image first.');
            return;
        }
        if (!firstFrame?.image?.element) {
            alert('No frame loaded. Load a spritesheet first.');
            return;
        }

        // Sample both images
        const refStats = this._analyzeImageStats(refImage);
        const frameStats = this._analyzeFrameStats(firstFrame);

        if (!refStats || !frameStats) {
            alert('Cannot analyze images.');
            return;
        }

        // Calculate adjustments
        // Brightness: map ratio to -50..+50 slider range
        const brightRatio = refStats.avgBrightness / Math.max(frameStats.avgBrightness, 0.01);
        const brightnessAdj = Math.round(Math.max(-50, Math.min(50, (brightRatio - 1) * 100)));

        // Contrast: compare spread (stddev of luminance)
        const contrastRatio = refStats.stdBrightness / Math.max(frameStats.stdBrightness, 0.01);
        const contrastAdj = Math.round(Math.max(-50, Math.min(50, (contrastRatio - 1) * 100)));

        // Saturation: compare average saturation
        const satRatio = refStats.avgSaturation / Math.max(frameStats.avgSaturation, 0.01);
        const satAdj = Math.round(Math.max(-100, Math.min(100, (satRatio - 1) * 100)));

        this._colorAdj = {
            brightness: brightnessAdj,
            contrast: contrastAdj,
            saturation: satAdj,
            hue: 0, // Hue shift requires complex analysis, keep at 0
            invert: 0
        };
    }

    /**
     * Analyze image statistics: avg brightness, std brightness, avg saturation
     */
    private _analyzeImageStats(img: HTMLImageElement): { avgBrightness: number; stdBrightness: number; avgSaturation: number } | null {
        const canvas = document.createElement('canvas');
        const maxSize = 128; // Downsample for speed
        const scale = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight));
        canvas.width = Math.floor(img.naturalWidth * scale);
        canvas.height = Math.floor(img.naturalHeight * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        return this._computePixelStats(data);
    }

    /**
     * Analyze frame statistics (just the frame's source rect)
     */
    private _analyzeFrameStats(frame: Frame): { avgBrightness: number; stdBrightness: number; avgSaturation: number } | null {
        if (!frame.image?.element) return null;
        const canvas = document.createElement('canvas');
        const maxSize = 128;
        const sr = frame.sourceRect;
        const scale = Math.min(1, maxSize / Math.max(sr.w, sr.h));
        canvas.width = Math.floor(sr.w * scale);
        canvas.height = Math.floor(sr.h * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        ctx.drawImage(frame.image.element, sr.x, sr.y, sr.w, sr.h, 0, 0, canvas.width, canvas.height);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        return this._computePixelStats(data);
    }

    /**
     * Compute brightness + saturation stats from raw pixel data
     */
    private _computePixelStats(data: Uint8ClampedArray): { avgBrightness: number; stdBrightness: number; avgSaturation: number } {
        let totalBright = 0;
        let totalSat = 0;
        let count = 0;
        const brightValues: number[] = [];

        for (let i = 0; i < data.length; i += 4) {
            const r = data[i] / 255;
            const g = data[i + 1] / 255;
            const b = data[i + 2] / 255;
            const a = data[i + 3] / 255;

            if (a < 0.1) continue; // Skip transparent pixels

            // Luminance (perceived brightness)
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            totalBright += lum;
            brightValues.push(lum);

            // Saturation (HSL-style)
            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            const sat = max === 0 ? 0 : (max - min) / max;
            totalSat += sat;

            count++;
        }

        if (count === 0) return { avgBrightness: 0.5, stdBrightness: 0.1, avgSaturation: 0.5 };

        const avgBrightness = totalBright / count;
        const avgSaturation = totalSat / count;

        // Standard deviation of brightness
        let sumSq = 0;
        for (const v of brightValues) {
            sumSq += (v - avgBrightness) ** 2;
        }
        const stdBrightness = Math.sqrt(sumSq / count);

        return { avgBrightness, stdBrightness, avgSaturation };
    }

    // ========================================================================
    // UI Updates
    // ========================================================================

    private updateUIFromProject(): void {
        const animNameInput = document.getElementById('anim-name') as HTMLInputElement;
        const animFpsInput = document.getElementById('anim-fps') as HTMLInputElement;
        const animLoopInput = document.getElementById('anim-loop') as HTMLInputElement;
        const exportWidth = document.getElementById('export-width') as HTMLInputElement;
        const exportHeight = document.getElementById('export-height') as HTMLInputElement;

        if (animNameInput) animNameInput.value = this._project.animation.name;
        if (animFpsInput) animFpsInput.value = String(this._project.animation.defaultFPS);
        if (animLoopInput) animLoopInput.checked = this._project.animation.loop;
        if (exportWidth) exportWidth.value = String(this._project.exportSettings.normalizedSize.w);
        if (exportHeight) exportHeight.value = String(this._project.exportSettings.normalizedSize.h);

        this._toolbar.setFPS(this._project.animation.defaultFPS);
        this._playback.fps = this._project.animation.defaultFPS;
        this._playback.loop = this._project.animation.loop;
    }

    private updateZoomDisplay(zoom: number): void {
        const zoomDisplay = document.getElementById('zoom-level');
        if (zoomDisplay) {
            zoomDisplay.textContent = `${Math.round(zoom * 100)}%`;
        }
    }

    // ========================================================================
    // Player Mode
    // ========================================================================

    private setupPlayerMode(): void {
        // Mode toggle button
        const modeToggleBtn = document.getElementById('mode-toggle-btn');
        modeToggleBtn?.addEventListener('click', () => this.togglePlayerMode());

        const mergeModeToggleBtn = document.getElementById('merge-mode-toggle-btn');
        mergeModeToggleBtn?.addEventListener('click', () => this.toggleMergeMode());
    }

    togglePlayerMode(): void {
        if (this._playerModeKind === 'player') {
            this.exitPlayerMode();
        } else {
            this.enterPlayerMode('player');
        }
    }

    toggleMergeMode(): void {
        if (this._playerModeKind === 'merge') {
            this.exitPlayerMode();
        } else {
            this.enterPlayerMode('merge');
        }
    }

    private enterPlayerMode(kind: 'player' | 'merge' = 'player'): void {
        if (this._isPlayerMode) this.exitPlayerMode();
        this._isPlayerMode = true;
        this._playerModeKind = kind;

        // Create player controller if needed
        if (!this._playerController) {
            this._playerController = new PlayerModeController();
        }

        // Setup player canvas if needed
        if (!this._playerCanvas) {
            this._playerCanvas = document.getElementById('player-canvas') as HTMLCanvasElement;
            if (this._playerCanvas) {
                this._playerCtx = this._playerCanvas.getContext('2d');
                this.resizePlayerCanvas();
                window.addEventListener('resize', () => this.resizePlayerCanvas());
                this.setupPlayerCanvasEvents();
            }
        }

        // Create player timeline
        if (!this._playerTimeline) {
            this._playerTimeline = new PlayerModeTimeline({
                container: document.getElementById('timeline-container')!,
                controller: this._playerController
            });

            // Handle import request
            this._playerTimeline.on('import-requested', () => {
                if (this._playerModeKind === 'merge') this.importMergeAnimationParts();
                else this.importAnimation();
            });
        }

        this._playerController.setDisplayMode(kind === 'merge' ? 'linear' : 'grid');

        // Show player canvas, hide editor canvas
        const playerCanvasContainer = document.getElementById('player-canvas-container');
        playerCanvasContainer?.classList.remove('hidden');
        document.getElementById('canvas-container')?.classList.add('hidden');

        // Switch visibility
        this._timeline.hide();
        this._playerTimeline.show();
        this._pivotEditor.hide?.();

        // Hide editor-only panels and show merge controls
        document.getElementById('normalized-preview')?.classList.add('hidden');
        document.getElementById('animation-properties')?.classList.add('hidden');
        document.getElementById('interactive-editor')?.classList.add('hidden');
        document.getElementById('export-section')?.classList.add('hidden');
        document.getElementById('reference-mode-panel')?.classList.add('hidden');
        document.getElementById('merge-mode-panel')?.classList.toggle('hidden', kind !== 'merge');
        if (kind === 'merge') this.renderMergePartsList();

        // Update toggle button
        this.updateModeToggleUI(true);
        this._toolbar.isPlaying = false;

        // Resize canvas
        this.resizePlayerCanvas();

        // Start render loop
        this._playerController.on('frame-updated', () => this.renderPlayerMode());
        this._playerController.on('playback-changed', (isPlaying: boolean) => {
            this._toolbar.isPlaying = isPlaying;
        });

        // Initial render
        this.renderPlayerMode();
    }

    private _playerPan = { x: 0, y: 0 };
    private _playerZoom = 1;
    private _playerIsPanning = false;
    private _playerLastMouse = { x: 0, y: 0 };
    private _playerIsDraggingSlot = false;

    private setupPlayerCanvasEvents(): void {
        if (!this._playerCanvas) return;

        // Panning with middle mouse or right mouse
        this._playerCanvas.addEventListener('mousedown', (e) => {
            if (!this._isPlayerMode || !this._playerController) return;

            const rect = this._playerCanvas!.getBoundingClientRect();
            const canvasX = e.clientX - rect.left;
            const canvasY = e.clientY - rect.top;

            // Middle mouse or right click = pan
            if (e.button === 1 || e.button === 2) {
                e.preventDefault();
                this._playerIsPanning = true;
                this._playerLastMouse = { x: e.clientX, y: e.clientY };
            }
            // Left click = select/drag slot
            else if (e.button === 0) {
                const worldX = (canvasX - this._playerPan.x) / this._playerZoom;
                const worldY = (canvasY - this._playerPan.y) / this._playerZoom;

                const slot = this._playerController.getSlotAtPosition(worldX, worldY);
                if (slot) {
                    this._playerController.selectSlot(slot.id);
                    this._playerController.handleClick(worldX, worldY);
                    this.renderPlayerMode();
                    this._playerIsDraggingSlot = true;
                    this._playerLastMouse = { x: e.clientX, y: e.clientY };
                } else {
                    this._playerController.selectSlot(null);
                }
                this.renderPlayerMode();
            }
        });

        this._playerCanvas.addEventListener('mousemove', (e) => {
            if (!this._isPlayerMode || !this._playerController) return;

            const dx = e.clientX - this._playerLastMouse.x;
            const dy = e.clientY - this._playerLastMouse.y;

            if (this._playerIsPanning) {
                this._playerPan.x += dx;
                this._playerPan.y += dy;
                this._playerLastMouse = { x: e.clientX, y: e.clientY };
                this.renderPlayerMode();
            } else if (this._playerIsDraggingSlot) {
                this._playerController.moveSelectedSlot(dx / this._playerZoom, dy / this._playerZoom);
                this._playerLastMouse = { x: e.clientX, y: e.clientY };
                this.renderPlayerMode();
            } else {
                const rect = this._playerCanvas!.getBoundingClientRect();
                const worldX = (e.clientX - rect.left - this._playerPan.x) / this._playerZoom;
                const worldY = (e.clientY - rect.top - this._playerPan.y) / this._playerZoom;
                this._playerController.handlePointerMove(worldX, worldY);
                this.renderPlayerMode();
            }
        });

        this._playerCanvas.addEventListener('mouseup', () => {
            this._playerIsPanning = false;
            this._playerIsDraggingSlot = false;
        });

        this._playerCanvas.addEventListener('mouseleave', () => {
            this._playerIsPanning = false;
            this._playerIsDraggingSlot = false;
            this._playerController?.handlePointerLeave();
            this.renderPlayerMode();
        });

        // Zoom with wheel
        this._playerCanvas.addEventListener('wheel', (e) => {
            if (!this._isPlayerMode) return;
            e.preventDefault();

            const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
            const newZoom = Math.max(0.1, Math.min(5, this._playerZoom * zoomFactor));

            // Zoom towards mouse position
            const rect = this._playerCanvas!.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;

            const zoomRatio = newZoom / this._playerZoom;
            this._playerPan.x = mouseX - (mouseX - this._playerPan.x) * zoomRatio;
            this._playerPan.y = mouseY - (mouseY - this._playerPan.y) * zoomRatio;
            this._playerZoom = newZoom;

            this.renderPlayerMode();
        });

        // Prevent context menu
        this._playerCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

        // Drag and drop file import
        this._playerCanvas.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer!.dropEffect = 'copy';
        });

        this._playerCanvas.addEventListener('drop', async (e) => {
            e.preventDefault();
            if (!this._isPlayerMode) return;

            const files = Array.from(e.dataTransfer?.files || []);
            for (const file of files) {
                if (file.name.endsWith('.json')) {
                    const metaPath = (file as any).path;
                    if (metaPath) {
                        if (this._playerModeKind === 'merge') {
                            await this.addMergeAnimationPartFromPath(metaPath);
                            this.renderMergePartsList();
                            this.syncPlayerSlotOrderWithMergeParts();
                        } else {
                            await this.importAnimationFromPath(metaPath);
                        }
                        this.renderPlayerMode();
                    }
                }
            }
        });
    }

    private exitPlayerMode(): void {
        this._isPlayerMode = false;
        this._playerModeKind = null;

        // Stop playback
        this._playerController?.stop();

        // Show editor canvas, hide player canvas
        const playerCanvasContainer = document.getElementById('player-canvas-container');
        playerCanvasContainer?.classList.add('hidden');
        document.getElementById('canvas-container')?.classList.remove('hidden');

        // Switch visibility
        this._playerTimeline?.hide();
        this._timeline.show();
        this._pivotEditor.show?.();

        // Restore editor panels
        document.getElementById('normalized-preview')?.classList.remove('hidden');
        document.getElementById('animation-properties')?.classList.remove('hidden');
        document.getElementById('interactive-editor')?.classList.remove('hidden');
        document.getElementById('export-section')?.classList.remove('hidden');
        if (this._isReferenceMode) document.getElementById('reference-mode-panel')?.classList.remove('hidden');
        document.getElementById('merge-mode-panel')?.classList.add('hidden');

        // Update toggle button
        this.updateModeToggleUI(false);
        this._toolbar.isPlaying = this._playback.isPlaying;

        // Re-render editor canvas
        this._canvas.render();
    }

    private updateModeToggleUI(isPlayerMode: boolean): void {
        const playerBtn = document.getElementById('mode-toggle-btn');
        const playerBadge = playerBtn?.querySelector('.mode-badge-indicator');
        const mergeBtn = document.getElementById('merge-mode-toggle-btn');

        if (playerBtn && playerBadge) {
            playerBtn.classList.toggle('active', this._playerModeKind === 'player');
            playerBadge.textContent = this._playerModeKind === 'player' ? 'Player' : 'Editor';
        }

        mergeBtn?.classList.toggle('active', this._playerModeKind === 'merge');
    }

    private async importAnimation(): Promise<void> {
        try {
            // Open file dialog for JSON and image files
            const result = await ipcRenderer.invoke(IPC_CHANNELS.OPEN_FILE_DIALOG, {
                title: 'Import Animation',
                filters: [
                    { name: 'All Supported', extensions: ['json', 'png', 'jpg', 'jpeg', 'webp'] },
                    { name: 'Meta JSON', extensions: ['json'] },
                    { name: 'Spritesheet Image', extensions: ['png', 'jpg', 'jpeg', 'webp'] }
                ],
                properties: ['openFile', 'multiSelections']
            });

            if (result.canceled || !result.filePaths || result.filePaths.length === 0) return;

            // Separate JSON and image files
            const jsonFiles: string[] = [];
            const imageFiles: string[] = [];

            for (const filePath of result.filePaths) {
                const ext = filePath.split('.').pop()?.toLowerCase() || '';
                if (ext === 'json') {
                    jsonFiles.push(filePath);
                } else if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) {
                    imageFiles.push(filePath);
                }
            }

            // Import JSON files directly
            for (const metaPath of jsonFiles) {
                await this.importAnimationFromPath(metaPath);
            }

            // For image files, show spritesheet import dialog
            if (imageFiles.length > 0) {
                this.showSpritesheetImportDialog(imageFiles);
            }

        } catch (error) {
            console.error('Failed to import animation:', error);
            alert(`Failed to import animation: ${error}`);
        }
    }

    private showSpritesheetImportDialog(imagePaths: string[]): void {
        const dialog = document.getElementById('spritesheet-import-dialog');
        dialog?.classList.remove('hidden');

        const colsInput = document.getElementById('ss-import-cols') as HTMLInputElement;
        const rowsInput = document.getElementById('ss-import-rows') as HTMLInputElement;
        const fpsInput = document.getElementById('ss-import-fps') as HTMLInputElement;
        const confirmBtn = document.getElementById('ss-import-confirm');
        const cancelBtn = document.getElementById('ss-import-cancel');

        const closeDialog = () => dialog?.classList.add('hidden');

        // Clone to remove old handlers
        if (confirmBtn) {
            const newConfirmBtn = confirmBtn.cloneNode(true) as HTMLElement;
            confirmBtn.parentNode?.replaceChild(newConfirmBtn, confirmBtn);
            newConfirmBtn.addEventListener('click', async () => {
                closeDialog();
                const cols = parseInt(colsInput?.value || '8', 10);
                const rows = parseInt(rowsInput?.value || '1', 10);
                const fps = parseInt(fpsInput?.value || '12', 10);

                for (const imagePath of imagePaths) {
                    try {
                        await this._playerController?.addSpritesheetSlot(imagePath, cols, rows, fps);
                    } catch (error) {
                        console.error('Failed to import spritesheet:', imagePath, error);
                    }
                }

                this.renderPlayerMode();
            });
        }

        cancelBtn?.addEventListener('click', closeDialog, { once: true });
    }

    private async importAnimationFromPath(metaPath: string): Promise<void> {
        try {
            if (!this._playerController) return;

            const dir = path.dirname(metaPath);
            const metaJson = fs.readFileSync(metaPath, 'utf-8');

            let metaData: any;
            try {
                metaData = JSON.parse(metaJson);
            } catch (e) {
                console.error('Invalid JSON file:', metaPath);
                return;
            }

            const spriteSheetPath = this.resolvePlayerSpriteSheetPath(dir, metaData);

            if (!spriteSheetPath) {
                console.error("Sprite sheet not found for:", metaPath);
                return;
            }

            // Add to player controller
            await this._playerController.addSlot(spriteSheetPath, metaPath);

            // Re-render
            this.renderPlayerMode();

        } catch (error) {
            console.error('Failed to import animation from path:', error);
        }
    }

    private resolvePlayerSpriteSheetPath(dir: string, metaData: any): string | null {
        const basePath = metaData.source?.basePath;
        const candidates = [
            ...(Array.isArray(metaData.spriteSheets) ? metaData.spriteSheets : []),
            metaData.spriteSheet,
            metaData.meta?.image,
            ...(Array.isArray(metaData.source?.files) ? metaData.source.files : [])
        ].filter(Boolean);

        for (const candidate of candidates) {
            const direct = path.isAbsolute(candidate) ? candidate : path.join(dir, candidate);
            if (fs.existsSync(direct)) return direct;

            if (basePath) {
                const based = path.isAbsolute(basePath)
                    ? path.join(basePath, path.basename(candidate))
                    : path.join(dir, basePath, path.basename(candidate));
                if (fs.existsSync(based)) return based;
            }
        }

        return null;
    }

    private resizePlayerCanvas(): void {
        if (!this._playerCanvas) return;
        const container = document.getElementById('player-canvas-container');
        if (container) {
            this._playerCanvas.width = container.clientWidth;
            this._playerCanvas.height = container.clientHeight;
        }
    }

    private renderPlayerMode(): void {
        if (!this._playerController || !this._playerCanvas || !this._playerCtx) return;

        const ctx = this._playerCtx;
        const canvas = this._playerCanvas;

        // Clear canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Draw checkerboard background
        this.drawPlayerBackground(ctx, canvas.width, canvas.height);

        // Calculate center with pan offset for linear mode
        const centerX = canvas.width / 2 + this._playerPan.x;
        const centerY = canvas.height / 2 + this._playerPan.y;
        this._playerController.setLinearPivot(centerX / this._playerZoom, centerY / this._playerZoom);

        // Render all slots with pan and zoom
        this._playerController.render(ctx, this._playerPan.x, this._playerPan.y, this._playerZoom);
    }

    private drawPlayerBackground(ctx: CanvasRenderingContext2D, width: number, height: number): void {
        const tileSize = 16;
        const lightColor = '#2a2a2a';
        const darkColor = '#252525';

        for (let y = 0; y < height; y += tileSize) {
            for (let x = 0; x < width; x += tileSize) {
                const isEven = ((x / tileSize) + (y / tileSize)) % 2 === 0;
                ctx.fillStyle = isEven ? lightColor : darkColor;
                ctx.fillRect(x, y, tileSize, tileSize);
            }
        }
    }

    // ========================================================================
    // Reference Mode - Apply to All Frames
    // ========================================================================

    private applyScaleToAllFrames(scaleX: number, scaleY?: number): void {
        const animation = this._project.animation;
        if (!animation) return;

        // If only one value provided, use it for both X and Y
        const finalScaleY = scaleY ?? scaleX;

        for (const frame of animation.frames) {
            frame.scale = { x: scaleX, y: finalScaleY };
        }

        // Update preview
        this.updateNormalizedPreview();
        globalEvents.emit(EditorEvents.ANIMATION_UPDATED);
    }

    private applyOffsetToAllFrames(x: number, y: number): void {
        const animation = this._project.animation;
        if (!animation) return;

        for (const frame of animation.frames) {
            frame.offset = { x, y };
        }

        // Update preview
        this.updateNormalizedPreview();
        globalEvents.emit(EditorEvents.ANIMATION_UPDATED);
    }
}

// Initialize editor when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    console.log('[Mobik] DOM loaded, initializing editor...');
    try {
        new MobikEditor();
        console.log('[Mobik] Editor initialized successfully');
    } catch (error) {
        console.error('[Mobik] Failed to initialize editor:', error);
    }

    // Standalone "Normalize by Reference" tool. Self-wiring and decoupled from
    // the editor/player so a failure here never breaks the main app.
    try {
        new NormalizeByReferenceController();
    } catch (error) {
        console.error('[Mobik] Failed to initialize Normalize tool:', error);
    }
});



























