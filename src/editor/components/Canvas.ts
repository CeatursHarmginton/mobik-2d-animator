/**
 * Canvas Component - Main animation preview canvas
 * @module editor/components/Canvas
 */

import { Frame } from '../../core/models/Frame';
import { ViewportState, Point } from '../../core/models/types';
import {
    CANVAS_BACKGROUND,
    CANVAS_GRID_COLOR,
    CANVAS_GRID_SIZE,
    MIN_ZOOM,
    MAX_ZOOM,
    PIVOT_COLOR,
    PIVOT_HANDLE_SIZE,
    PIVOT_CROSSHAIR_SIZE
} from '../../shared/constants';
import { clamp, getMousePosition } from '../../shared/utils';
import { EventEmitter, EditorEvents } from '../../shared/events';

export interface CanvasOptions {
    container: HTMLElement;
    width?: number;
    height?: number;
}

export class Canvas extends EventEmitter {
    private _container: HTMLElement;
    private _canvas: HTMLCanvasElement;
    private _ctx: CanvasRenderingContext2D;
    private _width: number;
    private _height: number;

    private _viewport: ViewportState = {
        zoom: 1,
        panX: 0,
        panY: 0
    };

    private _currentFrame: Frame | null = null;
    private _onionFrames: { prev: Frame[]; next: Frame[] } = { prev: [], next: [] };
    private _showOnionSkin: boolean = false;
    private _onionOpacity: number = 0.3;
    private _showGrid: boolean = true;
    private _showPivot: boolean = true;
    private _showBoundingBox: boolean = false;

    // Reference frame overlay
    private _referenceImage: HTMLImageElement | null = null;
    private _showReference: boolean = true;
    private _referenceOpacity: number = 0.4;

    // Frame scale and offset for Reference Mode
    private _frameScaleX: number = 1.0;
    private _frameScaleY: number = 1.0;
    private _frameOffset: Point = { x: 0, y: 0 };
    private _referenceModeEnabled: boolean = false;
    private _isResizingFrame: boolean = false;
    private _resizeStartScaleX: number = 1.0;
    private _resizeStartScaleY: number = 1.0;
    private _resizeStartPos: Point = { x: 0, y: 0 };
    private _resizeStartOffset: Point = { x: 0, y: 0 };
    private _activeHandle: string = '';  // 'tl', 'tr', 'bl', 'br', 't', 'b', 'l', 'r'
    private _mirrorMode: boolean = false;
    private _colorFilter: string = 'none';
    private _palettePreviewImage: HTMLCanvasElement | null = null;

    private _isPanning: boolean = false;
    private _isDraggingFrame: boolean = false;
    private _isDraggingPivot: boolean = false;
    private _lastMousePos: Point = { x: 0, y: 0 };

    constructor(options: CanvasOptions) {
        super();
        this._container = options.container;
        this._width = options.width || this._container.clientWidth;
        this._height = options.height || this._container.clientHeight;

        // Create canvas element
        this._canvas = document.createElement('canvas');
        this._canvas.width = this._width;
        this._canvas.height = this._height;
        this._canvas.className = 'editor-canvas';
        this._container.appendChild(this._canvas);

        const ctx = this._canvas.getContext('2d');
        if (!ctx) throw new Error('Failed to get 2D context');
        this._ctx = ctx;

        this.setupEventListeners();
        this.render();
    }

    // ========================================================================
    // Accessors
    // ========================================================================

    get viewport(): ViewportState {
        return { ...this._viewport };
    }

    get zoom(): number {
        return this._viewport.zoom;
    }

    set zoom(value: number) {
        this._viewport.zoom = clamp(value, MIN_ZOOM, MAX_ZOOM);
        this.render();
        this.emit(EditorEvents.ZOOM_CHANGED, this._viewport.zoom);
    }

    get panX(): number {
        return this._viewport.panX;
    }

    get panY(): number {
        return this._viewport.panY;
    }

    /**
     * Get the underlying canvas element
     */
    getCanvas(): HTMLCanvasElement {
        return this._canvas;
    }

    /**
     * Draw checkerboard background - exposed for Player Mode
     */
    drawBackground(): void {
        this._ctx.fillStyle = CANVAS_BACKGROUND;
        this._ctx.fillRect(0, 0, this._width, this._height);

        if (this._showGrid) {
            this.drawGrid();
        }
    }

    get showOnionSkin(): boolean {
        return this._showOnionSkin;
    }

    set showOnionSkin(value: boolean) {
        this._showOnionSkin = value;
        this.render();
    }

    get showGrid(): boolean {
        return this._showGrid;
    }

    set showGrid(value: boolean) {
        this._showGrid = value;
        this.render();
    }

    get showPivot(): boolean {
        return this._showPivot;
    }

    set showPivot(value: boolean) {
        this._showPivot = value;
        this.render();
    }

    get showBoundingBox(): boolean {
        return this._showBoundingBox;
    }

    set showBoundingBox(value: boolean) {
        this._showBoundingBox = value;
        this.render();
    }

    get showReference(): boolean {
        return this._showReference;
    }

    set showReference(value: boolean) {
        this._showReference = value;
        this.render();
    }

    get referenceOpacity(): number {
        return this._referenceOpacity;
    }

    set referenceOpacity(value: number) {
        this._referenceOpacity = clamp(value, 0, 1);
        this.render();
    }

    get hasReference(): boolean {
        return this._referenceImage !== null;
    }

    get frameScaleX(): number {
        return this._frameScaleX;
    }

    get frameScaleY(): number {
        return this._frameScaleY;
    }

    setFrameScale(scaleX: number, scaleY: number): void {
        this._frameScaleX = clamp(scaleX, 0.5, 2.0);
        this._frameScaleY = clamp(scaleY, 0.5, 2.0);

        // Also update the current frame's scale property so it persists
        if (this._currentFrame) {
            this._currentFrame.scale = { x: this._frameScaleX, y: this._frameScaleY };
        }

        this.render();
    }

    get frameOffset(): Point {
        return { ...this._frameOffset };
    }

    setFrameOffset(x: number, y: number): void {
        this._frameOffset = { x, y };

        // Also update the current frame's offset property so it persists
        if (this._currentFrame) {
            this._currentFrame.offset = { x, y };
        }

        this.render();
    }

    set referenceModeEnabled(value: boolean) {
        this._referenceModeEnabled = value;
        this.render();
    }

    get referenceModeEnabled(): boolean {
        return this._referenceModeEnabled;
    }

    // ========================================================================
    // Reference Frame Management
    // ========================================================================

    setReferenceImage(image: HTMLImageElement): void {
        this._referenceImage = image;
        this._showReference = true;
        this.render();
    }

    clearReferenceImage(): void {
        this._referenceImage = null;
        this.render();
    }

    set colorFilter(filter: string) {
        this._colorFilter = filter || 'none';
        this.render();
    }

    get colorFilter(): string {
        return this._colorFilter;
    }

    setPalettePreviewImage(image: HTMLCanvasElement | null): void {
        this._palettePreviewImage = image;
        this.render();
    }

    // ========================================================================
    // Frame Management
    // ========================================================================

    setCurrentFrame(frame: Frame | null): void {
        this._currentFrame = frame;

        // Sync Canvas scale and offset with frame's stored values
        if (frame) {
            this._frameScaleX = frame.scale.x;
            this._frameScaleY = frame.scale.y;
            this._frameOffset = { x: frame.offset.x, y: frame.offset.y };
        } else {
            this._frameScaleX = 1.0;
            this._frameScaleY = 1.0;
            this._frameOffset = { x: 0, y: 0 };
        }

        this.render();
    }

    setOnionFrames(prev: Frame[], next: Frame[]): void {
        this._onionFrames = { prev, next };
        if (this._showOnionSkin) {
            this.render();
        }
    }

    // ========================================================================
    // Viewport Controls
    // ========================================================================

    resetView(): void {
        this._viewport = { zoom: 1, panX: 0, panY: 0 };
        this.centerOnFrame();
        this.render();
    }

    centerOnFrame(): void {
        if (!this._currentFrame) return;

        this._viewport.panX = (this._width / 2) - (this._currentFrame.width * this._viewport.zoom / 2);
        this._viewport.panY = (this._height / 2) - (this._currentFrame.height * this._viewport.zoom / 2);
        this.render();
    }

    zoomIn(): void {
        this.zoom = this._viewport.zoom * 1.2;
    }

    zoomOut(): void {
        this.zoom = this._viewport.zoom / 1.2;
    }

    zoomToFit(): void {
        if (!this._currentFrame) return;

        const padding = 100;
        const scaleX = (this._width - padding * 2) / this._currentFrame.width;
        const scaleY = (this._height - padding * 2) / this._currentFrame.height;
        this._viewport.zoom = clamp(Math.min(scaleX, scaleY), MIN_ZOOM, MAX_ZOOM);
        this.centerOnFrame();
    }

    // ========================================================================
    // Coordinate Transforms
    // ========================================================================

    screenToWorld(screenX: number, screenY: number): Point {
        return {
            x: (screenX - this._viewport.panX) / this._viewport.zoom,
            y: (screenY - this._viewport.panY) / this._viewport.zoom
        };
    }

    worldToScreen(worldX: number, worldY: number): Point {
        return {
            x: worldX * this._viewport.zoom + this._viewport.panX,
            y: worldY * this._viewport.zoom + this._viewport.panY
        };
    }

    // ========================================================================
    // Rendering
    // ========================================================================

    render(): void {
        this._ctx.imageSmoothingEnabled = false;

        // Clear background
        this._ctx.fillStyle = CANVAS_BACKGROUND;
        this._ctx.fillRect(0, 0, this._width, this._height);

        // Draw grid
        if (this._showGrid) {
            this.drawGrid();
        }

        // Draw reference image (semi-transparent overlay for alignment)
        if (this._showReference && this._referenceImage) {
            this.drawReferenceImage();
        }

        // Draw onion skin (previous frames)
        if (this._showOnionSkin) {
            this._onionFrames.prev.forEach((frame, i) => {
                const opacity = this._onionOpacity * (1 - i * 0.2);
                this.drawFrame(frame, '#4dabf7', opacity);
            });
        }

        // Draw current frame
        if (this._currentFrame) {
            this.drawFrame(this._currentFrame);

            // Draw bounding box
            if (this._showBoundingBox) {
                this.drawBoundingBox(this._currentFrame);
            }

            // Draw pivot
            if (this._showPivot) {
                this.drawPivot(this._currentFrame);
            }

            // Draw resize handles in Reference Mode
            if (this._referenceModeEnabled) {
                this.drawResizeHandles(this._currentFrame);
            }
        }

        // Draw onion skin (next frames)
        if (this._showOnionSkin) {
            this._onionFrames.next.forEach((frame, i) => {
                const opacity = this._onionOpacity * (1 - i * 0.2) * 0.7;
                this.drawFrame(frame, '#69db7c', opacity);
            });
        }
    }

    private drawResizeHandles(frame: Frame): void {
        const ctx = this._ctx;
        const zoom = this._viewport.zoom;
        const scaleX = this._frameScaleX;
        const scaleY = this._frameScaleY;
        const offset = this._frameOffset;

        const basePos = this.worldToScreen(0, 0);
        const pos = {
            x: basePos.x + offset.x * zoom,
            y: basePos.y + offset.y * zoom
        };
        const w = frame.sourceRect.w * zoom * scaleX;
        const h = frame.sourceRect.h * zoom * scaleY;

        const handleSize = 10;
        const halfHandle = handleSize / 2;

        // 8 handles: 4 corners + 4 edges
        const handles = [
            { id: 'tl', x: pos.x - halfHandle, y: pos.y - halfHandle, cursor: 'nwse-resize' },
            { id: 'tr', x: pos.x + w - halfHandle, y: pos.y - halfHandle, cursor: 'nesw-resize' },
            { id: 'bl', x: pos.x - halfHandle, y: pos.y + h - halfHandle, cursor: 'nesw-resize' },
            { id: 'br', x: pos.x + w - halfHandle, y: pos.y + h - halfHandle, cursor: 'nwse-resize' },
            { id: 't', x: pos.x + w / 2 - halfHandle, y: pos.y - halfHandle, cursor: 'ns-resize' },
            { id: 'b', x: pos.x + w / 2 - halfHandle, y: pos.y + h - halfHandle, cursor: 'ns-resize' },
            { id: 'l', x: pos.x - halfHandle, y: pos.y + h / 2 - halfHandle, cursor: 'ew-resize' },
            { id: 'r', x: pos.x + w - halfHandle, y: pos.y + h / 2 - halfHandle, cursor: 'ew-resize' }
        ];

        // Draw frame border
        ctx.strokeStyle = '#a855f7';
        ctx.lineWidth = 2;
        ctx.strokeRect(pos.x, pos.y, w, h);

        // Draw mirror center line if mirror mode active
        if (this._mirrorMode) {
            ctx.strokeStyle = '#a855f7';
            ctx.lineWidth = 2;
            ctx.setLineDash([5, 5]);
            const centerX = pos.x + w / 2;
            ctx.beginPath();
            ctx.moveTo(centerX, pos.y - 10);
            ctx.lineTo(centerX, pos.y + h + 10);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // Draw handles
        ctx.fillStyle = '#a855f7';
        handles.forEach(handle => {
            ctx.fillRect(handle.x, handle.y, handleSize, handleSize);
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1;
            ctx.strokeRect(handle.x, handle.y, handleSize, handleSize);
        });
    }

    private getHandleAtPos(pos: Point): { id: string, cursor: string } | null {
        if (!this._currentFrame) return null;

        const zoom = this._viewport.zoom;
        const scaleX = this._frameScaleX;
        const scaleY = this._frameScaleY;
        const offset = this._frameOffset;

        const basePos = this.worldToScreen(0, 0);
        const framePos = {
            x: basePos.x + offset.x * zoom,
            y: basePos.y + offset.y * zoom
        };
        const w = this._currentFrame.sourceRect.w * zoom * scaleX;
        const h = this._currentFrame.sourceRect.h * zoom * scaleY;

        const handleSize = 15;
        const halfHandle = handleSize / 2;

        const handles = [
            { id: 'tl', x: framePos.x, y: framePos.y, cursor: 'nwse-resize' },
            { id: 'tr', x: framePos.x + w, y: framePos.y, cursor: 'nesw-resize' },
            { id: 'bl', x: framePos.x, y: framePos.y + h, cursor: 'nesw-resize' },
            { id: 'br', x: framePos.x + w, y: framePos.y + h, cursor: 'nwse-resize' },
            { id: 't', x: framePos.x + w / 2, y: framePos.y, cursor: 'ns-resize' },
            { id: 'b', x: framePos.x + w / 2, y: framePos.y + h, cursor: 'ns-resize' },
            { id: 'l', x: framePos.x, y: framePos.y + h / 2, cursor: 'ew-resize' },
            { id: 'r', x: framePos.x + w, y: framePos.y + h / 2, cursor: 'ew-resize' }
        ];

        for (const handle of handles) {
            if (pos.x >= handle.x - halfHandle && pos.x <= handle.x + halfHandle &&
                pos.y >= handle.y - halfHandle && pos.y <= handle.y + halfHandle) {
                return { id: handle.id, cursor: handle.cursor };
            }
        }
        return null;
    }

    private drawGrid(): void {
        const ctx = this._ctx;
        const gridSize = CANVAS_GRID_SIZE * this._viewport.zoom;

        ctx.strokeStyle = CANVAS_GRID_COLOR;
        ctx.lineWidth = 1;

        const offsetX = this._viewport.panX % gridSize;
        const offsetY = this._viewport.panY % gridSize;

        ctx.beginPath();
        for (let x = offsetX; x < this._width; x += gridSize) {
            ctx.moveTo(x, 0);
            ctx.lineTo(x, this._height);
        }
        for (let y = offsetY; y < this._height; y += gridSize) {
            ctx.moveTo(0, y);
            ctx.lineTo(this._width, y);
        }
        ctx.stroke();
    }

    private drawReferenceImage(): void {
        if (!this._referenceImage) return;

        const ctx = this._ctx;
        const zoom = this._viewport.zoom;

        ctx.save();
        ctx.globalAlpha = this._referenceOpacity;

        const screenPos = this.worldToScreen(0, 0);
        const width = this._referenceImage.width * zoom;
        const height = this._referenceImage.height * zoom;

        ctx.drawImage(
            this._referenceImage,
            0, 0,
            this._referenceImage.width, this._referenceImage.height,
            screenPos.x, screenPos.y,
            width, height
        );

        ctx.restore();
    }

    private drawFrame(frame: Frame, tint?: string, opacity: number = 1): void {
        if (!frame.image?.element) return;

        const ctx = this._ctx;
        const zoom = this._viewport.zoom;
        const scaleX = this._frameScaleX;
        const scaleY = this._frameScaleY;
        const offset = this._frameOffset;

        ctx.save();
        ctx.globalAlpha = opacity;

        // Apply color filter for non-tinted frames
        if (!tint && this._colorFilter && this._colorFilter !== 'none') {
            ctx.filter = this._colorFilter;
        }

        // Apply frame scale and offset
        const basePos = this.worldToScreen(0, 0);
        const screenPos = {
            x: basePos.x + offset.x * zoom,
            y: basePos.y + offset.y * zoom
        };
        const width = frame.sourceRect.w * zoom * scaleX;
        const height = frame.sourceRect.h * zoom * scaleY;

        const imageElement = (!tint && frame === this._currentFrame && this._palettePreviewImage)
            ? this._palettePreviewImage
            : frame.image.element;
        const sx = imageElement === this._palettePreviewImage ? 0 : frame.sourceRect.x;
        const sy = imageElement === this._palettePreviewImage ? 0 : frame.sourceRect.y;
        const sw = imageElement === this._palettePreviewImage ? imageElement.width : frame.sourceRect.w;
        const sh = imageElement === this._palettePreviewImage ? imageElement.height : frame.sourceRect.h;

        if (tint) {
            // For onion skin, draw with color tint
            ctx.drawImage(
                imageElement,
                sx, sy,
                sw, sh,
                screenPos.x, screenPos.y,
                width, height
            );
            ctx.globalCompositeOperation = 'source-atop';
            ctx.fillStyle = tint;
            ctx.fillRect(screenPos.x, screenPos.y, width, height);
        } else {
            ctx.drawImage(
                imageElement,
                sx, sy,
                sw, sh,
                screenPos.x, screenPos.y,
                width, height
            );
        }

        ctx.restore();
    }

    private drawPivot(frame: Frame): void {
        const ctx = this._ctx;
        const screenPivot = this.getPivotScreenPosition(frame);

        ctx.save();
        ctx.strokeStyle = PIVOT_COLOR;
        ctx.fillStyle = PIVOT_COLOR;
        ctx.lineWidth = 2;

        // Draw crosshair
        const size = PIVOT_CROSSHAIR_SIZE;
        ctx.beginPath();
        ctx.moveTo(screenPivot.x - size, screenPivot.y);
        ctx.lineTo(screenPivot.x + size, screenPivot.y);
        ctx.moveTo(screenPivot.x, screenPivot.y - size);
        ctx.lineTo(screenPivot.x, screenPivot.y + size);
        ctx.stroke();

        // Draw handle circle
        ctx.beginPath();
        ctx.arc(screenPivot.x, screenPivot.y, PIVOT_HANDLE_SIZE / 2, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
    }

    private getFrameScreenRect(frame: Frame): { x: number; y: number; w: number; h: number } {
        const zoom = this._viewport.zoom;
        const basePos = this.worldToScreen(0, 0);
        return {
            x: basePos.x + this._frameOffset.x * zoom,
            y: basePos.y + this._frameOffset.y * zoom,
            w: frame.sourceRect.w * zoom * this._frameScaleX,
            h: frame.sourceRect.h * zoom * this._frameScaleY
        };
    }

    private getPivotScreenPosition(frame: Frame): Point {
        const rect = this.getFrameScreenRect(frame);
        return {
            x: rect.x + frame.pivot.x * rect.w,
            y: rect.y + frame.pivot.y * rect.h
        };
    }

    private setPivotFromScreenPosition(frame: Frame, screenX: number, screenY: number): void {
        const rect = this.getFrameScreenRect(frame);
        frame.pivot = {
            x: clamp((screenX - rect.x) / Math.max(1, rect.w), 0, 1),
            y: clamp((screenY - rect.y) / Math.max(1, rect.h), 0, 1)
        };
    }

    private isPointInCurrentFrame(pos: Point): boolean {
        if (!this._currentFrame) return false;
        const rect = this.getFrameScreenRect(this._currentFrame);
        return pos.x >= rect.x && pos.x <= rect.x + rect.w &&
            pos.y >= rect.y && pos.y <= rect.y + rect.h;
    }

    private drawBoundingBox(frame: Frame): void {
        const ctx = this._ctx;
        const zoom = this._viewport.zoom;
        const scaleX = this._frameScaleX;
        const scaleY = this._frameScaleY;
        const offset = this._frameOffset;

        const basePos = this.worldToScreen(0, 0);
        const screenPos = {
            x: basePos.x + offset.x * zoom,
            y: basePos.y + offset.y * zoom
        };
        const width = frame.sourceRect.w * zoom * scaleX;
        const height = frame.sourceRect.h * zoom * scaleY;

        ctx.save();
        ctx.strokeStyle = '#00ff00';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(screenPos.x, screenPos.y, width, height);
        ctx.setLineDash([]);

        // Draw frame dimensions text
        ctx.fillStyle = '#00ff00';
        ctx.font = '11px monospace';
        const dimText = `${Math.round(frame.sourceRect.w)} × ${Math.round(frame.sourceRect.h)}`;
        ctx.fillText(dimText, screenPos.x, screenPos.y - 5);

        ctx.restore();
    }

    // ========================================================================
    // Event Handling
    // ========================================================================

    private setupEventListeners(): void {
        this._canvas.addEventListener('mousedown', this.onMouseDown.bind(this));
        this._canvas.addEventListener('mousemove', this.onMouseMove.bind(this));
        this._canvas.addEventListener('mouseup', this.onMouseUp.bind(this));
        this._canvas.addEventListener('mouseleave', this.onMouseUp.bind(this));
        this._canvas.addEventListener('wheel', this.onWheel.bind(this));
        this._canvas.addEventListener('contextmenu', (e) => e.preventDefault());

        // Handle resize
        const resizeObserver = new ResizeObserver(() => this.resize());
        resizeObserver.observe(this._container);
    }

    private onMouseDown(e: MouseEvent): void {
        const pos = getMousePosition(e, this._canvas);
        this._lastMousePos = pos;

        // Right click in Reference Mode moves the frame image; middle click pans the canvas.
        if (e.button === 2 && this._referenceModeEnabled && this._currentFrame && this.isPointInCurrentFrame(pos)) {
            this._isDraggingFrame = true;
            this._canvas.style.cursor = 'move';
            return;
        }

        if (e.button === 1 || e.button === 2) {
            this._isPanning = true;
            this._canvas.style.cursor = 'grabbing';
            return;
        }

        // Left click - check for resize handle in Reference Mode
        if (e.button === 0 && this._referenceModeEnabled && this._currentFrame) {
            const handle = this.getHandleAtPos(pos);
            if (handle) {
                this._isResizingFrame = true;
                this._activeHandle = handle.id;
                this._resizeStartScaleX = this._frameScaleX;
                this._resizeStartScaleY = this._frameScaleY;
                this._resizeStartPos = pos;
                this._resizeStartOffset = { ...this._frameOffset };
                this._mirrorMode = e.ctrlKey;
                this._canvas.style.cursor = handle.cursor;
                return;
            }
        }

        // Left click - check for pivot drag
        if (e.button === 0 && this._currentFrame && this._showPivot) {
            const screenPivot = this.getPivotScreenPosition(this._currentFrame);
            const dist = Math.sqrt(
                Math.pow(pos.x - screenPivot.x, 2) +
                Math.pow(pos.y - screenPivot.y, 2)
            );

            if (dist < PIVOT_HANDLE_SIZE) {
                this._isDraggingPivot = true;
                this.emit(EditorEvents.PIVOT_DRAG_START);
                return;
            }
        }
    }

    private onMouseMove(e: MouseEvent): void {
        const pos = getMousePosition(e, this._canvas);
        const dx = pos.x - this._lastMousePos.x;
        const dy = pos.y - this._lastMousePos.y;
        this._lastMousePos = pos;

        // Update mirror mode based on Ctrl key
        if (this._isResizingFrame) {
            this._mirrorMode = e.ctrlKey;
        }

        if (this._isPanning) {
            this._viewport.panX += dx;
            this._viewport.panY += dy;
            this.render();
            return;
        }

        if (this._isDraggingFrame && this._currentFrame) {
            const zoom = this._viewport.zoom || 1;
            this._frameOffset = {
                x: this._frameOffset.x + dx / zoom,
                y: this._frameOffset.y + dy / zoom
            };
            this._currentFrame.offset = { ...this._frameOffset };
            this.render();
            return;
        }

        if (this._isResizingFrame && this._currentFrame) {
            const zoom = this._viewport.zoom;
            const handle = this._activeHandle;

            // Calculate drag delta from start position
            const deltaX = (pos.x - this._resizeStartPos.x) / zoom;
            const deltaY = (pos.y - this._resizeStartPos.y) / zoom;

            let newScaleX = this._resizeStartScaleX;
            let newScaleY = this._resizeStartScaleY;
            let newOffsetX = this._resizeStartOffset.x;
            let newOffsetY = this._resizeStartOffset.y;
            const frameW = this._currentFrame.sourceRect.w;
            const frameH = this._currentFrame.sourceRect.h;

            // Handle different resize behaviors based on handle type
            if (handle === 'r') {
                // Right edge - scale horizontally
                newScaleX = clamp(this._resizeStartScaleX + deltaX / 100, 0.5, 2.0);
            } else if (handle === 'l') {
                // Left edge - scale horizontally and adjust offset
                const scaleDelta = -deltaX / 100;
                newScaleX = clamp(this._resizeStartScaleX + scaleDelta, 0.5, 2.0);
                newOffsetX = this._resizeStartOffset.x + frameW * (this._resizeStartScaleX - newScaleX);
            } else if (handle === 'b') {
                // Bottom edge - scale vertically
                newScaleY = clamp(this._resizeStartScaleY + deltaY / 100, 0.5, 2.0);
            } else if (handle === 't') {
                // Top edge - scale vertically and adjust offset
                const scaleDelta = -deltaY / 100;
                newScaleY = clamp(this._resizeStartScaleY + scaleDelta, 0.5, 2.0);
                newOffsetY = this._resizeStartOffset.y + frameH * (this._resizeStartScaleY - newScaleY);
            } else if (handle === 'br') {
                // Bottom-right corner - uniform scale
                const scaleDelta = (deltaX + deltaY) / 200;
                newScaleX = clamp(this._resizeStartScaleX + scaleDelta, 0.5, 2.0);
                newScaleY = clamp(this._resizeStartScaleY + scaleDelta, 0.5, 2.0);
            } else if (handle === 'tl') {
                // Top-left corner - uniform scale and adjust offset
                const scaleDelta = -(deltaX + deltaY) / 200;
                newScaleX = clamp(this._resizeStartScaleX + scaleDelta, 0.5, 2.0);
                newScaleY = clamp(this._resizeStartScaleY + scaleDelta, 0.5, 2.0);
                newOffsetX = this._resizeStartOffset.x + frameW * (this._resizeStartScaleX - newScaleX);
                newOffsetY = this._resizeStartOffset.y + frameH * (this._resizeStartScaleY - newScaleY);
            } else if (handle === 'tr') {
                // Top-right corner - uniform scale
                const scaleDelta = (deltaX - deltaY) / 200;
                newScaleX = clamp(this._resizeStartScaleX + scaleDelta, 0.5, 2.0);
                newScaleY = clamp(this._resizeStartScaleY + scaleDelta, 0.5, 2.0);
                newOffsetY = this._resizeStartOffset.y + frameH * (this._resizeStartScaleY - newScaleY);
            } else if (handle === 'bl') {
                // Bottom-left corner - uniform scale
                const scaleDelta = (-deltaX + deltaY) / 200;
                newScaleX = clamp(this._resizeStartScaleX + scaleDelta, 0.5, 2.0);
                newScaleY = clamp(this._resizeStartScaleY + scaleDelta, 0.5, 2.0);
                newOffsetX = this._resizeStartOffset.x + frameW * (this._resizeStartScaleX - newScaleX);
            }

            // Apply mirror mode - symmetric offset from center
            if (this._mirrorMode && (handle === 'l' || handle === 'r')) {
                // Keep frame centered horizontally
                const centerOffset = frameW * (this._resizeStartScaleX - newScaleX) / 2;
                newOffsetX = this._resizeStartOffset.x + centerOffset;
            }

            this._frameScaleX = newScaleX;
            this._frameScaleY = newScaleY;
            this._frameOffset = { x: newOffsetX, y: newOffsetY };
            this.render();
            this.emit(EditorEvents.FRAME_SCALE_CHANGED, { scaleX: newScaleX, scaleY: newScaleY });
            return;
        }

        if (this._isDraggingPivot && this._currentFrame) {
            this.setPivotFromScreenPosition(this._currentFrame, pos.x, pos.y);
            this.render();
            this.emit(EditorEvents.PIVOT_CHANGED, this._currentFrame.pivot);
            return;
        }

        // Update cursor for resize handle hover
        if (this._referenceModeEnabled && this._currentFrame) {
            const handle = this.getHandleAtPos(pos);
            if (handle) {
                this._canvas.style.cursor = handle.cursor;
                return;
            }
        }

        // Update cursor for pivot hover
        if (this._currentFrame && this._showPivot) {
            const screenPivot = this.getPivotScreenPosition(this._currentFrame);
            const dist = Math.sqrt(
                Math.pow(pos.x - screenPivot.x, 2) +
                Math.pow(pos.y - screenPivot.y, 2)
            );
            this._canvas.style.cursor = dist < PIVOT_HANDLE_SIZE ? 'move' : 'default';
        }
    }

    private onMouseUp(): void {
        if (this._isDraggingPivot) {
            this.emit(EditorEvents.PIVOT_DRAG_END);
        }

        // Persist moved offset to frame when right-drag ends
        if (this._isDraggingFrame && this._currentFrame) {
            this._currentFrame.offset = {
                x: this._frameOffset.x,
                y: this._frameOffset.y
            };
            this.emit(EditorEvents.FRAME_SCALE_CHANGED, {
                frameIndex: this._currentFrame.index,
                scale: { ...this._currentFrame.scale },
                offset: { ...this._currentFrame.offset }
            });
        }

        // Persist scale AND offset to frame when resize ends
        if (this._isResizingFrame && this._currentFrame) {
            this._currentFrame.scale = {
                x: this._frameScaleX,
                y: this._frameScaleY
            };
            this._currentFrame.offset = {
                x: this._frameOffset.x,
                y: this._frameOffset.y
            };
            this.emit(EditorEvents.FRAME_SCALE_CHANGED, {
                frameIndex: this._currentFrame.index,
                scale: { ...this._currentFrame.scale },
                offset: { ...this._currentFrame.offset }
            });
        }

        this._isPanning = false;
        this._isDraggingFrame = false;
        this._isDraggingPivot = false;
        this._isResizingFrame = false;
        this._activeHandle = '';
        this._mirrorMode = false;
        this._canvas.style.cursor = 'default';
    }

    private onWheel(e: WheelEvent): void {
        e.preventDefault();

        const pos = getMousePosition(e, this._canvas);
        const worldBefore = this.screenToWorld(pos.x, pos.y);

        // Zoom
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        this._viewport.zoom = clamp(
            this._viewport.zoom * delta,
            MIN_ZOOM,
            MAX_ZOOM
        );

        // Adjust pan to zoom towards cursor
        const worldAfter = this.screenToWorld(pos.x, pos.y);
        this._viewport.panX += (worldAfter.x - worldBefore.x) * this._viewport.zoom;
        this._viewport.panY += (worldAfter.y - worldBefore.y) * this._viewport.zoom;

        this.render();
        this.emit(EditorEvents.ZOOM_CHANGED, this._viewport.zoom);
    }

    resize(): void {
        this._width = this._container.clientWidth;
        this._height = this._container.clientHeight;
        this._canvas.width = this._width;
        this._canvas.height = this._height;
        this.render();
    }

    // ========================================================================
    // Cleanup
    // ========================================================================

    destroy(): void {
        this._container.removeChild(this._canvas);
        this.removeAllListeners();
    }
}

