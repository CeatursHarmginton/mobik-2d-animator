/**
 * Sprite Sheet Normalize - debug overlay renderer.
 * @module core/normalize/debugOverlay
 *
 * Pure, DOM-free pixel drawing used ONLY when `debugOverlay` is enabled. It
 * takes the combined normalized sheet plus the structured {@link NormalizeDebugInfo}
 * and paints, per frame cell:
 *
 *   - the safe area rectangle           (green)
 *   - the reference character bbox       (cyan)
 *   - the reference baseline / feet line (yellow)
 *   - the canvas center crosshair        (magenta)
 *   - the final placement rectangle      (red)
 *   - the anchor point                   (orange)
 *   - a text label: frame index, global scale, and clamp/crop-risk flags (white)
 *
 * Everything is drawn with a tiny built-in 3x5 bitmap font so no canvas / DOM /
 * font stack is required; the same code runs in the renderer, the CLI and Jest.
 * This file is intentionally self-contained so the feature is easy to remove.
 */

import type { NormalizeDebugInfo, RgbaImage } from './types';

type Rgb = readonly [number, number, number];

const COLOR_SAFE: Rgb = [102, 187, 106]; // green
const COLOR_REF_BBOX: Rgb = [79, 195, 247]; // cyan
const COLOR_BASELINE: Rgb = [255, 213, 79]; // amber
const COLOR_CENTER: Rgb = [236, 64, 122]; // magenta
const COLOR_PLACEMENT: Rgb = [239, 83, 80]; // red
const COLOR_ANCHOR: Rgb = [255, 152, 0]; // orange
const COLOR_TEXT: Rgb = [255, 255, 255]; // white
const COLOR_TEXT_WARN: Rgb = [239, 83, 80]; // red (for clamp / crop-risk)

/**
 * Render the annotated debug overlay sheet. Returns a brand-new buffer; the
 * input `afterSheet` is never mutated.
 *
 * @param afterSheet  The combined normalized sheet (cols*frameWidth x rows*frameHeight).
 * @param debug       Structured, DOM-free diagnostics for every frame.
 * @param layout      Grid + per-cell (reference) dimensions.
 */
export function renderDebugOverlaySheet(
    afterSheet: RgbaImage,
    debug: NormalizeDebugInfo,
    layout: { columns: number; rows: number; frameWidth: number; frameHeight: number }
): RgbaImage {
    const out: RgbaImage = {
        width: afterSheet.width,
        height: afterSheet.height,
        data: new Uint8ClampedArray(afterSheet.data)
    };

    const { columns, frameWidth, frameHeight } = layout;
    const cols = Math.max(1, columns);
    const scale = Math.max(1, Math.min(3, Math.round(Math.min(frameWidth, frameHeight) / 100)));
    const safe = debug.safePadding;
    const scaleLabel = `S${formatScale(debug.globalScale)}${debug.autoReduced ? 'R' : ''}`;

    debug.frames.forEach((frame, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const ox = col * frameWidth;
        const oy = row * frameHeight;

        // Safe area (always meaningful, even for empty frames).
        drawRectOutline(out, ox + safe, oy + safe, frameWidth - 2 * safe, frameHeight - 2 * safe, COLOR_SAFE);

        // Reference character bbox + baseline.
        if (!debug.referenceBBox.empty) {
            drawRectOutline(
                out,
                ox + debug.referenceBBox.x,
                oy + debug.referenceBBox.y,
                debug.referenceBBox.width,
                debug.referenceBBox.height,
                COLOR_REF_BBOX
            );
        }
        drawHLine(out, ox, ox + frameWidth - 1, oy + Math.round(debug.referenceBaselineY), COLOR_BASELINE);

        // Canvas center crosshair.
        drawCross(out, ox + Math.round(debug.canvasCenter.x), oy + Math.round(debug.canvasCenter.y), 4 * scale, COLOR_CENTER);

        // Placement rect + anchor point (non-empty frames only).
        if (!frame.empty) {
            drawRectOutline(out, ox + frame.placement.x, oy + frame.placement.y, frame.placement.width, frame.placement.height, COLOR_PLACEMENT);
            drawDot(out, ox + Math.round(frame.anchorPoint.x), oy + Math.round(frame.anchorPoint.y), scale + 1, COLOR_ANCHOR);
        }

        // Text: frame index (+ flags) and the global scale.
        const flags = `${frame.clampedX || frame.clampedY ? '!' : ''}${frame.cropRisk ? 'C' : ''}`;
        const indexColor = flags ? COLOR_TEXT_WARN : COLOR_TEXT;
        drawText(out, ox + safe + 1, oy + safe + 1, `#${i}${flags}`, indexColor, scale);
        drawText(out, ox + safe + 1, oy + safe + 1 + (GLYPH_HEIGHT + 2) * scale, scaleLabel, COLOR_TEXT, scale);
    });

    return out;
}

/** Format a scale factor compactly (e.g. 1.6 -> "1.60", 0.5 -> "0.50"). */
function formatScale(value: number): string {
    if (!Number.isFinite(value)) return '0';
    return value.toFixed(2);
}

// ---------------------------------------------------------------------------
// Pure pixel primitives (fully opaque writes, bounds-checked)
// ---------------------------------------------------------------------------

function setPixel(img: RgbaImage, x: number, y: number, color: Rgb): void {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
    const o = (y * img.width + x) * 4;
    img.data[o] = color[0];
    img.data[o + 1] = color[1];
    img.data[o + 2] = color[2];
    img.data[o + 3] = 255;
}

function drawHLine(img: RgbaImage, x0: number, x1: number, y: number, color: Rgb): void {
    const from = Math.min(x0, x1);
    const to = Math.max(x0, x1);
    for (let x = from; x <= to; x++) setPixel(img, x, y, color);
}

function drawVLine(img: RgbaImage, x: number, y0: number, y1: number, color: Rgb): void {
    const from = Math.min(y0, y1);
    const to = Math.max(y0, y1);
    for (let y = from; y <= to; y++) setPixel(img, x, y, color);
}

function drawRectOutline(img: RgbaImage, x: number, y: number, w: number, h: number, color: Rgb): void {
    if (w <= 0 || h <= 0) return;
    const x2 = x + w - 1;
    const y2 = y + h - 1;
    drawHLine(img, x, x2, y, color);
    drawHLine(img, x, x2, y2, color);
    drawVLine(img, x, y, y2, color);
    drawVLine(img, x2, y, y2, color);
}

function drawCross(img: RgbaImage, cx: number, cy: number, radius: number, color: Rgb): void {
    drawHLine(img, cx - radius, cx + radius, cy, color);
    drawVLine(img, cx, cy - radius, cy + radius, color);
}

function drawDot(img: RgbaImage, cx: number, cy: number, radius: number, color: Rgb): void {
    for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
            if (dx * dx + dy * dy <= radius * radius) setPixel(img, cx + dx, cy + dy, color);
        }
    }
}

// ---------------------------------------------------------------------------
// Minimal 3x5 bitmap font (digits + the few symbols the overlay uses)
// ---------------------------------------------------------------------------

const GLYPH_WIDTH = 3;
const GLYPH_HEIGHT = 5;

/** Each glyph is 5 rows of a 3-character mask ('1' = lit pixel). */
const FONT: Record<string, string[]> = {
    '0': ['111', '101', '101', '101', '111'],
    '1': ['010', '110', '010', '010', '111'],
    '2': ['111', '001', '111', '100', '111'],
    '3': ['111', '001', '111', '001', '111'],
    '4': ['101', '101', '111', '001', '001'],
    '5': ['111', '100', '111', '001', '111'],
    '6': ['111', '100', '111', '101', '111'],
    '7': ['111', '001', '010', '010', '010'],
    '8': ['111', '101', '111', '101', '111'],
    '9': ['111', '101', '111', '001', '111'],
    '.': ['000', '000', '000', '000', '010'],
    '-': ['000', '000', '111', '000', '000'],
    '#': ['101', '111', '101', '111', '101'],
    '!': ['010', '010', '010', '000', '010'],
    'S': ['111', '100', '111', '001', '111'],
    'R': ['111', '101', '111', '110', '101'],
    'C': ['111', '100', '100', '100', '111'],
    'X': ['101', '101', '010', '101', '101'],
    ' ': ['000', '000', '000', '000', '000']
};

/**
 * Draw `text` at (x, y) using the built-in font, scaled by `scale`. Unknown
 * characters render as blank cells. Returns the x position just past the text.
 */
function drawText(img: RgbaImage, x: number, y: number, text: string, color: Rgb, scale: number): number {
    let cursorX = x;
    for (const char of text) {
        const glyph = FONT[char] ?? FONT[char.toUpperCase()] ?? FONT[' '];
        for (let row = 0; row < GLYPH_HEIGHT; row++) {
            const bits = glyph[row];
            for (let col = 0; col < GLYPH_WIDTH; col++) {
                if (bits[col] !== '1') continue;
                // Draw a scale x scale block per lit font pixel.
                for (let sy = 0; sy < scale; sy++) {
                    for (let sx = 0; sx < scale; sx++) {
                        setPixel(img, cursorX + col * scale + sx, y + row * scale + sy, color);
                    }
                }
            }
        }
        cursorX += (GLYPH_WIDTH + 1) * scale; // 1px inter-glyph gap, scaled
    }
    return cursorX;
}
