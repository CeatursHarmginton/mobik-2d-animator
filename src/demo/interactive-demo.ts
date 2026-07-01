/**
 * Interactive Mascot Demo
 * ------------------------------------------------------------------
 * This demo reuses the REAL mascot runtime (src/core/mascot) and the
 * EXISTING sample config (samples/interactive_mascot_sample.mobik.json).
 *
 * The sprite sheet that the JSON references ("mascot.png") does not ship
 * with the repo, so it is generated procedurally at runtime to match the
 * grid declared in the JSON (12 cols x 8 rows, 128px cells):
 *
 *   idle_breathing : frames  0..11   (subtle breathing + blink-less)
 *   blink          : frames 12..15
 *   wave           : frames 24..33
 *   head_turn_360  : frames 36..71   (pose set, 36 angles around 360 deg)
 *
 * Interactions exposed:
 *   - move cursor  -> head/eyes follow the cursor (look_at_cursor pose set)
 *   - click mascot -> wave (via head hit area or the click_near fallback)
 *   - cursor leaves stage / idle -> returns to idle, blinks on its own
 *
 * @module demo/interactive-demo
 */

import * as fs from 'fs';
import * as path from 'path';
import { MascotController } from '../core/mascot';
import { RuntimeMeta } from '../core/runtime/types';

// ---- sprite sheet layout (MUST match the JSON grid) ----
const CELL = 128;
const COLS = 12;
const ROWS = 8;

const IDLE_START = 0,  IDLE_COUNT = 12;
const BLINK_START = 12, BLINK_COUNT = 4;
const WAVE_START = 24,  WAVE_COUNT = 10;
const HEAD_START = 36,  HEAD_COUNT = 36;

/**
 * Demo render scale. The authored hit area in the sample JSON
 * ({y:-170..-100}) is sized for a sprite taller than a single 128px cell,
 * so we render the procedural sprite at this scale to keep the visuals and
 * the authored hit area coherent. The JSON file itself is left untouched.
 */
const DEMO_SCALE = 1.4;

interface PoseOpts {
    breathe: number;   // -1..1, drives squash/stretch + antenna sway
    eyelid: number;    // 0 = open, 1 = fully closed
    armDeg: number;    // right (waving) arm angle, screen-space degrees
    gaze: { x: number; y: number } | null; // unit dir (y down), null = forward
    smile: number;     // 0..1 mouth curvature / cheeks
}

// ---------- procedural mascot drawing ----------

const C = {
    body: '#54c8a6',
    bodyDark: '#2f8068',
    belly: '#eef9f3',
    foot: '#3a9a7e',
    eyeWhite: '#ffffff',
    pupil: '#23323b',
    cheek: 'rgba(255,138,170,0.55)',
    mouth: '#243038',
    antenna: '#2f8068'
};

function drawArm(ctx: CanvasRenderingContext2D, sx: number, sy: number, angleDeg: number, len: number): void {
    const a = angleDeg * Math.PI / 180;
    const ex = sx + Math.cos(a) * len;
    const ey = sy + Math.sin(a) * len;
    ctx.strokeStyle = C.body;
    ctx.lineWidth = 11;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    // hand
    ctx.fillStyle = C.belly;
    ctx.beginPath();
    ctx.arc(ex, ey, 7, 0, Math.PI * 2);
    ctx.fill();
}

/**
 * Draw the mascot with feet anchored at (ax, ay), growing upward (-y).
 * All coordinates are in unscaled source-cell space (128px tall cell).
 */
function drawMascot(ctx: CanvasRenderingContext2D, ax: number, ay: number, opts: PoseOpts): void {
    const breathe = opts.breathe;
    const bodyRX = 30;
    const bodyRY = 40 * (1 + 0.05 * breathe);
    const bodyCY = ay - 44;
    const headR = 27;
    const lean = opts.gaze ? opts.gaze.x * 4 : 0;
    const headDip = opts.gaze ? opts.gaze.y * 3 : 0;
    const headCX = ax + lean;
    const headCY = ay - 96 - breathe * 1.5 + headDip;

    // ground shadow
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.beginPath();
    ctx.ellipse(ax, ay - 3, 33, 8, 0, 0, Math.PI * 2);
    ctx.fill();

    // feet
    ctx.fillStyle = C.foot;
    ctx.beginPath();
    ctx.ellipse(ax - 13, ay - 4, 11, 7, 0, 0, Math.PI * 2);
    ctx.ellipse(ax + 13, ay - 4, 11, 7, 0, 0, Math.PI * 2);
    ctx.fill();

    // back (left) arm, static
    drawArm(ctx, ax - 24, bodyCY - 6, 128, 22);

    // dark outline pass for body + head (draw slightly larger underneath)
    ctx.fillStyle = C.bodyDark;
    ctx.beginPath();
    ctx.ellipse(ax, bodyCY, bodyRX + 2.5, bodyRY + 2.5, 0, 0, Math.PI * 2);
    ctx.arc(headCX, headCY, headR + 2.5, 0, Math.PI * 2);
    ctx.fill();

    // body + head fill
    ctx.fillStyle = C.body;
    ctx.beginPath();
    ctx.ellipse(ax, bodyCY, bodyRX, bodyRY, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(headCX, headCY, headR, 0, Math.PI * 2);
    ctx.fill();

    // belly highlight
    ctx.fillStyle = C.belly;
    ctx.beginPath();
    ctx.ellipse(ax, bodyCY + 4, bodyRX - 11, bodyRY - 12, 0, 0, Math.PI * 2);
    ctx.fill();

    // antenna
    const swayX = (opts.gaze ? opts.gaze.x * 5 : breathe * 3);
    ctx.strokeStyle = C.antenna;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(headCX, headCY - headR + 2);
    ctx.quadraticCurveTo(headCX + swayX, headCY - headR - 9, headCX + swayX, headCY - headR - 16);
    ctx.stroke();
    ctx.fillStyle = '#ffd166';
    ctx.beginPath();
    ctx.arc(headCX + swayX, headCY - headR - 18, 5, 0, Math.PI * 2);
    ctx.fill();

    // ---- face ----
    const eyeY = headCY - 1;
    const eyeDX = 10;
    const eyeRX = 8;
    const eyeRY = 10;
    const gx = opts.gaze ? opts.gaze.x : 0;
    const gy = opts.gaze ? opts.gaze.y : 0.15; // look slightly down when forward

    for (const side of [-1, 1]) {
        const ex = headCX + side * eyeDX;
        // eye white
        ctx.fillStyle = C.eyeWhite;
        ctx.beginPath();
        ctx.ellipse(ex, eyeY, eyeRX, eyeRY, 0, 0, Math.PI * 2);
        ctx.fill();
        // pupil follows gaze
        ctx.fillStyle = C.pupil;
        ctx.beginPath();
        ctx.arc(ex + gx * 4, eyeY + gy * 5, 4.2, 0, Math.PI * 2);
        ctx.fill();
        // eyelid (closes from the top)
        if (opts.eyelid > 0.02) {
            const cover = opts.eyelid * (eyeRY * 2 + 2);
            ctx.fillStyle = C.body;
            ctx.fillRect(ex - eyeRX - 1, eyeY - eyeRY - 1, eyeRX * 2 + 2, cover);
            if (opts.eyelid > 0.8) {
                ctx.strokeStyle = C.pupil;
                ctx.lineWidth = 1.6;
                ctx.beginPath();
                ctx.moveTo(ex - eyeRX, eyeY);
                ctx.lineTo(ex + eyeRX, eyeY);
                ctx.stroke();
            }
        }
    }

    // cheeks
    if (opts.smile > 0.4) {
        ctx.fillStyle = C.cheek;
        ctx.beginPath();
        ctx.arc(headCX - 17, eyeY + 9, 5, 0, Math.PI * 2);
        ctx.arc(headCX + 17, eyeY + 9, 5, 0, Math.PI * 2);
        ctx.fill();
    }

    // mouth
    ctx.strokeStyle = C.mouth;
    ctx.lineWidth = 2;
    ctx.beginPath();
    const mY = headCY + 12;
    const curve = 3 + opts.smile * 6;
    ctx.moveTo(headCX - 7, mY);
    ctx.quadraticCurveTo(headCX, mY + curve, headCX + 7, mY);
    ctx.stroke();

    // front (right) waving arm
    drawArm(ctx, ax + 24, bodyCY - 6, opts.armDeg, 24);
}

function poseForFrame(globalIndex: number): PoseOpts {
    // idle_breathing
    if (globalIndex >= IDLE_START && globalIndex < IDLE_START + IDLE_COUNT) {
        const t = (globalIndex - IDLE_START) / IDLE_COUNT;
        const phase = t * Math.PI * 2;
        return { breathe: Math.sin(phase), eyelid: 0, armDeg: 60, gaze: null, smile: 0.35 };
    }
    // blink
    if (globalIndex >= BLINK_START && globalIndex < BLINK_START + BLINK_COUNT) {
        const seq = [0, 0.6, 1, 0.55];
        return { breathe: 0.2, eyelid: seq[globalIndex - BLINK_START] ?? 0, armDeg: 60, gaze: null, smile: 0.3 };
    }
    // wave
    if (globalIndex >= WAVE_START && globalIndex < WAVE_START + WAVE_COUNT) {
        const t = (globalIndex - WAVE_START) / WAVE_COUNT;
        const swing = Math.sin(t * Math.PI * 4); // two full waves
        return { breathe: 0.3, eyelid: 0, armDeg: -55 + swing * 22, gaze: null, smile: 1 };
    }
    // head_turn_360 pose set
    if (globalIndex >= HEAD_START && globalIndex < HEAD_START + HEAD_COUNT) {
        const deg = (globalIndex - HEAD_START) * (360 / HEAD_COUNT);
        const rad = deg * Math.PI / 180; // screen space: 0=right, 90=down
        return { breathe: 0, eyelid: 0, armDeg: 60, gaze: { x: Math.cos(rad), y: Math.sin(rad) }, smile: 0.2 };
    }
    // unused cell
    return { breathe: 0, eyelid: 0, armDeg: 60, gaze: null, smile: 0 };
}

function buildSpriteSheet(): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = COLS * CELL;
    canvas.height = ROWS * CELL;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D context unavailable for sprite sheet');

    const ranges = [
        [IDLE_START, IDLE_COUNT],
        [BLINK_START, BLINK_COUNT],
        [WAVE_START, WAVE_COUNT],
        [HEAD_START, HEAD_COUNT]
    ];

    for (const [start, count] of ranges) {
        for (let i = 0; i < count; i++) {
            const gi = start + i;
            const col = gi % COLS;
            const row = Math.floor(gi / COLS);
            const ax = col * CELL + CELL / 2;
            const ay = row * CELL + CELL - 4; // feet near the bottom of the cell
            ctx.save();
            ctx.beginPath();
            ctx.rect(col * CELL, row * CELL, CELL, CELL);
            ctx.clip();
            drawMascot(ctx, ax, ay, poseForFrame(gi));
            ctx.restore();
        }
    }
    return canvas;
}

// ---------- meta loading ----------

function loadSampleMeta(): RuntimeMeta {
    const candidates = [
        path.join(__dirname, '../../samples/interactive_mascot_sample.mobik.json'),
        path.join(process.cwd(), 'samples/interactive_mascot_sample.mobik.json')
    ];
    for (const file of candidates) {
        try {
            if (fs.existsSync(file)) {
                return JSON.parse(fs.readFileSync(file, 'utf-8')) as RuntimeMeta;
            }
        } catch {
            /* try next candidate */
        }
    }
    throw new Error('Could not locate samples/interactive_mascot_sample.mobik.json');
}

/** Apply the demo render scale so the procedural sprite matches authored hit areas. */
function applyDemoScale(meta: RuntimeMeta): void {
    const scale = { x: DEMO_SCALE, y: DEMO_SCALE };
    if (meta.animation) meta.animation.scale = scale;
    for (const clip of Object.values(meta.animations || {})) clip.scale = scale;
    for (const pose of Object.values(meta.poseSets || {})) {
        (pose as { scale?: { x: number; y: number } }).scale = scale;
    }
}

function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Failed to decode generated sprite sheet'));
        img.src = src;
    });
}

// ---------- DOM helpers ----------

function el<T extends HTMLElement>(id: string): T {
    const node = document.getElementById(id);
    if (!node) throw new Error('Missing element #' + id);
    return node as T;
}

// ---------- bootstrap ----------

async function main(): Promise<void> {
    const canvas = el<HTMLCanvasElement>('stage');
    const hud = el<HTMLElement>('hud');
    const maybeCtx = canvas.getContext('2d');
    if (!maybeCtx) throw new Error('2D context unavailable for stage');
    const ctx: CanvasRenderingContext2D = maybeCtx;

    const W = canvas.width;
    const H = canvas.height;
    const MX = W / 2;
    const MY = H - 90; // feet anchor

    // 1. load the existing JSON config
    const meta = loadSampleMeta();
    applyDemoScale(meta);

    // 2. generate the sprite sheet the JSON references
    const sheet = buildSpriteSheet();
    const sheetImg = await loadImage(sheet.toDataURL('image/png'));

    // 3. drive it with the real runtime
    const controller = new MascotController();
    controller.player.loadMeta(meta);
    await controller.player.loadSpriteSheet(sheetImg, meta.spriteSheet || 'mascot.png');
    controller.loadFromPlayer();
    controller.setPosition(MX, MY);

    // ---- input ----
    let lastPx = MX;
    let lastPy = MY - 120;
    let pointerInside = false;
    let showDebug = true;

    function toStage(e: MouseEvent): { x: number; y: number } {
        const r = canvas.getBoundingClientRect();
        return {
            x: (e.clientX - r.left) * (W / r.width),
            y: (e.clientY - r.top) * (H / r.height)
        };
    }

    canvas.addEventListener('mousemove', (e) => {
        const p = toStage(e);
        lastPx = p.x; lastPy = p.y; pointerInside = true;
        controller.handlePointerMove(p.x, p.y);
    });
    canvas.addEventListener('mousedown', (e) => {
        const p = toStage(e);
        lastPx = p.x; lastPy = p.y;
        controller.handleClick(p.x, p.y);
    });
    canvas.addEventListener('mouseleave', () => {
        pointerInside = false;
        controller.playState('idle'); // let idle behaviours (blink) resume
    });

    el<HTMLButtonElement>('btn-wave').addEventListener('click', () => controller.playState('wave'));
    el<HTMLButtonElement>('btn-blink').addEventListener('click', () => controller.trigger('idle_timeout'));
    el<HTMLButtonElement>('btn-idle').addEventListener('click', () => controller.playState('idle'));
    el<HTMLButtonElement>('btn-debug').addEventListener('click', () => { showDebug = !showDebug; });

    // ---- render loop ----
    let last = performance.now();
    function frame(now: number): void {
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        controller.update(dt);

        // background
        const grad = ctx.createLinearGradient(0, 0, 0, H);
        grad.addColorStop(0, '#1b2733');
        grad.addColorStop(1, '#0e161e');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);

        // ground
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, MY + 4);
        ctx.lineTo(W, MY + 4);
        ctx.stroke();

        // mascot (real runtime render)
        controller.render(ctx);

        if (showDebug) drawDebug();
        drawHud();
        requestAnimationFrame(frame);
    }

    function drawDebug(): void {
        // head hit area (from the JSON, in mascot-local space)
        const rect = { x: -45, y: -170, w: 90, h: 70 };
        ctx.strokeStyle = 'rgba(255,209,102,0.8)';
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1.5;
        ctx.strokeRect(MX + rect.x, MY + rect.y, rect.w, rect.h);
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(255,209,102,0.85)';
        ctx.font = '11px monospace';
        ctx.fillText('head (click = wave)', MX + rect.x, MY + rect.y - 4);

        // gaze line from head to cursor
        if (pointerInside) {
            ctx.strokeStyle = 'rgba(120,200,255,0.5)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(MX, MY - 135);
            ctx.lineTo(lastPx, lastPy);
            ctx.stroke();
            ctx.fillStyle = 'rgba(120,200,255,0.9)';
            ctx.beginPath();
            ctx.arc(lastPx, lastPy, 4, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    function drawHud(): void {
        const info = controller.getDebugInfo();
        const dx = lastPx - MX;
        const dy = lastPy - MY;
        const dist = Math.round(Math.hypot(dx, dy));
        const ang = Math.round(((Math.atan2(dy, dx) * 180 / Math.PI) + 360) % 360);
        hud.innerHTML =
            '<b>state</b> ' + (info.currentState ?? '-') +
            '  <b>anim</b> ' + (info.currentAnimation ?? '-') +
            '  <b>pose</b> ' + (info.currentPoseSet ?? '-') +
            '  <b>prio</b> ' + info.priority +
            '<br><b>cursor</b> dist ' + dist + 'px  angle ' + ang + '\u00B0' +
            '  <b>lastEvent</b> ' + (info.lastEvent ?? '-');
    }

    requestAnimationFrame(frame);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { void main(); });
} else {
    void main();
}
