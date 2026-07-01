/**
 * MascotStateMachine - priority, interrupt, cooldown and return behavior.
 * @module core/mascot/MascotStateMachine
 */

import { InteractiveConfig, MascotStateConfig } from '../runtime/types';

export interface StateTransitionResult {
    changed: boolean;
    stateName: string | null;
    reason?: string;
}

export class MascotStateMachine {
    private _config: InteractiveConfig;
    private _currentState: string | null = null;
    private _previousState: string | null = null;
    private _stateStartedAtMs: number = 0;
    private _cooldowns: Map<string, number> = new Map();
    private _nowMs: number = 0;

    constructor(config: InteractiveConfig = {}) {
        this._config = config;
        this._currentState = config.defaultState || null;
    }

    update(deltaTime: number, clipFinished: boolean = false): StateTransitionResult {
        this._nowMs += deltaTime * 1000;
        this.expireCooldowns();

        const current = this.getCurrentStateConfig();
        if (clipFinished && current?.returnTo) {
            return this.playState(current.returnTo, true);
        }
        if (clipFinished && current && current.loop === false && this._config.defaultState && this._currentState !== this._config.defaultState) {
            return this.playState(this._config.defaultState, true);
        }

        return { changed: false, stateName: this._currentState };
    }

    playState(stateName: string, force: boolean = false): StateTransitionResult {
        const next = this.getStateConfig(stateName);
        if (!next) return { changed: false, stateName: this._currentState, reason: 'missing-state' };
        if (!force && this.isCoolingDown(stateName)) return { changed: false, stateName: this._currentState, reason: 'cooldown' };

        const current = this.getCurrentStateConfig();
        if (!force && current && this._currentState && this._currentState !== stateName) {
            const currentPriority = current.priority ?? 0;
            const nextPriority = next.priority ?? 0;
            const interruptible = current.interruptible ?? true;
            if (!interruptible && nextPriority <= currentPriority) {
                return { changed: false, stateName: this._currentState, reason: 'not-interruptible' };
            }
            if (nextPriority < currentPriority) {
                return { changed: false, stateName: this._currentState, reason: 'lower-priority' };
            }
        }

        if (this._currentState === stateName) {
            return { changed: false, stateName };
        }

        if (this._currentState) this.startCooldown(this._currentState, current?.cooldownMs ?? 0);
        this._previousState = this._currentState;
        this._currentState = stateName;
        this._stateStartedAtMs = this._nowMs;
        return { changed: true, stateName };
    }

    canPlayState(stateName: string): boolean {
        const next = this.getStateConfig(stateName);
        if (!next || this.isCoolingDown(stateName)) return false;
        const current = this.getCurrentStateConfig();
        if (!current || !this._currentState || this._currentState === stateName) return true;
        const currentPriority = current.priority ?? 0;
        const nextPriority = next.priority ?? 0;
        const interruptible = current.interruptible ?? true;
        if (!interruptible && nextPriority <= currentPriority) return false;
        return nextPriority >= currentPriority;
    }

    getStateConfig(name: string | null): MascotStateConfig | null {
        if (!name) return null;
        return this._config.states?.[name] || null;
    }

    getCurrentStateConfig(): MascotStateConfig | null {
        return this.getStateConfig(this._currentState);
    }

    get currentState(): string | null { return this._currentState; }
    get previousState(): string | null { return this._previousState; }
    get currentPriority(): number { return this.getCurrentStateConfig()?.priority ?? 0; }
    get elapsedInStateMs(): number { return this._nowMs - this._stateStartedAtMs; }
    get nowMs(): number { return this._nowMs; }

    getCooldowns(): Record<string, number> {
        const result: Record<string, number> = {};
        for (const [state, until] of this._cooldowns.entries()) {
            result[state] = Math.max(0, until - this._nowMs);
        }
        return result;
    }

    private isCoolingDown(stateName: string): boolean {
        return (this._cooldowns.get(stateName) || 0) > this._nowMs;
    }

    private startCooldown(stateName: string, cooldownMs: number): void {
        if (cooldownMs > 0) this._cooldowns.set(stateName, this._nowMs + cooldownMs);
    }

    private expireCooldowns(): void {
        for (const [state, until] of this._cooldowns.entries()) {
            if (until <= this._nowMs) this._cooldowns.delete(state);
        }
    }
}

