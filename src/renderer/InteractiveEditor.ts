import { Project } from '../core/models/Project';
import { Canvas } from '../editor/components/Canvas';
import { InteractiveConfig, MascotHitAreaConfig, MascotQueueStep, MascotRuleConfig, MascotStateConfig, PoseSetConfig } from '../core/runtime/types';
import { round } from '../shared/utils';

export interface InteractiveEditorSnapshot {
    enabled: boolean;
    config: InteractiveConfig;
    poseSets: Record<string, PoseSetConfig>;
    warnings: string[];
}

export interface InteractiveEditorOptions {
    container: HTMLElement;
    canvas: Canvas;
    getProject: () => Project;
    getSelectedFrameIndex: () => number;
    markDirty: () => void;
}

export class InteractiveEditor {
    private _container: HTMLElement;
    private _canvas: Canvas;
    private _getProject: () => Project;
    private _getSelectedFrameIndex: () => number;
    private _markDirty: () => void;
    private _enabled = false;
    private _activeTab = 'overview';
    private _config: InteractiveConfig;
    private _poseSets: Record<string, PoseSetConfig> = {};
    private _overlay: HTMLCanvasElement | null = null;
    private _overlayCtx: CanvasRenderingContext2D | null = null;
    private _drawEnabled = false;
    private _draftStart: { x: number; y: number } | null = null;
    private _draftRect: { x: number; y: number; w: number; h: number } | null = null;

    constructor(options: InteractiveEditorOptions) {
        this._container = options.container;
        this._canvas = options.canvas;
        this._getProject = options.getProject;
        this._getSelectedFrameIndex = options.getSelectedFrameIndex;
        this._markDirty = options.markDirty;
        this._config = this.createDefaultConfig();
        this.setupOverlay();
        this.render();
    }

    getSnapshot(): InteractiveEditorSnapshot {
        this.ensureDefaults();
        return { enabled: this._enabled, config: this.clone(this._config), poseSets: this.clone(this._poseSets), warnings: this.validate() };
    }

    setFromMeta(meta: any): void {
        this._enabled = Boolean(meta?.interactive || meta?.format === 'mobik-interactive-mascot');
        this._config = this.clone(meta?.interactive || this.createDefaultConfig());
        this._poseSets = this.clone(meta?.poseSets || {});
        this.ensureDefaults();
        this.render();
    }

    resetForProject(): void {
        this._enabled = false;
        this._config = this.createDefaultConfig();
        this._poseSets = {};
        this.render();
    }

    render(): void {
        this.ensureDefaults();
        const tabs = ['overview', 'states', 'poseSets', 'events', 'hitAreas', 'pointer', 'idle', 'queues', 'rules', 'simulator', 'validation'];
        const labels: Record<string, string> = { overview: 'Overview', states: 'States', poseSets: 'Pose Sets', events: 'Events', hitAreas: 'Hit Areas', pointer: 'Pointer', idle: 'Idle', queues: 'Queues', rules: 'Rules', simulator: 'Simulator', validation: 'Validation' };
        let html = '<div class="panel-header interactive-header"><span>Interactive</span><span class="interactive-status ' + (this._enabled ? 'enabled' : '') + '">' + (this._enabled ? 'Enabled' : 'Off') + '</span></div>';
        html += '<div class="interactive-tabs">';
        tabs.forEach(tab => html += '<button class="interactive-tab ' + (tab === this._activeTab ? 'active' : '') + '" data-tab="' + tab + '">' + labels[tab] + '</button>');
        html += '</div><div class="interactive-tab-body">' + this.renderTab() + '</div>';
        this._container.innerHTML = html;
        this.bind();
        this.renderOverlay();
    }

    private renderTab(): string {
        if (this._activeTab === 'states') return this.renderStates();
        if (this._activeTab === 'poseSets') return this.renderPoseSets();
        if (this._activeTab === 'events') return this.renderEvents();
        if (this._activeTab === 'hitAreas') return this.renderHitAreas();
        if (this._activeTab === 'pointer') return this.renderPointer();
        if (this._activeTab === 'idle') return this.renderIdle();
        if (this._activeTab === 'queues') return this.renderQueues();
        if (this._activeTab === 'rules') return this.renderRules();
        if (this._activeTab === 'simulator') return this.renderSimulator();
        if (this._activeTab === 'validation') return this.renderValidation();
        return this.renderOverview();
    }

    private renderOverview(): string {
        const warnings = this.validate();
        return '<div class="panel-section interactive-section">' +
            '<label class="checkbox-label"><input type="checkbox" id="int-enabled" ' + (this._enabled ? 'checked' : '') + '> Enable interactive mascot export</label>' +
            '<div class="panel-row"><div class="input-group"><span class="input-label">Default State</span><input id="int-default-state" class="input-text" value="' + this.e(this._config.defaultState || '') + '"></div>' +
            '<div class="input-group"><span class="input-label">Transition ms</span><input id="int-transition-ms" type="number" class="input-number" value="' + (this._config.defaultTransitionMs ?? 120) + '"></div></div>' +
            '<div class="interactive-summary-grid">' + this.summary('States', Object.keys(this._config.states || {}).length) + this.summary('Pose Sets', Object.keys(this._poseSets).length) + this.summary('Events', Object.keys(this._config.events || {}).length) + this.summary('Hit Areas', (this._config.hitAreas || []).length) + this.summary('Queues', Object.keys(this._config.queues || {}).length) + this.summary('Rules', (this._config.rules || []).length) + '</div>' +
            '<div class="interactive-actions"><button class="btn btn-secondary btn-sm" data-action="seed">Seed From Animation</button><button class="btn btn-secondary btn-sm" data-action="import-json">Import JSON</button><button class="btn btn-secondary btn-sm" data-action="copy-json">Copy JSON</button></div>' +
            '<div class="validation-mini ' + (warnings.length ? 'warn' : 'ok') + '">' + (warnings.length ? warnings.length + ' validation warnings' : 'No validation warnings') + '</div></div>';
    }

    private renderStates(): string {
        const states = this._config.states || {};
        let html = '<div class="panel-section interactive-section"><div class="interactive-form-grid"><input id="new-state-name" class="input-text" placeholder="state name"><select id="new-state-type" class="input-select"><option value="clip">clip</option><option value="frameSelector">frameSelector</option><option value="directionalClip">directionalClip</option></select><input id="new-state-target" class="input-text" placeholder="animation or poseSet"><input id="new-state-priority" type="number" class="input-number" value="0"><button class="btn btn-primary btn-sm" data-action="add-state">Add</button></div></div><div class="interactive-list">';
        Object.entries(states).forEach(([name, state]) => html += '<div class="interactive-item"><div class="interactive-item-title"><strong>' + this.e(name) + '</strong><button class="btn btn-mini" data-action="delete-state" data-name="' + this.e(name) + '">Delete</button></div><div class="interactive-meta-line">' + this.e(state.type) + ' · priority ' + (state.priority ?? 0) + '</div></div>');
        html += '</div>' + this.jsonEditor('states-json', states, 'apply-states-json', 'Apply States JSON');
        return html;
    }
    private renderPoseSets(): string {
        let html = '<div class="panel-section interactive-section"><div class="interactive-form-grid"><input id="new-pose-name" class="input-text" placeholder="poseSet name"><select id="new-pose-type" class="input-select"><option value="angleFrames">angleFrames</option><option value="directionFrames">directionFrames</option></select><input id="new-pose-start" type="number" class="input-number" value="' + this._getSelectedFrameIndex() + '"><input id="new-pose-count" type="number" class="input-number" value="36"><button class="btn btn-primary btn-sm" data-action="add-pose">Add</button></div></div><div class="interactive-list">';
        Object.entries(this._poseSets).forEach(([name, pose]) => html += '<div class="interactive-item"><div class="interactive-item-title"><strong>' + this.e(name) + '</strong><button class="btn btn-mini" data-action="delete-pose" data-name="' + this.e(name) + '">Delete</button></div><div class="interactive-meta-line">' + this.e(pose.type || 'poseSet') + '</div></div>');
        html += '</div>' + this.jsonEditor('poses-json', this._poseSets, 'apply-poses-json', 'Apply PoseSets JSON');
        return html;
    }

    private renderEvents(): string {
        const events = this._config.events || {};
        let html = '<div class="panel-section interactive-section"><div class="interactive-form-grid"><input id="new-event-name" class="input-text" placeholder="event"><select id="new-event-kind" class="input-select"><option value="state">state</option><option value="queue">queue</option></select><input id="new-event-target" class="input-text" placeholder="target"><button class="btn btn-primary btn-sm" data-action="add-event">Add</button></div></div><div class="interactive-list">';
        Object.entries(events).forEach(([name, action]) => html += '<div class="interactive-item"><div class="interactive-item-title"><strong>' + this.e(name) + '</strong><button class="btn btn-mini" data-action="delete-event" data-name="' + this.e(name) + '">Delete</button></div><div class="interactive-meta-line">' + this.e(action.state ? 'state: ' + action.state : 'queue: ' + action.queue) + '</div></div>');
        html += '</div>' + this.jsonEditor('events-json', events, 'apply-events-json', 'Apply Events JSON');
        return html;
    }

    private renderHitAreas(): string {
        const areas = this._config.hitAreas || [];
        let html = '<div class="panel-section interactive-section"><div class="interactive-actions"><button class="btn btn-primary btn-sm" data-action="add-hit">Add Rect</button><button class="btn btn-secondary btn-sm" data-action="toggle-draw">' + (this._drawEnabled ? 'Stop Drawing' : 'Draw On Canvas') + '</button></div></div><div class="interactive-list">';
        areas.forEach((area, index) => html += '<div class="interactive-item"><div class="interactive-item-title"><strong>' + this.e(area.name) + '</strong><button class="btn btn-mini" data-action="delete-hit" data-index="' + index + '">Delete</button></div><div class="interactive-meta-line">x ' + area.rect.x + ' · y ' + area.rect.y + ' · w ' + area.rect.w + ' · h ' + area.rect.h + ' · click ' + this.e(area.onClick || '') + '</div></div>');
        html += '</div>' + this.jsonEditor('hitareas-json', areas, 'apply-hitareas-json', 'Apply HitAreas JSON');
        return html;
    }

    private renderPointer(): string {
        const p = this._config.pointerTracking || {};
        return '<div class="panel-section interactive-section"><label class="checkbox-label"><input id="pointer-enabled" type="checkbox" ' + (p.enabled ? 'checked' : '') + '> Enabled</label><div class="interactive-form-grid"><select id="pointer-mode" class="input-select"><option value="angle" ' + (p.mode === 'angle' ? 'selected' : '') + '>angle</option><option value="horizontal-only" ' + (p.mode === 'horizontal-only' ? 'selected' : '') + '>horizontal-only</option><option value="4-direction" ' + (p.mode === '4-direction' ? 'selected' : '') + '>4-direction</option><option value="8-direction" ' + (p.mode === '8-direction' ? 'selected' : '') + '>8-direction</option></select><input id="pointer-state" class="input-text" placeholder="state" value="' + this.e(p.state || '') + '"><input id="pointer-threshold" type="number" class="input-number" value="' + (p.thresholdPx ?? 24) + '"><input id="pointer-debounce" type="number" class="input-number" value="' + (p.debounceMs ?? 80) + '"><input id="pointer-maxdist" type="number" class="input-number" value="' + (p.maxDistancePx ?? 700) + '"></div></div>' + this.jsonEditor('pointer-dir-json', p.directionStates || {}, 'apply-pointer-dir-json', 'Apply Direction States JSON');
    }

    private renderIdle(): string {
        const idle = this._config.idleBehavior || {};
        return '<div class="panel-section interactive-section"><label class="checkbox-label"><input id="idle-enabled" type="checkbox" ' + (idle.enabled ? 'checked' : '') + '> Enabled</label><div class="interactive-form-grid"><input id="idle-inactive" type="number" class="input-number" value="' + (idle.inactiveAfterMs ?? 5000) + '"><input id="idle-min" type="number" class="input-number" value="' + (idle.minDelayMs ?? 4000) + '"><input id="idle-max" type="number" class="input-number" value="' + (idle.maxDelayMs ?? 12000) + '"></div></div>' + this.jsonEditor('idle-pool-json', idle.pool || [], 'apply-idle-pool-json', 'Apply Pool JSON');
    }

    private renderQueues(): string {
        return '<div class="panel-section interactive-section"><div class="interactive-form-grid"><input id="new-queue-name" class="input-text" placeholder="queue"><input id="new-queue-state" class="input-text" placeholder="first state"><button class="btn btn-primary btn-sm" data-action="add-queue">Add</button></div></div>' + this.jsonEditor('queues-json', this._config.queues || {}, 'apply-queues-json', 'Apply Queues JSON', true);
    }

    private renderRules(): string {
        return '<div class="panel-section interactive-section"><button class="btn btn-secondary btn-sm" data-action="add-rule">Add Basic Rule</button></div>' + this.jsonEditor('rules-json', this._config.rules || [], 'apply-rules-json', 'Apply Rules JSON', true);
    }

    private renderSimulator(): string {
        const events = Object.keys(this._config.events || {});
        let html = '<div class="panel-section interactive-section"><div class="interactive-actions">';
        events.forEach(name => html += '<button class="btn btn-secondary btn-sm" data-action="simulate-event" data-name="' + this.e(name) + '">' + this.e(name) + '</button>');
        html += '</div><div class="interactive-actions"><button class="btn btn-secondary btn-sm" data-action="simulate-pointer" data-dir="left">Pointer Left</button><button class="btn btn-secondary btn-sm" data-action="simulate-pointer" data-dir="right">Pointer Right</button><button class="btn btn-secondary btn-sm" data-action="simulate-pointer" data-dir="up">Pointer Up</button><button class="btn btn-secondary btn-sm" data-action="simulate-pointer" data-dir="down">Pointer Down</button><button class="btn btn-secondary btn-sm" data-action="simulate-event" data-name="idle_timeout">Idle Timeout</button></div><pre class="interactive-debug-output">' + this.e(JSON.stringify({ defaultState: this._config.defaultState, currentFrame: this._getSelectedFrameIndex(), animation: this._getProject().animation.name, states: Object.keys(this._config.states || {}) }, null, 2)) + '</pre></div>';
        return html;
    }

    private renderValidation(): string {
        const warnings = this.validate();
        let html = '<div class="panel-section interactive-section"><div class="validation-mini ' + (warnings.length ? 'warn' : 'ok') + '">' + (warnings.length ? warnings.length + ' warnings' : 'No validation warnings') + '</div><ul class="interactive-validation-list">';
        warnings.forEach(w => html += '<li>' + this.e(w) + '</li>');
        return html + '</ul></div>';
    }

    private bind(): void {
        this._container.querySelectorAll('.interactive-tab').forEach(button => button.addEventListener('click', () => { this._activeTab = (button as HTMLElement).dataset.tab || 'overview'; this.render(); }));
        this._container.addEventListener('click', event => this.onClick(event));
        this._container.addEventListener('change', event => this.onChange(event));
    }

    private onClick(event: Event): void {
        const button = (event.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
        if (!button) return;
        const action = button.dataset.action || '';
        const name = button.dataset.name || '';
        const index = parseInt(button.dataset.index || '-1', 10);
        if (action === 'seed') { this._enabled = true; this._config = this.createDefaultConfig(); this._poseSets = {}; }
        if (action === 'import-json') this.importJsonPrompt();
        if (action === 'copy-json') navigator.clipboard?.writeText(JSON.stringify({ interactive: this._config, poseSets: this._poseSets }, null, 2)).catch(() => undefined);
        if (action === 'add-state') this.addState();
        if (action === 'delete-state') delete this._config.states?.[name];
        if (action === 'apply-states-json') this.applyJson('states-json', value => { this._config.states = value; });
        if (action === 'add-pose') this.addPoseSet();
        if (action === 'delete-pose') delete this._poseSets[name];
        if (action === 'apply-poses-json') this.applyJson('poses-json', value => { this._poseSets = value; });
        if (action === 'add-event') this.addEvent();
        if (action === 'delete-event') delete this._config.events?.[name];
        if (action === 'apply-events-json') this.applyJson('events-json', value => { this._config.events = value; });
        if (action === 'add-hit') this.addHitArea();
        if (action === 'delete-hit') this._config.hitAreas?.splice(index, 1);
        if (action === 'toggle-draw') this.toggleDraw();
        if (action === 'apply-hitareas-json') this.applyJson('hitareas-json', value => { this._config.hitAreas = value; });
        if (action === 'apply-pointer-dir-json') this.applyJson('pointer-dir-json', value => { this._config.pointerTracking = { ...(this._config.pointerTracking || {}), directionStates: value }; });
        if (action === 'apply-idle-pool-json') this.applyJson('idle-pool-json', value => { this._config.idleBehavior = { ...(this._config.idleBehavior || {}), pool: value }; });
        if (action === 'add-queue') this.addQueue();
        if (action === 'apply-queues-json') this.applyJson('queues-json', value => { this._config.queues = value; });
        if (action === 'add-rule') this.addRule();
        if (action === 'apply-rules-json') this.applyJson('rules-json', value => { this._config.rules = value; });
        if (action === 'simulate-event') alert('Simulated event: ' + name + '\nAction: ' + JSON.stringify(this._config.events?.[name] || null));
        if (action === 'simulate-pointer') alert('Simulated pointer ' + (button.dataset.dir || 'center') + '\nPointer config: ' + JSON.stringify(this._config.pointerTracking || null));
        this._markDirty();
        if (action !== 'import-json') this.render();
    }

    private onChange(event: Event): void {
        const target = event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        if (!target) return;
        if (target.id === 'int-enabled') this._enabled = (target as HTMLInputElement).checked;
        if (target.id === 'int-default-state') this._config.defaultState = target.value.trim();
        if (target.id === 'int-transition-ms') this._config.defaultTransitionMs = parseInt(target.value, 10) || 0;
        if (target.id.startsWith('pointer-')) this.updatePointer();
        if (target.id.startsWith('idle-')) this.updateIdle();
        this._markDirty();
        this.renderOverlay();
    }

    private createDefaultConfig(): InteractiveConfig {
        const animationName = this._getProject().animation.name || 'default';
        return { defaultState: 'idle', defaultTransitionMs: 120, states: { idle: { type: 'clip', animation: animationName, priority: 0, loop: true, interruptible: true } }, events: {}, hitAreas: [], pointerTracking: { enabled: false, mode: 'angle', thresholdPx: 24, debounceMs: 80, maxDistancePx: 700, state: 'look_at_cursor', directionStates: {} }, idleBehavior: { enabled: false, inactiveAfterMs: 5000, minDelayMs: 4000, maxDelayMs: 12000, pool: [{ state: 'idle', weight: 1 }] }, queues: {}, rules: [], debug: { enabled: false } };
    }

    private ensureDefaults(): void {
        const animationName = this._getProject().animation.name || 'default';
        this._config.states = this._config.states || {};
        this._config.events = this._config.events || {};
        this._config.hitAreas = this._config.hitAreas || [];
        this._config.queues = this._config.queues || {};
        this._config.rules = this._config.rules || [];
        this._config.pointerTracking = this._config.pointerTracking || { enabled: false, mode: 'angle', thresholdPx: 24, debounceMs: 80 };
        this._config.idleBehavior = this._config.idleBehavior || { enabled: false, inactiveAfterMs: 5000, minDelayMs: 4000, maxDelayMs: 12000, pool: [] };
        if (!this._config.defaultState) this._config.defaultState = 'idle';
        if (!this._config.states.idle) this._config.states.idle = { type: 'clip', animation: animationName, priority: 0, loop: true, interruptible: true };
    }

    private addState(): void {
        const name = this.value('new-state-name');
        if (!name) return;
        const type = this.value('new-state-type') || 'clip';
        const target = this.value('new-state-target');
        const priority = parseInt(this.value('new-state-priority') || '0', 10) || 0;
        const state: MascotStateConfig = { type, priority, interruptible: true };
        if (type === 'frameSelector') state.poseSet = target;
        else if (type === 'directionalClip') state.directions = { center: target || this._getProject().animation.name };
        else { state.animation = target || this._getProject().animation.name; state.loop = true; }
        this._config.states = this._config.states || {};
        this._config.states[name] = state;
    }

    private addPoseSet(): void {
        const name = this.value('new-pose-name');
        if (!name) return;
        const type = this.value('new-pose-type') || 'angleFrames';
        const startFrame = parseInt(this.value('new-pose-start') || '0', 10) || 0;
        const frameCount = parseInt(this.value('new-pose-count') || '1', 10) || 1;
        if (type === 'directionFrames') this._poseSets[name] = { type: 'directionFrames', mode: '4-direction', frames: { center: startFrame, left: startFrame + 1, right: startFrame + 2, up: startFrame + 3, down: startFrame + 4 } };
        else this._poseSets[name] = { type: 'angleFrames', frameCount, angleStartDeg: 0, angleEndDeg: 360, wrap: true, grid: { columns: this._getProject().source.sheetConfig?.columns || frameCount, rows: this._getProject().source.sheetConfig?.rows || 1, startFrame, frameCount }, smoothing: 0.18, deadZonePx: 24, snapDegrees: 10, hysteresisDegrees: 4, maxDegreesPerSecond: 360 };
    }

    private addEvent(): void {
        const name = this.value('new-event-name');
        const kind = this.value('new-event-kind') || 'state';
        const target = this.value('new-event-target');
        if (!name || !target) return;
        this._config.events = this._config.events || {};
        this._config.events[name] = kind === 'queue' ? { queue: target } : { state: target };
    }

    private addHitArea(rect?: { x: number; y: number; w: number; h: number }): void {
        this._config.hitAreas = this._config.hitAreas || [];
        const index = this._config.hitAreas.length + 1;
        this._config.hitAreas.push({ name: 'area_' + index, shape: 'rect', rect: rect || { x: -40, y: -120, w: 80, h: 80 }, onClick: 'click_near' });
        this.renderOverlay();
    }

    private addQueue(): void {
        const name = this.value('new-queue-name');
        const state = this.value('new-queue-state');
        if (!name || !state) return;
        this._config.queues = this._config.queues || {};
        this._config.queues[name] = [{ state } as MascotQueueStep];
    }

    private addRule(): void {
        this._config.rules = this._config.rules || [];
        this._config.rules.push({ event: 'click_head', when: { currentState: this._config.defaultState || 'idle' }, action: { state: this._config.defaultState || 'idle' } } as MascotRuleConfig);
    }

    private updatePointer(): void {
        const enabled = document.getElementById('pointer-enabled') as HTMLInputElement | null;
        this._config.pointerTracking = { ...(this._config.pointerTracking || {}), enabled: enabled?.checked || false, mode: this.value('pointer-mode') as any, state: this.value('pointer-state') || undefined, thresholdPx: parseInt(this.value('pointer-threshold') || '24', 10) || 24, debounceMs: parseInt(this.value('pointer-debounce') || '80', 10) || 80, maxDistancePx: parseInt(this.value('pointer-maxdist') || '700', 10) || 700 };
    }

    private updateIdle(): void {
        const enabled = document.getElementById('idle-enabled') as HTMLInputElement | null;
        this._config.idleBehavior = { ...(this._config.idleBehavior || {}), enabled: enabled?.checked || false, inactiveAfterMs: parseInt(this.value('idle-inactive') || '5000', 10) || 5000, minDelayMs: parseInt(this.value('idle-min') || '4000', 10) || 4000, maxDelayMs: parseInt(this.value('idle-max') || '12000', 10) || 12000 };
    }

    private applyJson(id: string, setter: (value: any) => void): void {
        const el = document.getElementById(id) as HTMLTextAreaElement | null;
        if (!el) return;
        try { setter(JSON.parse(el.value || 'null')); } catch (error) { alert('Invalid JSON: ' + error); }
    }

    private importJsonPrompt(): void {
        const raw = prompt('Paste full interactive mascot JSON or an interactive config JSON');
        if (!raw) return;
        try {
            const parsed = JSON.parse(raw);
            this._config = this.clone(parsed.interactive || parsed);
            this._poseSets = this.clone(parsed.poseSets || this._poseSets || {});
            this._enabled = true;
            this.ensureDefaults();
        } catch (error) {
            alert('Invalid JSON: ' + error);
        }
    }

    private validate(): string[] {
        const warnings: string[] = [];
        const states = this._config.states || {};
        const events = this._config.events || {};
        const queues = this._config.queues || {};
        const animationNames = new Set([this._getProject().animation.name || 'default']);
        if (this._config.defaultState && !states[this._config.defaultState]) warnings.push('defaultState references missing state: ' + this._config.defaultState);
        Object.entries(states).forEach(([name, state]) => {
            if (state.type === 'clip' && state.animation && !animationNames.has(state.animation)) warnings.push('State ' + name + ' references animation not present in current editor project: ' + state.animation);
            if (state.type === 'frameSelector' && (!state.poseSet || !this._poseSets[state.poseSet])) warnings.push('State ' + name + ' references missing poseSet: ' + (state.poseSet || ''));
            if (state.type === 'directionalClip') Object.entries(state.directions || {}).forEach(([dir, anim]) => { if (!animationNames.has(anim)) warnings.push('State ' + name + ' direction ' + dir + ' references missing animation: ' + anim); });
            if (state.type === 'clip' && state.loop === false && !state.returnTo) warnings.push('One-shot state has no returnTo: ' + name);
        });
        Object.entries(events).forEach(([name, action]) => {
            if (action.state && !states[action.state]) warnings.push('Event ' + name + ' references missing state: ' + action.state);
            if (action.queue && !queues[action.queue]) warnings.push('Event ' + name + ' references missing queue: ' + action.queue);
        });
        Object.entries(queues).forEach(([name, steps]) => (steps || []).forEach((step, index) => { if (!states[step.state]) warnings.push('Queue ' + name + ' step ' + index + ' references missing state: ' + step.state); }));
        Object.entries(this._config.pointerTracking?.directionStates || {}).forEach(([dir, state]) => { if (!states[state]) warnings.push('Pointer direction ' + dir + ' references missing state: ' + state); });
        if (this._config.pointerTracking?.state && !states[this._config.pointerTracking.state]) warnings.push('Pointer tracking references missing state: ' + this._config.pointerTracking.state);
        if (this._getProject().animation.frames.some(frame => frame.sourceRect.w <= 0 || frame.sourceRect.h <= 0)) warnings.push('Animation contains zero-size frame sourceRect');
        return warnings;
    }

    private setupOverlay(): void {
        const container = document.getElementById('canvas-container');
        if (!container) return;
        this._overlay = document.createElement('canvas');
        this._overlay.className = 'hitarea-overlay-canvas';
        this._overlayCtx = this._overlay.getContext('2d');
        container.appendChild(this._overlay);
        this.resizeOverlay();
        window.addEventListener('resize', () => this.resizeOverlay());
        this._overlay.addEventListener('mousedown', event => this.startDraft(event));
        this._overlay.addEventListener('mousemove', event => this.updateDraft(event));
        document.addEventListener('mouseup', event => this.finishDraft(event));
    }

    private resizeOverlay(): void {
        if (!this._overlay) return;
        const canvas = this._canvas.getCanvas();
        this._overlay.width = canvas.width;
        this._overlay.height = canvas.height;
        this.renderOverlay();
    }

    private toggleDraw(): void {
        this._drawEnabled = !this._drawEnabled;
        if (this._overlay) this._overlay.style.pointerEvents = this._drawEnabled ? 'auto' : 'none';
        this.renderOverlay();
    }

    private startDraft(event: MouseEvent): void {
        if (!this._drawEnabled) return;
        this._draftStart = this.eventToWorld(event);
        this._draftRect = { x: this._draftStart.x, y: this._draftStart.y, w: 0, h: 0 };
        this.renderOverlay();
    }

    private updateDraft(event: MouseEvent): void {
        if (!this._drawEnabled || !this._draftStart) return;
        const pos = this.eventToWorld(event);
        this._draftRect = { x: Math.min(this._draftStart.x, pos.x), y: Math.min(this._draftStart.y, pos.y), w: Math.abs(pos.x - this._draftStart.x), h: Math.abs(pos.y - this._draftStart.y) };
        this.renderOverlay();
    }

    private finishDraft(event: MouseEvent): void {
        if (!this._drawEnabled || !this._draftStart || !this._draftRect) return;
        this.updateDraft(event);
        const rect = this._draftRect;
        if (rect.w >= 4 && rect.h >= 4) this.addHitArea({ x: round(rect.x, 2), y: round(rect.y, 2), w: round(rect.w, 2), h: round(rect.h, 2) });
        this._draftStart = null;
        this._draftRect = null;
        this._drawEnabled = false;
        if (this._overlay) this._overlay.style.pointerEvents = 'none';
        this._markDirty();
        this.render();
    }

    private eventToWorld(event: MouseEvent): { x: number; y: number } {
        const rect = this._canvas.getCanvas().getBoundingClientRect();
        return this._canvas.screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    }

    private renderOverlay(): void {
        if (!this._overlay || !this._overlayCtx) return;
        const canvas = this._canvas.getCanvas();
        if (this._overlay.width !== canvas.width || this._overlay.height !== canvas.height) this.resizeOverlay();
        const ctx = this._overlayCtx;
        ctx.clearRect(0, 0, this._overlay.width, this._overlay.height);
        const visible = this._activeTab === 'hitAreas' || this._drawEnabled;
        this._overlay.classList.toggle('active', visible);
        if (!visible) return;
        const zoom = this._canvas.zoom;
        const areas = [...(this._config.hitAreas || [])];
        if (this._draftRect) areas.push({ name: 'draft', shape: 'rect', rect: this._draftRect } as MascotHitAreaConfig);
        areas.forEach(area => {
            const pos = this._canvas.worldToScreen(area.rect.x, area.rect.y);
            const w = area.rect.w * zoom;
            const h = area.rect.h * zoom;
            const draft = area.name === 'draft';
            ctx.fillStyle = draft ? 'rgba(245, 158, 11, 0.16)' : 'rgba(34, 197, 94, 0.14)';
            ctx.strokeStyle = draft ? '#f59e0b' : '#22c55e';
            ctx.lineWidth = 2;
            ctx.fillRect(pos.x, pos.y, w, h);
            ctx.strokeRect(pos.x, pos.y, w, h);
            ctx.fillStyle = '#f8fafc';
            ctx.font = '11px Inter, sans-serif';
            ctx.fillText(area.name, pos.x + 4, pos.y + 13);
        });
    }

    private jsonEditor(id: string, value: unknown, action: string, label: string, tall: boolean = false): string {
        return '<div class="panel-section"><button class="btn btn-secondary btn-sm" data-action="' + action + '">' + label + '</button><textarea id="' + id + '" class="interactive-json ' + (tall ? 'tall' : '') + '">' + this.e(JSON.stringify(value, null, 2)) + '</textarea></div>';
    }

    private summary(label: string, count: number): string {
        return '<div class="interactive-summary-item"><span>' + label + '</span><strong>' + count + '</strong></div>';
    }

    private value(id: string): string {
        return ((document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null)?.value || '').trim();
    }

    private e(value: unknown): string {
        return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(new RegExp(String.fromCharCode(34), 'g'), '&quot;').replace(/'/g, '&#39;');
    }

    private clone<T>(value: T): T {
        return JSON.parse(JSON.stringify(value));
    }
}
