/**
 * Player Mode Controller - Manages multiple animation slots
 * Supports Linear (sequential) and Grid (simultaneous) display modes
 * @module editor/player/PlayerModeController
 */

import { EventEmitter, EditorEvents } from '../../shared/events';
import { AnimationSlot, AnimationSlotData } from './AnimationSlot';
import { createAnimationLoop, AnimationLoop } from '../../shared/utils';

export type PlayerDisplayMode = 'linear' | 'grid';

export interface PlayerModeState {
    slots: AnimationSlotData[];
    selectedSlotId: string | null;
    displayMode: PlayerDisplayMode;
}

export class PlayerModeController extends EventEmitter {
    private _slots: Map<string, AnimationSlot> = new Map();
    private _selectedSlotId: string | null = null;
    private _playing: boolean = false;
    private _animationLoop: AnimationLoop | null = null;

    // Display mode
    private _displayMode: PlayerDisplayMode = 'grid';
    private _currentLinearSlotIndex: number = 0;
    private _linearPivot: { x: number; y: number } = { x: 300, y: 300 };

    constructor() {
        super();
    }

    // ========================================================================
    // Slot Management
    // ========================================================================

    get slots(): AnimationSlot[] {
        return Array.from(this._slots.values()).sort((a, b) => a.zIndex - b.zIndex);
    }

    get selectedSlot(): AnimationSlot | null {
        if (!this._selectedSlotId) return null;
        return this._slots.get(this._selectedSlotId) || null;
    }

    get selectedSlotId(): string | null {
        return this._selectedSlotId;
    }

    get isPlaying(): boolean {
        return this._playing;
    }

    get slotCount(): number {
        return this._slots.size;
    }

    get displayMode(): PlayerDisplayMode {
        return this._displayMode;
    }

    get currentLinearSlotIndex(): number {
        return this._currentLinearSlotIndex;
    }

    /**
     * Add a new animation slot
     */
    async addSlot(spriteSheetPath: string, metaPath: string): Promise<AnimationSlot> {
        const id = AnimationSlot.generateId();
        const name = this.extractName(spriteSheetPath);
        const slot = new AnimationSlot(id, name);

        // Set z-index to be on top
        slot.zIndex = this._slots.size;

        // Load assets
        await slot.load(spriteSheetPath, metaPath);

        // Position based on current display mode
        if (this._displayMode === 'grid') {
            // Calculate grid position
            const gridPos = this.calculateGridPosition(this._slots.size);
            slot.position = gridPos;
        } else {
            // Linear mode: all at same pivot
            slot.position = { ...this._linearPivot };
        }

        this._slots.set(id, slot);
        this.emit('slot-added', slot);

        // Auto-select new slot
        this.selectSlot(id);
        if (slot.isInteractive) this.ensureAnimationLoop();

        return slot;
    }

    /**
     * Add a new animation slot from a raw spritesheet (no meta JSON needed).
     */
    async addSpritesheetSlot(
        spriteSheetPath: string,
        columns: number,
        rows: number,
        fps: number = 12
    ): Promise<AnimationSlot> {
        const id = AnimationSlot.generateId();
        const name = this.extractName(spriteSheetPath);
        const slot = new AnimationSlot(id, name);

        // Set z-index to be on top
        slot.zIndex = this._slots.size;

        // Load from raw spritesheet
        await slot.loadFromSpritesheet(spriteSheetPath, columns, rows, fps);

        // Position based on current display mode
        if (this._displayMode === 'grid') {
            const gridPos = this.calculateGridPosition(this._slots.size);
            slot.position = gridPos;
        } else {
            slot.position = { ...this._linearPivot };
        }

        this._slots.set(id, slot);
        this.emit('slot-added', slot);

        // Auto-select new slot
        this.selectSlot(id);

        return slot;
    }

    /**
     * Remove a slot
     */
    removeSlot(id: string): void {
        const slot = this._slots.get(id);
        if (!slot) return;

        this._slots.delete(id);

        if (this._selectedSlotId === id) {
            this._selectedSlotId = null;
            this.emit('selection-changed', null);
        }

        this.emit('slot-removed', id);

        // Recalculate grid positions if in grid mode
        if (this._displayMode === 'grid') {
            this.recalculateGridPositions();
        }
    }

    /**
     * Select a slot
     */
    selectSlot(id: string | null): void {
        this._selectedSlotId = id;
        this.emit('selection-changed', this.selectedSlot);
    }

    /**
     * Get slot at position
     */
    getSlotAtPosition(x: number, y: number): AnimationSlot | null {
        // Check in reverse z-order (top first)
        const slots = this.slots.reverse();
        for (const slot of slots) {
            if (slot.hitTest(x, y)) {
                return slot;
            }
        }
        return null;
    }

    /**
     * Move selected slot position
     */
    moveSelectedSlot(deltaX: number, deltaY: number): void {
        const slot = this.selectedSlot;
        if (!slot) return;

        slot.position.x += deltaX;
        slot.position.y += deltaY;
        this.emit('slot-moved', slot);
    }

    /**
     * Set selected slot position
     */
    setSlotPosition(x: number, y: number): void {
        const slot = this.selectedSlot;
        if (!slot) return;

        slot.position = { x, y };
        this.emit('slot-moved', slot);
    }


    handlePointerMove(x: number, y: number): void {
        const slot = this.selectedSlot;
        if (slot?.isInteractive) {
            this.ensureAnimationLoop();
            slot.handlePointerMove(x, y);
            this.emit('frame-updated');
        }
    }

    handleClick(x: number, y: number): void {
        const slot = this.selectedSlot;
        if (slot?.isInteractive) {
            this.ensureAnimationLoop();
            slot.handleClick(x, y);
            this.emit('frame-updated');
        }
    }


    handlePointerLeave(): void {
        const slot = this.selectedSlot;
        if (slot?.isInteractive) {
            slot.stop();
            this.emit('frame-updated');
        }
    }

    /**
     * Reorder slots (change z-index)
     */
    reorderSlots(fromIndex: number, toIndex: number): void {
        const slots = this.slots;
        if (fromIndex < 0 || fromIndex >= slots.length) return;
        if (toIndex < 0 || toIndex >= slots.length) return;

        const [moved] = slots.splice(fromIndex, 1);
        slots.splice(toIndex, 0, moved);

        this.applySlotOrder(slots);
    }

    setSlotOrder(slotIds: string[]): void {
        const ordered = slotIds
            .map(id => this._slots.get(id))
            .filter((slot): slot is AnimationSlot => Boolean(slot));
        const orderedIds = new Set(ordered.map(slot => slot.id));
        for (const slot of this.slots) {
            if (!orderedIds.has(slot.id)) ordered.push(slot);
        }
        this.applySlotOrder(ordered);
    }

    private applySlotOrder(slots: AnimationSlot[]): void {
        slots.forEach((slot, i) => {
            slot.zIndex = i;
        });

        this.emit('slots-reordered');
        this.emit('linear-slot-changed', this._currentLinearSlotIndex);
    }

    // ========================================================================
    // Display Mode
    // ========================================================================

    /**
     * Set display mode (linear or grid)
     */
    setDisplayMode(mode: PlayerDisplayMode): void {
        if (this._displayMode === mode) return;

        this._displayMode = mode;
        this._currentLinearSlotIndex = 0;

        if (mode === 'grid') {
            this.recalculateGridPositions();
        } else {
            // Linear: all slots at same pivot position
            this._slots.forEach(slot => {
                slot.position = { ...this._linearPivot };
            });
        }

        this.emit('mode-changed', mode);
    }

    /**
     * Set the pivot point for linear mode
     */
    setLinearPivot(x: number, y: number): void {
        this._linearPivot = { x, y };
        if (this._displayMode === 'linear') {
            this._slots.forEach(slot => {
                slot.position = { x, y };
            });
        }
    }

    /**
     * Calculate grid position for a slot at given index
     */
    private calculateGridPosition(index: number): { x: number; y: number } {
        const cols = Math.ceil(Math.sqrt(this._slots.size + 1));
        const cellWidth = 180;
        const cellHeight = 180;
        const startX = 100;
        const startY = 100;

        const col = index % cols;
        const row = Math.floor(index / cols);

        return {
            x: startX + col * cellWidth + cellWidth / 2,
            y: startY + row * cellHeight + cellHeight / 2
        };
    }

    /**
     * Recalculate grid positions for all slots
     */
    private recalculateGridPositions(): void {
        const slots = this.slots;
        slots.forEach((slot, index) => {
            slot.position = this.calculateGridPosition(index);
        });
    }

    // ========================================================================
    // Playback Control
    // ========================================================================

    play(): void {
        if (this._playing) return;
        if (this._slots.size === 0) return;

        this._playing = true;

        if (this._displayMode === 'grid') {
            // Grid mode: start all slot animations with looping
            this._slots.forEach(slot => {
                slot.player.loop = true;
                slot.play();
            });
        } else {
            // Linear mode: start only current slot
            this._currentLinearSlotIndex = 0;
            this.startLinearSlot(this._currentLinearSlotIndex);
        }

        this.ensureAnimationLoop();

        this.emit('playback-changed', true);
    }

    pause(): void {
        if (!this._playing) return;
        this._playing = false;

        // Pause all slots
        this._slots.forEach(slot => slot.pause());

        // Stop animation loop
        this._animationLoop?.stop();
        this._animationLoop = null;

        this.emit('playback-changed', false);
    }

    toggle(): void {
        if (this._playing) {
            this.pause();
        } else {
            this.play();
        }
    }

    stop(): void {
        this._playing = false;
        this._animationLoop?.stop();
        this._animationLoop = null;

        // Stop all slots
        this._slots.forEach(slot => slot.stop());
        this._currentLinearSlotIndex = 0;

        this.emit('playback-changed', false);
    }

    private ensureAnimationLoop(): void {
        if (this._animationLoop) return;
        this._animationLoop = createAnimationLoop((dt) => this.update(dt));
        this._animationLoop.start();
    }

    /**
     * Start a specific slot for linear playback
     */
    private startLinearSlot(index: number): void {
        const slots = this.slots;
        if (index < 0 || index >= slots.length) return;

        // Stop all other slots
        slots.forEach((slot, i) => {
            if (i === index) {
                slot.player.loop = false; // Don't loop individual animations
                slot.stop(); // Reset to frame 0
                slot.play();
            } else {
                slot.stop();
            }
        });

        this.emit('linear-slot-changed', index);
    }

    /**
     * Move to next slot in linear mode
     */
    private advanceLinearSlot(): void {
        const slots = this.slots;
        this._currentLinearSlotIndex++;

        if (this._currentLinearSlotIndex >= slots.length) {
            // Loop back to start
            this._currentLinearSlotIndex = 0;
        }

        this.startLinearSlot(this._currentLinearSlotIndex);
    }

    private update(deltaTime: number): void {
        if (this._displayMode === 'grid') {
            // Grid mode: update all slots
            this._slots.forEach(slot => slot.update(deltaTime));
        } else {
            // Linear mode: update only current slot and check for completion
            const slots = this.slots;
            const currentSlot = slots[this._currentLinearSlotIndex];

            if (currentSlot) {
                currentSlot.update(deltaTime);

                // Check if animation completed (reached last frame and not looping)
                const player = currentSlot.player;
                if (!player.isPlaying && this._playing) {
                    // Animation finished, move to next
                    this.advanceLinearSlot();
                }
            }
        }

        this.emit('frame-updated');
    }

    // ========================================================================
    // Rendering
    // ========================================================================

    render(ctx: CanvasRenderingContext2D, panX: number = 0, panY: number = 0, zoom: number = 1): void {
        ctx.save();
        ctx.translate(panX, panY);
        ctx.scale(zoom, zoom);

        if (this._displayMode === 'grid') {
            // Grid mode: render all slots
            for (const slot of this.slots) {
                slot.render(ctx);
            }
        } else {
            // Linear mode: render only current slot at pivot
            const slots = this.slots;
            const currentSlot = slots[this._currentLinearSlotIndex];
            if (currentSlot) {
                currentSlot.render(ctx);
            }
        }

        // Render selection box for selected slot (grid mode only)
        if (this._displayMode === 'grid' && this.selectedSlot) {
            this.renderSelectionBox(ctx, this.selectedSlot);
        }

        ctx.restore();
    }

    private renderSelectionBox(ctx: CanvasRenderingContext2D, slot: AnimationSlot): void {
        const bounds = slot.getBounds();
        if (!bounds) return;

        ctx.strokeStyle = '#4fc3f7';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(bounds.x, bounds.y, bounds.w, bounds.h);
        ctx.setLineDash([]);

        // Draw corner handles
        const handleSize = 8;
        ctx.fillStyle = '#4fc3f7';

        // Corners
        ctx.fillRect(bounds.x - handleSize / 2, bounds.y - handleSize / 2, handleSize, handleSize);
        ctx.fillRect(bounds.x + bounds.w - handleSize / 2, bounds.y - handleSize / 2, handleSize, handleSize);
        ctx.fillRect(bounds.x - handleSize / 2, bounds.y + bounds.h - handleSize / 2, handleSize, handleSize);
        ctx.fillRect(bounds.x + bounds.w - handleSize / 2, bounds.y + bounds.h - handleSize / 2, handleSize, handleSize);
    }

    // ========================================================================
    // State
    // ========================================================================

    getState(): PlayerModeState {
        return {
            slots: this.slots.map(s => s.toData()),
            selectedSlotId: this._selectedSlotId,
            displayMode: this._displayMode
        };
    }

    clear(): void {
        this.stop();
        this._slots.clear();
        this._selectedSlotId = null;
        this._currentLinearSlotIndex = 0;
        this.emit('cleared');
    }

    // ========================================================================
    // Utilities
    // ========================================================================

    private extractName(path: string): string {
        const filename = path.split(/[/\\]/).pop() || 'animation';
        return filename.replace(/\.[^/.]+$/, ''); // Remove extension
    }
}

