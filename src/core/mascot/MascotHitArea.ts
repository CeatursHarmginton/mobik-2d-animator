/**
 * MascotHitArea - rectangular hit testing relative to mascot anchor.
 * @module core/mascot/MascotHitArea
 */

import { MascotHitAreaConfig } from '../runtime/types';

export class MascotHitArea {
    readonly config: MascotHitAreaConfig;

    constructor(config: MascotHitAreaConfig) {
        this.config = config;
    }

    get name(): string {
        return this.config.name;
    }

    get priority(): number {
        return this.config.priority ?? 0;
    }

    hitTest(pointerX: number, pointerY: number, mascotX: number, mascotY: number): boolean {
        if (this.config.shape !== 'rect') return false;
        const rect = this.config.rect;
        const localX = pointerX - mascotX;
        const localY = pointerY - mascotY;
        return localX >= rect.x && localX <= rect.x + rect.w &&
            localY >= rect.y && localY <= rect.y + rect.h;
    }

    getClickEvent(): string | null {
        return this.config.onClick || null;
    }

    getHoverEvent(): string | null {
        return this.config.onHover || null;
    }

    getLeaveEvent(): string | null {
        return this.config.onLeave || null;
    }

    static sortForHitTesting(areas: MascotHitArea[]): MascotHitArea[] {
        return [...areas].sort((a, b) => a.priority - b.priority);
    }
}
