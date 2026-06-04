/**
 * Pivot Editor Component - Numeric pivot point controls
 * @module editor/components/PivotEditor
 */

import { Frame } from '../../core/models/Frame';
import { Point } from '../../core/models/types';
import { EventEmitter, EditorEvents } from '../../shared/events';
import { createElement, round } from '../../shared/utils';

export interface PivotEditorOptions {
    container: HTMLElement;
}

export class PivotEditor extends EventEmitter {
    private _container: HTMLElement;
    private _element!: HTMLElement;
    private _currentFrame: Frame | null = null;

    private _pivotXInput!: HTMLInputElement;
    private _pivotYInput!: HTMLInputElement;
    private _offsetXInput!: HTMLInputElement;
    private _offsetYInput!: HTMLInputElement;

    constructor(options: PivotEditorOptions) {
        super();
        this._container = options.container;
        this.createDOM();
    }

    // ========================================================================
    // DOM Creation
    // ========================================================================

    private createDOM(): void {
        this._element = createElement('div', 'pivot-editor', this._container);

        // Section header
        const header = createElement('div', 'panel-header', this._element);
        header.textContent = 'Transform';

        // Pivot section
        const pivotSection = createElement('div', 'panel-section', this._element);
        const pivotLabel = createElement('label', 'panel-label', pivotSection);
        pivotLabel.textContent = 'Pivot (normalized)';

        const pivotRow = createElement('div', 'panel-row', pivotSection);

        // Pivot X
        const pivotXGroup = createElement('div', 'input-group', pivotRow);
        const pivotXLabel = createElement('span', 'input-label', pivotXGroup);
        pivotXLabel.textContent = 'X';
        this._pivotXInput = createElement('input', 'input-number', pivotXGroup);
        this._pivotXInput.type = 'number';
        this._pivotXInput.min = '0';
        this._pivotXInput.max = '1';
        this._pivotXInput.step = '0.01';
        this._pivotXInput.value = '0.5';
        this._pivotXInput.addEventListener('change', () => this.onPivotChange());

        // Pivot Y
        const pivotYGroup = createElement('div', 'input-group', pivotRow);
        const pivotYLabel = createElement('span', 'input-label', pivotYGroup);
        pivotYLabel.textContent = 'Y';
        this._pivotYInput = createElement('input', 'input-number', pivotYGroup);
        this._pivotYInput.type = 'number';
        this._pivotYInput.min = '0';
        this._pivotYInput.max = '1';
        this._pivotYInput.step = '0.01';
        this._pivotYInput.value = '1';
        this._pivotYInput.addEventListener('change', () => this.onPivotChange());

        // Preset buttons
        const presetRow = createElement('div', 'panel-row presets', pivotSection);
        const presets = [
            { label: 'TL', pivot: { x: 0, y: 0 } },
            { label: 'TC', pivot: { x: 0.5, y: 0 } },
            { label: 'TR', pivot: { x: 1, y: 0 } },
            { label: 'ML', pivot: { x: 0, y: 0.5 } },
            { label: 'MC', pivot: { x: 0.5, y: 0.5 } },
            { label: 'MR', pivot: { x: 1, y: 0.5 } },
            { label: 'BL', pivot: { x: 0, y: 1 } },
            { label: 'BC', pivot: { x: 0.5, y: 1 } },
            { label: 'BR', pivot: { x: 1, y: 1 } }
        ];

        presets.forEach(preset => {
            const btn = createElement('button', 'preset-btn', presetRow);
            btn.textContent = preset.label;
            btn.title = `Set pivot to ${preset.label}`;
            btn.addEventListener('click', () => {
                this.setPivot(preset.pivot);
            });
        });

        // Offset section
        const offsetSection = createElement('div', 'panel-section', this._element);
        const offsetLabel = createElement('label', 'panel-label', offsetSection);
        offsetLabel.textContent = 'Offset (pixels)';

        const offsetRow = createElement('div', 'panel-row', offsetSection);

        // Offset X
        const offsetXGroup = createElement('div', 'input-group', offsetRow);
        const offsetXLabel = createElement('span', 'input-label', offsetXGroup);
        offsetXLabel.textContent = 'X';
        this._offsetXInput = createElement('input', 'input-number', offsetXGroup);
        this._offsetXInput.type = 'number';
        this._offsetXInput.step = '1';
        this._offsetXInput.value = '0';
        this._offsetXInput.addEventListener('change', () => this.onOffsetChange());

        // Offset Y
        const offsetYGroup = createElement('div', 'input-group', offsetRow);
        const offsetYLabel = createElement('span', 'input-label', offsetYGroup);
        offsetYLabel.textContent = 'Y';
        this._offsetYInput = createElement('input', 'input-number', offsetYGroup);
        this._offsetYInput.type = 'number';
        this._offsetYInput.step = '1';
        this._offsetYInput.value = '0';
        this._offsetYInput.addEventListener('change', () => this.onOffsetChange());

        // Batch operations
        const batchSection = createElement('div', 'panel-section', this._element);
        const batchLabel = createElement('label', 'panel-label', batchSection);
        batchLabel.textContent = 'Batch Operations';

        const batchRow = createElement('div', 'panel-row batch', batchSection);

        const applyAllBtn = createElement('button', 'btn btn-secondary', batchRow);
        applyAllBtn.textContent = 'Apply to All';
        applyAllBtn.addEventListener('click', () => this.applyToAll());

        const alignCenterBtn = createElement('button', 'btn btn-secondary', batchRow);
        alignCenterBtn.textContent = 'Align Center';
        alignCenterBtn.addEventListener('click', () => this.emit('align-center'));

        const alignBottomBtn = createElement('button', 'btn btn-secondary', batchRow);
        alignBottomBtn.textContent = 'Align Bottom';
        alignBottomBtn.addEventListener('click', () => this.emit('align-bottom'));
    }

    // ========================================================================
    // Frame Management
    // ========================================================================

    setFrame(frame: Frame | null): void {
        this._currentFrame = frame;
        this.updateInputs();
    }

    updateInputs(): void {
        if (!this._currentFrame) {
            this._pivotXInput.value = '0.5';
            this._pivotYInput.value = '1';
            this._offsetXInput.value = '0';
            this._offsetYInput.value = '0';
            return;
        }

        this._pivotXInput.value = round(this._currentFrame.pivot.x, 2).toString();
        this._pivotYInput.value = round(this._currentFrame.pivot.y, 2).toString();
        this._offsetXInput.value = Math.round(this._currentFrame.offset.x).toString();
        this._offsetYInput.value = Math.round(this._currentFrame.offset.y).toString();
    }

    // ========================================================================
    // Operations
    // ========================================================================

    private setPivot(pivot: Point): void {
        if (!this._currentFrame) return;

        this._currentFrame.pivot = { ...pivot };
        this.updateInputs();
        this.emit(EditorEvents.PIVOT_CHANGED, pivot);
    }

    private onPivotChange(): void {
        if (!this._currentFrame) return;

        const x = parseFloat(this._pivotXInput.value) || 0;
        const y = parseFloat(this._pivotYInput.value) || 0;

        this._currentFrame.pivot = {
            x: Math.max(0, Math.min(1, x)),
            y: Math.max(0, Math.min(1, y))
        };

        this.emit(EditorEvents.PIVOT_CHANGED, this._currentFrame.pivot);
    }

    private onOffsetChange(): void {
        if (!this._currentFrame) return;

        this._currentFrame.offset = {
            x: parseInt(this._offsetXInput.value) || 0,
            y: parseInt(this._offsetYInput.value) || 0
        };

        this.emit(EditorEvents.ANIMATION_UPDATED);
    }

    private applyToAll(): void {
        if (!this._currentFrame) return;

        this.emit('apply-all', {
            pivot: { ...this._currentFrame.pivot },
            offset: { ...this._currentFrame.offset }
        });
    }

    // ========================================================================
    // Visibility
    // ========================================================================

    show(): void {
        this._element.style.display = 'block';
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
