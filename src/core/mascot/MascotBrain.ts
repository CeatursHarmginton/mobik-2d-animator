/**
 * MascotBrain - maps events/rules to state or queue actions.
 * @module core/mascot/MascotBrain
 */

import { InteractiveConfig, MascotEventAction, MascotRuleConfig } from '../runtime/types';
import { MascotStateMachine } from './MascotStateMachine';

export class MascotBrain {
    private _config: InteractiveConfig;
    private _stateMachine: MascotStateMachine;
    private _lastEvent: string | null = null;
    private _userInactiveMs: number = 0;

    constructor(config: InteractiveConfig, stateMachine: MascotStateMachine) {
        this._config = config;
        this._stateMachine = stateMachine;
    }

    update(deltaTime: number): void {
        this._userInactiveMs += deltaTime * 1000;
    }

    markInteraction(): void {
        this._userInactiveMs = 0;
    }

    resolveEvent(eventName: string): MascotEventAction | null {
        this._lastEvent = eventName;
        const rule = this.findMatchingRule(eventName);
        if (rule) return rule.action;
        return this._config.events?.[eventName] || null;
    }

    get lastEvent(): string | null {
        return this._lastEvent;
    }

    get userInactiveMs(): number {
        return this._userInactiveMs;
    }

    private findMatchingRule(eventName: string): MascotRuleConfig | null {
        const rules = this._config.rules || [];
        for (const rule of rules) {
            if (rule.event !== eventName) continue;
            if (this.matchesRule(rule)) return rule;
        }
        return null;
    }

    private matchesRule(rule: MascotRuleConfig): boolean {
        const when = rule.when;
        if (!when) return true;
        if (when.currentState && this._stateMachine.currentState !== when.currentState) return false;
        if (when.userInactiveMsGreaterThan !== undefined && this._userInactiveMs <= when.userInactiveMsGreaterThan) return false;
        return true;
    }
}
