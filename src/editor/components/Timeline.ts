/**
 * Timeline Component - Animation frame timeline
 * @module editor/components/Timeline
 */

import { Frame } from '../../core/models/Frame';
import { Animation } from '../../core/models/Animation';
import {
    TIMELINE_HEIGHT,
    FRAME_THUMBNAIL_SIZE,
    FRAME_THUMBNAIL_SPACING,
    COLORS
} from '../../shared/constants';
import { EventEmitter, EditorEvents } from '../../shared/events';
import { createElement, clearElement } from '../../shared/utils';

export interface TimelineOptions {
    container: HTMLElement;
}

export class Timeline extends EventEmitter {
    private _container: HTMLElement;
    private _element!: HTMLElement;
    private _frameList!: HTMLElement;
    private _scrollContainer!: HTMLElement;

    private _animation: Animation | null = null;
    private _selectedIndex: number = -1;
    private _dragIndex: number = -1;
    private _dragOverIndex: number = -1;
    private _playingIndex: number = -1;

    constructor(options: TimelineOptions) {
        super();
        this._container = options.container;

        this.createDOM();
        this.setupEventListeners();
    }

    // ========================================================================
    // Accessors
    // ========================================================================

    get selectedIndex(): number {
        return this._selectedIndex;
    }

    set selectedIndex(value: number) {
        const prev = this._selectedIndex;
        this._selectedIndex = value;
        this.updateSelection();

        if (prev !== value) {
            this.emit(EditorEvents.FRAME_SELECTED, value);
        }
    }

    get selectedFrame(): Frame | undefined {
        return this._animation?.getFrame(this._selectedIndex);
    }

    // ========================================================================
    // DOM Creation
    // ========================================================================

    private createDOM(): void {
        this._element = createElement('div', 'timeline', this._container);
        this._element.style.height = `${TIMELINE_HEIGHT}px`;

        // Controls bar
        const controls = createElement('div', 'timeline-controls', this._element);

        // Frame counter
        const counter = createElement('span', 'timeline-counter', controls);
        counter.id = 'frame-counter';
        counter.textContent = '0 / 0';

        // Duration input
        const durationGroup = createElement('div', 'timeline-input-group', controls);
        const durationLabel = createElement('label', '', durationGroup);
        durationLabel.textContent = 'Duration:';
        const durationInput = createElement('input', 'timeline-duration', durationGroup);
        durationInput.type = 'number';
        durationInput.id = 'frame-duration';
        durationInput.min = '0.1';
        durationInput.max = '10';
        durationInput.step = '0.1';
        durationInput.value = '1.0';
        durationInput.addEventListener('change', () => {
            const frame = this.selectedFrame;
            if (frame) {
                frame.duration = parseFloat(durationInput.value);
                this.emit(EditorEvents.ANIMATION_UPDATED);
            }
        });

        // Scroll container for frames
        this._scrollContainer = createElement('div', 'timeline-scroll', this._element);
        this._frameList = createElement('div', 'timeline-frames', this._scrollContainer);
    }

    // ========================================================================
    // Animation Management
    // ========================================================================

    setAnimation(animation: Animation | null): void {
        this._animation = animation;
        this._selectedIndex = animation && animation.frameCount > 0 ? 0 : -1;
        this.refreshFrameList();
    }

    refreshFrameList(): void {
        clearElement(this._frameList);

        if (!this._animation) {
            this.updateCounter();
            return;
        }

        this._animation.frames.forEach((frame, index) => {
            const frameEl = this.createFrameElement(frame, index);
            this._frameList.appendChild(frameEl);
        });

        this.updateCounter();
        this.updateSelection();
    }

    private createFrameElement(frame: Frame, index: number): HTMLElement {
        const el = createElement('div', 'timeline-frame');
        el.dataset.index = String(index);
        el.draggable = true;

        // Thumbnail
        const thumb = createElement('div', 'timeline-thumb', el);
        if (frame.image?.element) {
            const canvas = createElement('canvas') as HTMLCanvasElement;
            canvas.width = FRAME_THUMBNAIL_SIZE;
            canvas.height = FRAME_THUMBNAIL_SIZE;

            const ctx = canvas.getContext('2d');
            if (ctx) {
                // Scale to fit
                const scale = Math.min(
                    FRAME_THUMBNAIL_SIZE / frame.sourceRect.w,
                    FRAME_THUMBNAIL_SIZE / frame.sourceRect.h
                );
                const w = frame.sourceRect.w * scale;
                const h = frame.sourceRect.h * scale;
                const x = (FRAME_THUMBNAIL_SIZE - w) / 2;
                const y = (FRAME_THUMBNAIL_SIZE - h) / 2;

                ctx.imageSmoothingEnabled = false;
                ctx.drawImage(
                    frame.image.element,
                    frame.sourceRect.x, frame.sourceRect.y,
                    frame.sourceRect.w, frame.sourceRect.h,
                    x, y, w, h
                );
            }
            thumb.appendChild(canvas);
        }

        // Index label
        const label = createElement('span', 'timeline-label', el);
        label.textContent = String(index);

        // Selection event
        el.addEventListener('click', () => {
            this.selectedIndex = index;
        });

        // Double click to focus
        el.addEventListener('dblclick', () => {
            this.emit(EditorEvents.VIEWPORT_CHANGED, { action: 'center-frame' });
        });

        // Drag events
        el.addEventListener('dragstart', (e) => this.onDragStart(e, index));
        el.addEventListener('dragover', (e) => this.onDragOver(e, index));
        el.addEventListener('dragleave', () => this.onDragLeave(index));
        el.addEventListener('drop', (e) => this.onDrop(e, index));
        el.addEventListener('dragend', () => this.onDragEnd());

        // Right-click context menu
        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.selectedIndex = index;
            this.emit(EditorEvents.FRAME_CONTEXT_MENU, { index, x: e.clientX, y: e.clientY });
        });

        return el;
    }

    // ========================================================================
    // Selection
    // ========================================================================

    private updateSelection(): void {
        const frames = this._frameList.querySelectorAll('.timeline-frame');
        frames.forEach((el, idx) => {
            el.classList.toggle('selected', idx === this._selectedIndex);
        });

        // Update duration input
        const frame = this.selectedFrame;
        const durationInput = document.getElementById('frame-duration') as HTMLInputElement;
        if (durationInput && frame) {
            durationInput.value = frame.duration.toFixed(1);
        }
    }

    private updateCounter(): void {
        const counter = document.getElementById('frame-counter');
        if (counter) {
            const total = this._animation?.frameCount ?? 0;
            const current = this._selectedIndex >= 0 ? this._selectedIndex + 1 : 0;
            counter.textContent = `${current} / ${total}`;
        }
    }

    setPlayingIndex(index: number): void {
        this._playingIndex = index;
        this.updatePlayingFrame();
    }

    private updatePlayingFrame(): void {
        const frames = this._frameList.querySelectorAll('.timeline-frame');
        frames.forEach((el, idx) => {
            el.classList.toggle('playing', idx === this._playingIndex);
        });
    }

    selectNext(): void {
        if (!this._animation) return;
        this.selectedIndex = Math.min(
            this._selectedIndex + 1,
            this._animation.frameCount - 1
        );
        this.scrollToSelected();
    }

    selectPrevious(): void {
        if (!this._animation) return;
        this.selectedIndex = Math.max(this._selectedIndex - 1, 0);
        this.scrollToSelected();
    }

    selectFirst(): void {
        if (!this._animation) return;
        this.selectedIndex = 0;
        this.scrollToSelected();
    }

    selectLast(): void {
        if (!this._animation) return;
        this.selectedIndex = this._animation.frameCount - 1;
        this.scrollToSelected();
    }

    private scrollToSelected(): void {
        const frameEl = this._frameList.children[this._selectedIndex] as HTMLElement;
        if (frameEl) {
            frameEl.scrollIntoView({ behavior: 'smooth', inline: 'center' });
        }
    }

    // ========================================================================
    // Drag & Drop Reordering
    // ========================================================================

    private onDragStart(e: DragEvent, index: number): void {
        this._dragIndex = index;
        e.dataTransfer!.effectAllowed = 'move';

        const el = this._frameList.children[index] as HTMLElement;
        el.classList.add('dragging');
    }

    private onDragOver(e: DragEvent, index: number): void {
        e.preventDefault();
        e.dataTransfer!.dropEffect = 'move';

        if (this._dragOverIndex !== index) {
            this.clearDragOver();
            this._dragOverIndex = index;
            const el = this._frameList.children[index] as HTMLElement;
            el.classList.add('drag-over');
        }
    }

    private onDragLeave(index: number): void {
        if (this._dragOverIndex === index) {
            this.clearDragOver();
        }
    }

    private onDrop(e: DragEvent, index: number): void {
        e.preventDefault();

        if (this._animation && this._dragIndex >= 0 && this._dragIndex !== index) {
            this._animation.moveFrame(this._dragIndex, index);
            this._selectedIndex = index;
            this.refreshFrameList();
            this.emit(EditorEvents.ANIMATION_UPDATED);
        }

        this.clearDragOver();
    }

    private onDragEnd(): void {
        const el = this._frameList.children[this._dragIndex] as HTMLElement;
        if (el) el.classList.remove('dragging');

        this._dragIndex = -1;
        this.clearDragOver();
    }

    private clearDragOver(): void {
        if (this._dragOverIndex >= 0) {
            const el = this._frameList.children[this._dragOverIndex] as HTMLElement;
            if (el) el.classList.remove('drag-over');
        }
        this._dragOverIndex = -1;
    }

    // ========================================================================
    // Event Listeners
    // ========================================================================

    private setupEventListeners(): void {
        // Keyboard navigation
        this._element.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowLeft') {
                this.selectPrevious();
            } else if (e.key === 'ArrowRight') {
                this.selectNext();
            } else if (e.key === 'Home') {
                this.selectFirst();
            } else if (e.key === 'End') {
                this.selectLast();
            }
        });

        this._element.tabIndex = 0;
    }

    // ========================================================================
    // Visibility
    // ========================================================================

    show(): void {
        this._element.style.display = 'flex';
    }

    hide(): void {
        this._element.style.display = 'none';
    }

    // ========================================================================
    // Cleanup
    // ========================================================================

    destroy(): void {
        this._container.removeChild(this._element);
        this.removeAllListeners();
    }
}
