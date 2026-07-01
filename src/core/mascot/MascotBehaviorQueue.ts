/**
 * MascotBehaviorQueue - ordered state sequence runner.
 * @module core/mascot/MascotBehaviorQueue
 */

import { InteractiveConfig, MascotQueueStep } from '../runtime/types';
import { MascotStateMachine } from './MascotStateMachine';

export class MascotBehaviorQueue {
    private _config: InteractiveConfig;
    private _stateMachine: MascotStateMachine;
    private _queueName: string | null = null;
    private _steps: MascotQueueStep[] = [];
    private _index: number = -1;
    private _waitMs: number = 0;
    private _stepElapsedMs: number = 0;

    constructor(config: InteractiveConfig, stateMachine: MascotStateMachine) {
        this._config = config;
        this._stateMachine = stateMachine;
    }

    start(queueName: string): boolean {
        const steps = this._config.queues?.[queueName];
        if (!steps?.length) return false;
        this._queueName = queueName;
        this._steps = steps;
        this._index = -1;
        this._waitMs = 0;
        this._stepElapsedMs = 0;
        this.advance();
        return true;
    }

    stop(): void {
        this._queueName = null;
        this._steps = [];
        this._index = -1;
        this._waitMs = 0;
        this._stepElapsedMs = 0;
    }

    update(deltaTime: number, currentClipFinished: boolean): void {
        if (!this._queueName) return;
        const dtMs = deltaTime * 1000;

        if (this._waitMs > 0) {
            this._waitMs -= dtMs;
            if (this._waitMs > 0) return;
        }

        const step = this.currentStep;
        if (!step) return;

        this._stepElapsedMs += dtMs;
        const minMet = step.minDurationMs === undefined || this._stepElapsedMs >= step.minDurationMs;
        const maxHit = step.maxDurationMs !== undefined && this._stepElapsedMs >= step.maxDurationMs;
        if ((currentClipFinished && minMet) || maxHit) {
            this.advance();
        }
    }

    get activeQueue(): string | null {
        return this._queueName;
    }

    get currentStep(): MascotQueueStep | null {
        return this._steps[this._index] || null;
    }

    private advance(): void {
        this._index++;
        this._stepElapsedMs = 0;

        if (this._index >= this._steps.length) {
            const defaultState = this._config.defaultState;
            this.stop();
            if (defaultState) this._stateMachine.playState(defaultState, true);
            return;
        }

        const step = this._steps[this._index];
        this._waitMs = step.waitBeforeMs || 0;
        if (this._waitMs <= 0) {
            this._stateMachine.playState(step.state, false);
        }
    }
}
