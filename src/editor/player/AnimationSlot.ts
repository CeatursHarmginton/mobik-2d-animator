/**
 * Animation Slot - Represents a single imported animation in Player Mode
 * @module editor/player/AnimationSlot
 */

import { MascotController } from '../../core/mascot';
import { AnimationPlayer, RuntimeMeta } from '../../core/runtime';

// Node.js modules for Electron
const fs = require('fs');
const path = require('path');

export interface AnimationSlotData {
    id: string;
    name: string;
    spriteSheetPath: string;
    metaPath: string;
    position: { x: number; y: number };
    scale: number;
    visible: boolean;
    zIndex: number;
}

export class AnimationSlot {
    readonly id: string;
    name: string;
    spriteSheet: HTMLImageElement | null = null;
    meta: RuntimeMeta | null = null;
    player: AnimationPlayer;
    mascot: MascotController | null = null;
    position: { x: number; y: number };
    scale: number;
    visible: boolean;
    zIndex: number;

    private _spriteSheetPath: string = '';
    private _metaPath: string = '';

    constructor(id: string, name: string) {
        this.id = id;
        this.name = name;
        this.player = new AnimationPlayer();
        this.position = { x: 0, y: 0 };
        this.scale = 1;
        this.visible = true;
        this.zIndex = 0;
    }

    /**
     * Load sprite sheet and meta.json from file paths
     */
    async load(spriteSheetPath: string, metaPath: string): Promise<void> {
        this._spriteSheetPath = spriteSheetPath;
        this._metaPath = metaPath;

        // Load meta.json using Node.js fs
        const metaJson = fs.readFileSync(metaPath, 'utf-8');
        this.meta = JSON.parse(metaJson) as RuntimeMeta;

        // Load and validate
        this.player.loadMeta(this.meta);
        this.mascot = this.isInteractiveMeta(this.meta) ? new MascotController(this.player) : null;

        // Load sprite sheet(s). Merged animation JSON can reference multiple sheets.
        if (this.meta.spriteSheets?.length) {
            const metaDir = path.dirname(metaPath);
            for (const filename of this.meta.spriteSheets) {
                const sheetPath = path.isAbsolute(filename) ? filename : path.join(metaDir, filename);
                await this.loadSpriteSheet(sheetPath, path.basename(filename));
            }
        } else {
            await this.loadSpriteSheet(spriteSheetPath, path.basename(spriteSheetPath));
        }

        // Resolve grid-based sourceRects if compact format was used
        this._resolveGridSourceRects();
        this.syncMascotPosition();
        this.mascot?.loadFromPlayer();
    }

    /**
     * Load a raw spritesheet without meta JSON.
     * Creates a synthetic RuntimeMeta from columns, rows, and fps.
     */
    async loadFromSpritesheet(
        spriteSheetPath: string,
        columns: number,
        rows: number,
        fps: number = 12
    ): Promise<void> {
        this._spriteSheetPath = spriteSheetPath;
        this._metaPath = '';

        // First load the image to get dimensions
        await this.loadSpriteSheet(spriteSheetPath);

        if (!this.spriteSheet) {
            throw new Error('Failed to load spritesheet image');
        }

        const imgW = this.spriteSheet.naturalWidth;
        const imgH = this.spriteSheet.naturalHeight;
        const cellW = Math.floor(imgW / columns);
        const cellH = Math.floor(imgH / rows);
        const totalFrames = columns * rows;

        // Build synthetic RuntimeMeta
        const frames: any[] = [];
        for (let i = 0; i < totalFrames; i++) {
            const col = i % columns;
            const row = Math.floor(i / columns);
            frames.push({
                src: spriteSheetPath.replace(/\\/g, '/').split('/').pop() || '',
                rect: [col * cellW, row * cellH, cellW, cellH],
                pivot: [0.5, 1.0],
                offset: [0, 0],
                scale: [1, 1],
                dur: 1
            });
        }

        this.meta = {
            version: '1.0',
            spriteSheet: spriteSheetPath.replace(/\\/g, '/').split('/').pop() || '',
            animation: {
                name: this.name,
                fps: fps,
                loop: true,
                frames: frames
            }
        };

        this.player.loadMeta(this.meta);
        this.mascot = null;
    }

    /**
     * Resolve placeholder sourceRects for compact grid format.
     * Called after image is loaded so we know dimensions.
     */
    private _resolveGridSourceRects(): void {
        if (!this.meta?.animation?.grid || !this.spriteSheet) return;

        const grid = this.meta.animation.grid;
        const imgW = this.spriteSheet.naturalWidth;
        const imgH = this.spriteSheet.naturalHeight;
        const cellW = Math.floor(imgW / grid.columns);
        const cellH = Math.floor(imgH / grid.rows);

        // Get the parsed animation data and update sourceRects
        const animData = (this.player as any)._animationData;
        if (!animData?.frames) return;

        for (let i = 0; i < animData.frames.length; i++) {
            const frame = animData.frames[i];
            if (frame.sourceRect.w === 0 && frame.sourceRect.h === 0) {
                const col = i % grid.columns;
                const row = Math.floor(i / grid.columns);
                frame.sourceRect = {
                    x: col * cellW,
                    y: row * cellH,
                    w: cellW,
                    h: cellH
                };
            }
        }
    }

    private async loadSpriteSheet(path: string, key?: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                this.spriteSheet = img;
                this.player.loadSpriteSheet(img, key);
                resolve();
            };
            img.onerror = () => reject(new Error(`Failed to load sprite sheet: ${path}`));
            img.src = `file:///${path.replace(/\\/g, '/')}`;
        });
    }

    get isReady(): boolean {
        return this.player.isReady;
    }

    get isPlaying(): boolean {
        return this.player.isPlaying;
    }

    get animationName(): string {
        return this.mascot?.getCurrentAnimation() || this.player.animationName || this.meta?.animation?.name || this.name;
    }

    get isInteractive(): boolean {
        return this.mascot !== null;
    }

    get frameCount(): number {
        return this.player.frameCount;
    }

    /**
     * Update animation state
     */
    update(deltaTime: number): void {
        if (!this.visible) return;
        this.syncMascotPosition();
        if (this.mascot) this.mascot.update(deltaTime);
        else this.player.update(deltaTime);
    }

    /**
     * Render to canvas at slot's position
     */
    render(ctx: CanvasRenderingContext2D, offsetX: number = 0, offsetY: number = 0): void {
        if (!this.visible || !this.isReady) return;

        ctx.save();

        // Apply slot scale
        const renderX = this.position.x + offsetX;
        const renderY = this.position.y + offsetY;

        if (this.mascot) {
            this.mascot.setPosition(renderX, renderY);
            ctx.save();
            ctx.translate(renderX, renderY);
            ctx.scale(this.scale, this.scale);
            ctx.translate(-renderX, -renderY);
            this.mascot.render(ctx);
            ctx.restore();
        } else {
            this.player.renderScaled(ctx, renderX, renderY, this.scale, this.scale);
        }

        ctx.restore();
    }

    /**
     * Check if point is within this slot's bounds
     */
    hitTest(x: number, y: number): boolean {
        if (!this.isReady) return false;

        const frame = this.player.currentFrame;
        if (!frame) return false;

        // Account for both frame's internal scale and slot scale
        const totalScaleX = frame.scale.x * this.scale;
        const totalScaleY = frame.scale.y * this.scale;

        const w = frame.sourceRect.w * totalScaleX;
        const h = frame.sourceRect.h * totalScaleY;

        // Use targetSize for pivot calculation if available (for consistent alignment)
        // Otherwise fall back to scaled dimensions
        const targetSize = this.meta?.animation?.targetSize;
        const pivotBaseW = targetSize ? targetSize.w * this.scale : w;
        const pivotBaseH = targetSize ? targetSize.h * this.scale : h;
        const pivotX = frame.pivot.x * pivotBaseW;
        const pivotY = frame.pivot.y * pivotBaseH;

        const left = this.position.x - pivotX + frame.offset.x * totalScaleX;
        const top = this.position.y - pivotY + frame.offset.y * totalScaleY;

        return x >= left && x <= left + w && y >= top && y <= top + h;
    }

    /**
     * Get bounds for selection box
     */
    getBounds(): { x: number; y: number; w: number; h: number } | null {
        if (!this.isReady) return null;

        const frame = this.player.currentFrame;
        if (!frame) return null;

        // Account for both frame's internal scale and slot scale
        const totalScaleX = frame.scale.x * this.scale;
        const totalScaleY = frame.scale.y * this.scale;

        const w = frame.sourceRect.w * totalScaleX;
        const h = frame.sourceRect.h * totalScaleY;

        // Use targetSize for pivot calculation if available (for consistent alignment)
        const targetSize = this.meta?.animation?.targetSize;
        const pivotBaseW = targetSize ? targetSize.w * this.scale : w;
        const pivotBaseH = targetSize ? targetSize.h * this.scale : h;
        const pivotX = frame.pivot.x * pivotBaseW;
        const pivotY = frame.pivot.y * pivotBaseH;

        return {
            x: this.position.x - pivotX + frame.offset.x * totalScaleX,
            y: this.position.y - pivotY + frame.offset.y * totalScaleY,
            w,
            h
        };
    }

    play(): void {
        if (this.mascot) this.mascot.playState(this.meta?.interactive?.defaultState || "idle");
        else this.player.play();
    }

    pause(): void {
        this.player.pause();
    }

    stop(): void {
        if (this.mascot) this.mascot.playState(this.meta?.interactive?.defaultState || "idle");
        else this.player.stop();
    }

    handlePointerMove(x: number, y: number): void {
        if (!this.mascot) return;
        this.syncMascotPosition();
        const point = this.toMascotPoint(x, y);
        this.mascot.handlePointerMove(point.x, point.y);
    }

    handleClick(x: number, y: number): void {
        if (!this.mascot) return;
        this.syncMascotPosition();
        const point = this.toMascotPoint(x, y);
        this.mascot.handleClick(point.x, point.y);
    }

    private syncMascotPosition(): void {
        this.mascot?.setPosition(this.position.x, this.position.y);
    }

    private toMascotPoint(x: number, y: number): { x: number; y: number } {
        if (this.scale === 1) return { x, y };
        return {
            x: this.position.x + (x - this.position.x) / this.scale,
            y: this.position.y + (y - this.position.y) / this.scale
        };
    }

    private isInteractiveMeta(meta: RuntimeMeta): boolean {
        return Boolean(meta.interactive || meta.format === "mobik-interactive-mascot");
    }

    toData(): AnimationSlotData {
        return {
            id: this.id,
            name: this.name,
            spriteSheetPath: this._spriteSheetPath,
            metaPath: this._metaPath,
            position: { ...this.position },
            scale: this.scale,
            visible: this.visible,
            zIndex: this.zIndex
        };
    }

    static generateId(): string {
        return `slot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
}
