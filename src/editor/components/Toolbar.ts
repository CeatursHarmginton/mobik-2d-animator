/**
 * Toolbar Component - Main editor toolbar
 * @module editor/components/Toolbar
 */

import { EventEmitter } from '../../shared/events';
import { createElement } from '../../shared/utils';

export interface ToolbarOptions {
    container: HTMLElement;
}

export type ToolbarAction =
    | 'load-frames'
    | 'load-sheet'
    | 'save-project'
    | 'export'
    | 'play-pause'
    | 'prev-frame'
    | 'next-frame'
    | 'first-frame'
    | 'last-frame'
    | 'toggle-onion'
    | 'toggle-grid'
    | 'toggle-reference'
    | 'toggle-bounds'
    | 'reset-view'
    | 'zoom-in'
    | 'zoom-out';

export class Toolbar extends EventEmitter {
    private _container: HTMLElement;
    private _element!: HTMLElement;
    private _playBtn!: HTMLButtonElement;
    private _onionBtn!: HTMLButtonElement;
    private _gridBtn!: HTMLButtonElement;
    private _refBtn!: HTMLButtonElement;

    private _isPlaying: boolean = false;
    private _onionEnabled: boolean = false;
    private _gridEnabled: boolean = true;
    private _referenceEnabled: boolean = false;
    private _boundsEnabled: boolean = false;
    private _boundsBtn!: HTMLButtonElement;

    constructor(options: ToolbarOptions) {
        super();
        this._container = options.container;
        this.createDOM();
    }

    // ========================================================================
    // Accessors
    // ========================================================================

    get isPlaying(): boolean {
        return this._isPlaying;
    }

    set isPlaying(value: boolean) {
        this._isPlaying = value;
        this.updatePlayButton();
    }

    get onionEnabled(): boolean {
        return this._onionEnabled;
    }

    set onionEnabled(value: boolean) {
        this._onionEnabled = value;
        this._onionBtn.classList.toggle('active', value);
    }

    get gridEnabled(): boolean {
        return this._gridEnabled;
    }

    set gridEnabled(value: boolean) {
        this._gridEnabled = value;
        this._gridBtn.classList.toggle('active', value);
    }

    get referenceEnabled(): boolean {
        return this._referenceEnabled;
    }

    set referenceEnabled(value: boolean) {
        this._referenceEnabled = value;
        this._refBtn.classList.toggle('active', value);
    }

    get boundingBoxEnabled(): boolean {
        return this._boundsEnabled;
    }

    set boundingBoxEnabled(value: boolean) {
        this._boundsEnabled = value;
        this._boundsBtn.classList.toggle('active', value);
    }

    // ========================================================================
    // DOM Creation
    // ========================================================================

    private createDOM(): void {
        this._element = createElement('div', 'toolbar', this._container);

        // Left group - File operations
        const leftGroup = createElement('div', 'toolbar-group', this._element);

        this.createButton(leftGroup, 'Load Frames', 'folder_open', 'load-frames');
        this.createButton(leftGroup, 'Load Sheet', 'image', 'load-sheet');
        this.createButton(leftGroup, 'Reference Mode', 'compare', 'toggle-reference');
        this.createSeparator(leftGroup);
        this.createButton(leftGroup, 'Save Project', 'save', 'save-project');
        this.createButton(leftGroup, 'Export JSON', 'download', 'export');

        // Center group - Playback
        const centerGroup = createElement('div', 'toolbar-group center', this._element);

        this.createButton(centerGroup, 'First Frame', 'first_page', 'first-frame');
        this.createButton(centerGroup, 'Previous Frame', 'chevron_left', 'prev-frame');
        this._playBtn = this.createButton(centerGroup, 'Play', 'play_arrow', 'play-pause');
        this._playBtn.classList.add('btn-primary');
        this.createButton(centerGroup, 'Next Frame', 'chevron_right', 'next-frame');
        this.createButton(centerGroup, 'Last Frame', 'last_page', 'last-frame');

        // Right group - View
        const rightGroup = createElement('div', 'toolbar-group right', this._element);

        this._onionBtn = this.createButton(rightGroup, 'Onion Skin', 'layers', 'toggle-onion');
        this._gridBtn = this.createButton(rightGroup, 'Grid', 'grid_on', 'toggle-grid');
        this._gridBtn.classList.add('active');
        this._refBtn = this.createButton(rightGroup, 'Reference', 'compare', 'toggle-reference');
        this._boundsBtn = this.createButton(rightGroup, 'Bounding Box', 'check_box_outline_blank', 'toggle-bounds');
        this.createSeparator(rightGroup);
        this.createButton(rightGroup, 'Zoom In', 'zoom_in', 'zoom-in');
        this.createButton(rightGroup, 'Zoom Out', 'zoom_out', 'zoom-out');
        this.createButton(rightGroup, 'Reset View', 'fit_screen', 'reset-view');

        // FPS control
        const fpsGroup = createElement('div', 'toolbar-group fps-group', this._element);
        const fpsLabel = createElement('label', 'toolbar-label', fpsGroup);
        fpsLabel.textContent = 'FPS:';
        const fpsInput = createElement('input', 'toolbar-input', fpsGroup);
        fpsInput.type = 'number';
        fpsInput.id = 'fps-input';
        fpsInput.min = '1';
        fpsInput.max = '60';
        fpsInput.value = '12';
        fpsInput.addEventListener('change', () => {
            const fps = parseInt(fpsInput.value) || 12;
            this.emit('fps-changed', fps);
        });

        // Speed multiplier control
        const speedGroup = createElement('div', 'toolbar-group speed-group', this._element);
        const speedLabel = createElement('label', 'toolbar-label', speedGroup);
        speedLabel.textContent = 'Speed:';
        const speedSelect = createElement('select', 'toolbar-select', speedGroup);
        speedSelect.id = 'speed-select';
        const speeds = [
            { value: '0.25', label: '0.25x' },
            { value: '0.5', label: '0.5x' },
            { value: '1', label: '1x' },
            { value: '2', label: '2x' },
            { value: '4', label: '4x' }
        ];
        speeds.forEach(s => {
            const option = document.createElement('option');
            option.value = s.value;
            option.textContent = s.label;
            if (s.value === '1') option.selected = true;
            speedSelect.appendChild(option);
        });
        speedSelect.addEventListener('change', () => {
            const speed = parseFloat(speedSelect.value) || 1;
            this.emit('speed-changed', speed);
        });
    }

    private createButton(
        parent: HTMLElement,
        title: string,
        iconName: string,
        action: ToolbarAction
    ): HTMLButtonElement {
        const btn = createElement('button', 'toolbar-btn', parent);
        btn.title = title;
        btn.dataset.action = action;

        // Material Symbol
        const iconEl = createElement('span', 'material-symbols-rounded', btn);
        iconEl.textContent = iconName;

        btn.addEventListener('click', () => {
            this.emit('action', action);
        });

        return btn;
    }

    private createSeparator(parent: HTMLElement): void {
        createElement('div', 'toolbar-separator', parent);
    }

    // ========================================================================
    // Updates
    // ========================================================================

    private updatePlayButton(): void {
        const icon = this._playBtn.querySelector('.material-symbols-rounded');
        if (icon) {
            icon.textContent = this._isPlaying ? 'pause' : 'play_arrow';
        }
        this._playBtn.title = this._isPlaying ? 'Pause' : 'Play';
    }

    setFPS(fps: number): void {
        const input = document.getElementById('fps-input') as HTMLInputElement;
        if (input) {
            input.value = String(fps);
        }
    }

    // ========================================================================
    // Cleanup
    // ========================================================================

    destroy(): void {
        this._container.removeChild(this._element);
        this.removeAllListeners();
    }
}
