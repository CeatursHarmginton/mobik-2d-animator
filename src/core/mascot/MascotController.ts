/**
 * MascotController - public runtime API for interactive mascot assets.
 * @module core/mascot/MascotController
 */

import { AnimationPlayer } from '../runtime/AnimationPlayer';
import { InteractiveConfig, MascotHitAreaConfig, MascotStateConfig, RuntimeMeta } from '../runtime/types';
import { MascotDebugInfo, MascotPointerInput } from './MascotConfig';
import { MascotBrain } from './MascotBrain';
import { MascotBehaviorQueue } from './MascotBehaviorQueue';
import { MascotHitArea } from './MascotHitArea';
import { MascotStateMachine } from './MascotStateMachine';
import { PoseSetResolver } from './PoseSetResolver';

export class MascotController {
    readonly player: AnimationPlayer;
    readonly poseResolver: PoseSetResolver;

    private _interactive: InteractiveConfig = {};
    private _stateMachine: MascotStateMachine = new MascotStateMachine({});
    private _brain: MascotBrain = new MascotBrain({}, this._stateMachine);
    private _queue: MascotBehaviorQueue = new MascotBehaviorQueue({}, this._stateMachine);
    private _hitAreas: MascotHitArea[] = [];
    private _hoveredArea: MascotHitArea | null = null;
    private _x: number = 0;
    private _y: number = 0;
    private _lastPointerInput: MascotPointerInput | null = null;
    private _lastPointerEventMs: number = 0;
    private _currentPoseSet: string | null = null;
    private _activeDirectionalAnimation: string | null = null;
    private _idleDelayMs: number = 0;
    private _idleCooldowns: Map<string, number> = new Map();

    constructor(player: AnimationPlayer = new AnimationPlayer()) {
        this.player = player;
        this.poseResolver = new PoseSetResolver(player, {});
    }

    async load(spriteSheetUrl: string, metaOrMetaUrl: RuntimeMeta | string): Promise<void> {
        await this.player.load(spriteSheetUrl, metaOrMetaUrl);
        this.configureFromLoadedMeta();
    }

    loadFromPlayer(playerMetaAlreadyLoaded: RuntimeMeta | null = null): void {
        if (playerMetaAlreadyLoaded) this.player.loadMeta(playerMetaAlreadyLoaded);
        this.configureFromLoadedMeta();
    }

    update(deltaTime: number): void {
        this.player.update(deltaTime);
        this._brain.update(deltaTime);

        const clipFinished = this.player.isFinished();
        this._queue.update(deltaTime, clipFinished);
        const transition = this._stateMachine.update(deltaTime, clipFinished);
        if (transition.changed && transition.stateName) this.applyState(transition.stateName);

        this.updateIdle(deltaTime);
    }

    render(ctx: CanvasRenderingContext2D): void {
        const state = this._stateMachine.getCurrentStateConfig();
        if (state?.type === 'frameSelector' && state.poseSet) {
            const frame = this.poseResolver.resolve(state.poseSet, this._lastPointerInput || undefined);
            if (frame) {
                this.player.renderFrame(ctx, frame, this._x, this._y);
                return;
            }
        }

        this.player.render(ctx, this._x, this._y);
    }

    trigger(eventName: string, payload?: unknown): void {
        void payload;
        this._brain.markInteraction();
        const action = this._brain.resolveEvent(eventName);
        if (!action) return;
        if (action.queue) {
            this._queue.start(action.queue);
            return;
        }
        if (action.state) this.playState(action.state);
    }

    playState(stateName: string): void {
        const result = this._stateMachine.playState(stateName);
        if (result.changed && result.stateName) this.applyState(result.stateName);
    }

    handlePointerMove(x: number, y: number): void {
        this._brain.markInteraction();
        const input = this.buildPointerInput(x, y);
        this._lastPointerInput = input;
        this.handleHover(x, y);
        this.handlePointerTracking(input);
    }

    handleClick(x: number, y: number): void {
        this._brain.markInteraction();
        const hit = this.hitTest(x, y);
        if (hit?.getClickEvent()) {
            this.trigger(hit.getClickEvent()!);
            return;
        }

        const input = this.buildPointerInput(x, y);
        const nearDistance = this.getApproximateNearDistance();
        if (input.distance <= nearDistance && this._interactive.events?.click_near) {
            this.trigger('click_near');
        }
    }

    setPosition(x: number, y: number): void {
        this._x = x;
        this._y = y;
    }

    getCurrentState(): string | null {
        return this._stateMachine.currentState;
    }

    getCurrentAnimation(): string | null {
        return this.player.animationName || null;
    }

    getDebugInfo(): MascotDebugInfo {
        return {
            currentState: this._stateMachine.currentState,
            previousState: this._stateMachine.previousState,
            currentAnimation: this.getCurrentAnimation(),
            currentPoseSet: this._currentPoseSet,
            priority: this._stateMachine.currentPriority,
            queue: this._queue.activeQueue,
            lastEvent: this._brain.lastEvent,
            cooldowns: this._stateMachine.getCooldowns()
        };
    }

    private configureFromLoadedMeta(): void {
        const meta = this.player.normalizedMeta;
        const defaultAnimation = this.player.listAnimations()[0] || 'default';
        const interactive = meta?.interactive || this.createDefaultInteractiveConfig(defaultAnimation);
        this._interactive = interactive;
        this._stateMachine = new MascotStateMachine(interactive);
        this._brain = new MascotBrain(interactive, this._stateMachine);
        this._queue = new MascotBehaviorQueue(interactive, this._stateMachine);
        this._hitAreas = MascotHitArea.sortForHitTesting((interactive.hitAreas || []).map((area: MascotHitAreaConfig) => new MascotHitArea(area)));
        this.poseResolver.setPoseSets(meta?.poseSets || {});
        this.scheduleNextIdle();

        const defaultState = interactive.defaultState;
        if (defaultState) {
            this._stateMachine.playState(defaultState, true);
            this.applyState(defaultState);
        } else if (defaultAnimation) {
            this.player.play(defaultAnimation, { restart: true });
        }
    }

    private createDefaultInteractiveConfig(animationName: string): InteractiveConfig {
        return {
            defaultState: 'idle',
            states: {
                idle: {
                    type: 'clip',
                    animation: animationName,
                    priority: 0,
                    loop: true,
                    interruptible: true
                }
            },
            events: {}
        };
    }

    private applyState(stateName: string): void {
        const state = this._stateMachine.getStateConfig(stateName);
        if (!state) return;
        this._currentPoseSet = null;

        if (this._interactive.debug?.enabled) {
            console.debug('[MASCOT_STATE]', stateName, state);
        }

        if (state.type === 'clip') {
            const animation = state.animation || stateName;
            this._activeDirectionalAnimation = null;
            this.player.play(animation, {
                restart: this.player.animationName !== animation,
                speed: state.speed,
                transitionMs: state.transitionMs ?? this._interactive.defaultTransitionMs
            });
            this.player.loop = state.loop ?? this.player.loop;
            return;
        }

        if (state.type === 'frameSelector') {
            this._currentPoseSet = state.poseSet || null;
            this._activeDirectionalAnimation = null;
            this.player.pause();
            return;
        }

        if (state.type === 'directionalClip') {
            this.applyDirectionalClip(state);
        }
    }

    private applyDirectionalClip(state: MascotStateConfig): void {
        const direction = this._lastPointerInput?.direction4 || 'center';
        const animation = state.directions?.[direction] || state.directions?.center;
        if (!animation || this._activeDirectionalAnimation === animation) return;
        this._activeDirectionalAnimation = animation;
        this.player.play(animation, { restart: this.player.animationName !== animation, speed: state.speed });
    }

    private handlePointerTracking(input: MascotPointerInput): void {
        const config = this._interactive.pointerTracking;
        if (!config?.enabled) return;

        const threshold = config.thresholdPx ?? 24;
        if (input.distance < threshold) {
            if (config.mode !== 'angle') this.triggerDirectionState('center');
            return;
        }

        if (config.maxDistancePx !== undefined && input.distance > config.maxDistancePx) return;

        const debounce = config.debounceMs ?? 80;
        if (this._stateMachine.nowMs - this._lastPointerEventMs < debounce) return;
        this._lastPointerEventMs = this._stateMachine.nowMs;

        if (config.mode === 'angle') {
            const stateName = config.state;
            if (stateName) this.playPointerState(stateName);
            return;
        }

        if (config.mode === 'horizontal-only') {
            const direction = input.direction4 === 'left' || input.direction4 === 'right' ? input.direction4 : 'center';
            this.triggerDirectionState(direction);
            return;
        }

        if (config.mode === '8-direction') {
            this.triggerDirectionState(input.direction8);
            return;
        }

        this.triggerDirectionState(input.direction4);
    }

    private playPointerState(stateName: string): void {
        const state = this._interactive.states?.[stateName];
        if (!state) return;
        if ((state.priority ?? 0) < this._stateMachine.currentPriority) return;
        this.playState(stateName);
    }

    private triggerDirectionState(direction: string): void {
        const mapped = this._interactive.pointerTracking?.directionStates?.[direction];
        if (mapped) this.playPointerState(mapped);
    }

    private handleHover(x: number, y: number): void {
        const hit = this.hitTest(x, y);
        if (hit === this._hoveredArea) return;

        const leaveEvent = this._hoveredArea?.getLeaveEvent();
        this._hoveredArea = hit;
        if (leaveEvent) this.trigger(leaveEvent);
        const hoverEvent = hit?.getHoverEvent();
        if (hoverEvent) this.trigger(hoverEvent);
    }

    private hitTest(x: number, y: number): MascotHitArea | null {
        for (let i = this._hitAreas.length - 1; i >= 0; i--) {
            const area = this._hitAreas[i];
            if (area.hitTest(x, y, this._x, this._y)) return area;
        }
        return null;
    }

    private updateIdle(deltaTime: number): void {
        const idle = this._interactive.idleBehavior;
        if (!idle?.enabled || !idle.pool?.length) return;
        if (this._brain.userInactiveMs < (idle.inactiveAfterMs ?? 5000)) return;
        if (this._stateMachine.currentPriority > 0) return;

        this._idleDelayMs -= deltaTime * 1000;
        if (this._idleDelayMs > 0) return;

        const picked = this.pickIdleState();
        if (picked) this.playState(picked);
        this.scheduleNextIdle();
    }

    private pickIdleState(): string | null {
        const pool = this._interactive.idleBehavior?.pool || [];
        const now = this._stateMachine.nowMs;
        const available = pool.filter(item => (this._idleCooldowns.get(item.state) || 0) <= now);
        const total = available.reduce((sum, item) => sum + (item.weight ?? 1), 0);
        if (total <= 0) return null;
        let roll = Math.random() * total;
        for (const item of available) {
            roll -= item.weight ?? 1;
            if (roll <= 0) {
                if (item.cooldownMs) this._idleCooldowns.set(item.state, now + item.cooldownMs);
                return item.state;
            }
        }
        return available[0]?.state || null;
    }

    private scheduleNextIdle(): void {
        const idle = this._interactive.idleBehavior;
        const min = idle?.minDelayMs ?? 4000;
        const max = idle?.maxDelayMs ?? 12000;
        this._idleDelayMs = min + Math.random() * Math.max(0, max - min);
    }

    private buildPointerInput(x: number, y: number): MascotPointerInput {
        const dx = x - this._x;
        const dy = y - this._y;
        const distance = Math.hypot(dx, dy);
        const angleDeg = ((Math.atan2(dy, dx) * 180 / Math.PI) + 360) % 360;
        return {
            x,
            y,
            dx,
            dy,
            distance,
            angleDeg,
            direction4: this.direction4(dx, dy, distance),
            direction8: this.direction8(angleDeg, distance)
        };
    }

    private direction4(dx: number, dy: number, distance: number): string {
        if (distance < 1) return 'center';
        return Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
    }

    private direction8(angleDeg: number, distance: number): string {
        if (distance < 1) return 'center';
        const dirs = ['right', 'down_right', 'down', 'down_left', 'left', 'up_left', 'up', 'up_right'];
        return dirs[Math.round(angleDeg / 45) % 8];
    }

    private getApproximateNearDistance(): number {
        const frame = this.player.currentFrame;
        if (!frame) return 96;
        return Math.max(frame.sourceRect.w * frame.scale.x, frame.sourceRect.h * frame.scale.y) * 0.75;
    }
}
