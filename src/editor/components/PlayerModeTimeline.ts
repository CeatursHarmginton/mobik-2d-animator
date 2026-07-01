/**
 * Player Mode Timeline - Shows list of imported animations
 * Replaces frame-based timeline in Player Mode
 * @module editor/components/PlayerModeTimeline
 */

import { EventEmitter, EditorEvents } from '../../shared/events';
import { AnimationSlot } from '../player/AnimationSlot';
import { PlayerModeController, PlayerDisplayMode } from '../player/PlayerModeController';

export interface PlayerModeTimelineOptions {
    container: HTMLElement;
    controller: PlayerModeController;
}

export class PlayerModeTimeline extends EventEmitter {
    private _container: HTMLElement;
    private _controller: PlayerModeController;
    private _element: HTMLElement | null = null;
    private _listElement: HTMLElement | null = null;

    // Drag reorder
    private _draggedSlotId: string | null = null;
    private _dragOverSlotId: string | null = null;

    constructor(options: PlayerModeTimelineOptions) {
        super();
        this._container = options.container;
        this._controller = options.controller;

        this.render();
        this.setupControllerListeners();
    }

    private render(): void {
        this._element = document.createElement('div');
        this._element.className = 'player-timeline';
        this._element.innerHTML = `
            <div class="timeline-controls">
                <span class="timeline-counter">${this._controller.slotCount} animations</span>
                <button class="btn btn-sm" id="player-import-btn">+ Import</button>
                <div class="player-mode-toggle">
                    <button class="player-mode-btn" data-mode="linear">Linear</button>
                    <button class="player-mode-btn active" data-mode="grid">Grid</button>
                </div>
                <div style="flex:1;"></div>
            </div>
            <div class="timeline-scroll">
                <div class="player-timeline-slots"></div>
            </div>
        `;

        this._listElement = this._element.querySelector('.player-timeline-slots');

        // Event handlers
        this._element.querySelector('#player-import-btn')?.addEventListener('click', () => {
            this.emit('import-requested');
        });

        // Mode toggle buttons
        this._element.querySelectorAll('.player-mode-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const target = e.currentTarget as HTMLElement;
                const mode = target.dataset.mode as PlayerDisplayMode;
                this._controller.setDisplayMode(mode);
                this.updateModeButtons();
            });
        });

        this._container.appendChild(this._element);
        this.refreshSlotList();
    }

    private setupControllerListeners(): void {
        this._controller.on('slot-added', () => this.refreshSlotList());
        this._controller.on('slot-removed', () => this.refreshSlotList());
        this._controller.on('selection-changed', () => this.updateSelection());
        this._controller.on('playback-changed', () => this.updatePlayingState());
        this._controller.on('mode-changed', () => this.updateModeButtons());
        this._controller.on('linear-slot-changed', () => this.updateLinearSlotHighlight());
    }

    private updateModeButtons(): void {
        const mode = this._controller.displayMode;
        this._element?.querySelectorAll('.player-mode-btn').forEach(btn => {
            const btnMode = (btn as HTMLElement).dataset.mode;
            btn.classList.toggle('active', btnMode === mode);
        });
    }

    private updatePlayingState(): void {
        // Update slot visual states when playback changes
        this.refreshSlotList();
    }

    private updateLinearSlotHighlight(): void {
        if (this._controller.displayMode !== 'linear') return;

        const currentIndex = this._controller.currentLinearSlotIndex;
        const slots = this._controller.slots;

        this._listElement?.querySelectorAll('.player-slot').forEach((el, index) => {
            el.classList.toggle('playing', index === currentIndex);
        });
    }

    refreshSlotList(): void {
        if (!this._listElement) return;

        this._listElement.innerHTML = '';
        const slots = this._controller.slots;

        if (slots.length === 0) {
            this._listElement.innerHTML = `
                <div class="player-empty-message">
                    No animations imported.<br>
                    Click Import to add sprite sheets.
                </div>
            `;
            return;
        }

        for (const slot of slots) {
            const slotEl = this.createSlotElement(slot);
            this._listElement.appendChild(slotEl);
        }

        // Update counter
        const counter = this._element?.querySelector('.timeline-counter');
        if (counter) {
            counter.textContent = `${slots.length} animation${slots.length !== 1 ? 's' : ''}`;
        }

        // Update linear highlight if needed
        this.updateLinearSlotHighlight();
    }

    private createSlotElement(slot: AnimationSlot): HTMLElement {
        const el = document.createElement('div');
        el.className = 'player-slot';
        el.dataset.slotId = slot.id;

        if (slot.id === this._controller.selectedSlotId) {
            el.classList.add('selected');
        }

        el.innerHTML = `
            <div class="player-slot-thumb">
                <canvas width="48" height="48"></canvas>
            </div>
            <div class="player-slot-info">
                <span class="player-slot-name">${slot.animationName}</span>
                <span class="player-slot-details">${slot.frameCount} frames</span>
            </div>
            <div class="player-slot-controls">
                <button class="player-slot-btn visibility-btn" title="Toggle Visibility">
                    ${slot.visible ? '👁' : '👁‍🗨'}
                </button>
                <button class="player-slot-btn delete-btn" title="Remove">✕</button>
            </div>
        `;

        // Draw thumbnail
        this.drawSlotThumbnail(el.querySelector('canvas')!, slot);

        // Click to select
        el.addEventListener('click', (e) => {
            if (!(e.target as HTMLElement).closest('button')) {
                this._controller.selectSlot(slot.id);
            }
        });

        // Visibility toggle
        el.querySelector('.visibility-btn')?.addEventListener('click', () => {
            slot.visible = !slot.visible;
            this.refreshSlotList();
            this.emit('slot-visibility-changed', slot);
        });

        // Delete button
        el.querySelector('.delete-btn')?.addEventListener('click', () => {
            this._controller.removeSlot(slot.id);
        });

        // Drag and drop for reordering
        el.draggable = true;
        el.addEventListener('dragstart', (e) => {
            this._draggedSlotId = slot.id;
            el.classList.add('dragging');
        });

        el.addEventListener('dragend', () => {
            this._draggedSlotId = null;
            el.classList.remove('dragging');
            document.querySelectorAll('.player-slot.drag-over').forEach(e => e.classList.remove('drag-over'));
        });

        el.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (this._draggedSlotId && this._draggedSlotId !== slot.id) {
                el.classList.add('drag-over');
            }
        });

        el.addEventListener('dragleave', () => {
            el.classList.remove('drag-over');
        });

        el.addEventListener('drop', (e) => {
            e.preventDefault();
            el.classList.remove('drag-over');
            if (this._draggedSlotId && this._draggedSlotId !== slot.id) {
                const slots = this._controller.slots;
                const fromIndex = slots.findIndex(s => s.id === this._draggedSlotId);
                const toIndex = slots.findIndex(s => s.id === slot.id);
                this._controller.reorderSlots(fromIndex, toIndex);
                this.refreshSlotList();
            }
        });

        return el;
    }

    private drawSlotThumbnail(canvas: HTMLCanvasElement, slot: AnimationSlot): void {
        const ctx = canvas.getContext('2d');
        if (!ctx || !slot.spriteSheet || !slot.isReady) return;

        const frame = slot.player.currentFrame;
        if (!frame) return;

        ctx.imageSmoothingEnabled = false;

        // Calculate scale to fit
        const scale = Math.min(48 / frame.sourceRect.w, 48 / frame.sourceRect.h);
        const w = frame.sourceRect.w * scale;
        const h = frame.sourceRect.h * scale;
        const x = (48 - w) / 2;
        const y = (48 - h) / 2;

        ctx.clearRect(0, 0, 48, 48);
        ctx.drawImage(
            slot.spriteSheet,
            frame.sourceRect.x, frame.sourceRect.y,
            frame.sourceRect.w, frame.sourceRect.h,
            x, y, w, h
        );
    }

    private updateSelection(): void {
        if (!this._listElement) return;

        this._listElement.querySelectorAll('.player-slot').forEach(el => {
            const slotId = (el as HTMLElement).dataset.slotId;
            el.classList.toggle('selected', slotId === this._controller.selectedSlotId);
        });
    }

    show(): void {
        if (this._element) {
            this._element.style.display = 'flex';
        }
    }

    hide(): void {
        if (this._element) {
            this._element.style.display = 'none';
        }
    }

    destroy(): void {
        this._element?.remove();
    }
}

