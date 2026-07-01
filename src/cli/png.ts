/**
 * Minimal, dependency-free PNG codec (decode + encode) for the CLI.
 * @module cli/png
 *
 * Uses only Node's built-in `zlib` (no native modules, no extra npm deps) so
 * `npm run normalize` works out of the box. It targets the common cases for
 * sprite sheets / AI-generated art:
 *
 *   decode: 8-bit, non-interlaced, colour types 0/2/3/4/6 (+ palette tRNS)
 *   encode: 8-bit RGBA (colour type 6), non-interlaced, filter 0 per scanline
 *
 * Anything outside that (16-bit, interlaced) throws a clear error rather than
 * silently corrupting pixels.
 */

import * as zlib from 'zlib';
import type { RgbaImage } from '../core/normalize/types';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// ---------------------------------------------------------------------------
// CRC32 (PNG polynomial 0xEDB88320) - needed only for encoding chunks.
// ---------------------------------------------------------------------------

const CRC_TABLE: number[] = (() => {
    const table = new Array<number>(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buf: Buffer): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

function paethPredictor(a: number, b: number, c: number): number {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
}

const CHANNELS_BY_COLOR_TYPE: Record<number, number> = {
    0: 1, // grayscale
    2: 3, // truecolour (RGB)
    3: 1, // indexed (palette)
    4: 2, // grayscale + alpha
    6: 4  // truecolour + alpha (RGBA)
};

/** Decode a PNG buffer into a flat RGBA `RgbaImage`. */
export function decodePng(buffer: Buffer): RgbaImage {
    if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new Error('Not a PNG file (bad signature).');
    }

    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlace = 0;
    let palette: Buffer | null = null;
    let transparency: Buffer | null = null;
    const idatChunks: Buffer[] = [];

    let offset = 8;
    while (offset < buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        const dataStart = offset + 8;
        const data = buffer.subarray(dataStart, dataStart + length);

        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data.readUInt8(8);
            colorType = data.readUInt8(9);
            interlace = data.readUInt8(12);
        } else if (type === 'PLTE') {
            palette = Buffer.from(data);
        } else if (type === 'tRNS') {
            transparency = Buffer.from(data);
        } else if (type === 'IDAT') {
            idatChunks.push(Buffer.from(data));
        } else if (type === 'IEND') {
            break;
        }

        offset = dataStart + length + 4; // skip data + CRC
    }

    if (width <= 0 || height <= 0) throw new Error('PNG has invalid dimensions.');
    if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth ${bitDepth} (only 8-bit is supported).`);
    if (interlace !== 0) throw new Error('Interlaced PNG is not supported.');
    const channels = CHANNELS_BY_COLOR_TYPE[colorType];
    if (!channels) throw new Error(`Unsupported PNG colour type ${colorType}.`);

    // Inflate the concatenated IDAT (zlib stream).
    const raw = zlib.inflateSync(Buffer.concat(idatChunks));

    // --- Un-filter scanlines ------------------------------------------------
    const stride = width * channels;
    const recon = Buffer.alloc(stride * height);
    let pos = 0;
    for (let y = 0; y < height; y++) {
        const filter = raw[pos++];
        const rowStart = y * stride;
        for (let i = 0; i < stride; i++) {
            const rawByte = raw[pos++];
            const a = i >= channels ? recon[rowStart + i - channels] : 0;       // left
            const b = y > 0 ? recon[rowStart - stride + i] : 0;                  // up
            const c = i >= channels && y > 0 ? recon[rowStart - stride + i - channels] : 0; // up-left
            let value: number;
            switch (filter) {
                case 0: value = rawByte; break;            // None
                case 1: value = rawByte + a; break;        // Sub
                case 2: value = rawByte + b; break;        // Up
                case 3: value = rawByte + ((a + b) >> 1); break; // Average
                case 4: value = rawByte + paethPredictor(a, b, c); break; // Paeth
                default: throw new Error(`Unknown PNG filter type ${filter}.`);
            }
            recon[rowStart + i] = value & 0xff;
        }
    }

    // --- Expand to RGBA -----------------------------------------------------
    const out = new Uint8ClampedArray(width * height * 4);
    for (let p = 0; p < width * height; p++) {
        const src = p * channels;
        const dst = p * 4;
        switch (colorType) {
            case 6: // RGBA
                out[dst] = recon[src];
                out[dst + 1] = recon[src + 1];
                out[dst + 2] = recon[src + 2];
                out[dst + 3] = recon[src + 3];
                break;
            case 2: // RGB
                out[dst] = recon[src];
                out[dst + 1] = recon[src + 1];
                out[dst + 2] = recon[src + 2];
                out[dst + 3] = 255;
                break;
            case 0: // grayscale
                out[dst] = out[dst + 1] = out[dst + 2] = recon[src];
                out[dst + 3] = 255;
                break;
            case 4: // grayscale + alpha
                out[dst] = out[dst + 1] = out[dst + 2] = recon[src];
                out[dst + 3] = recon[src + 1];
                break;
            case 3: { // palette
                const idx = recon[src];
                if (palette) {
                    out[dst] = palette[idx * 3];
                    out[dst + 1] = palette[idx * 3 + 1];
                    out[dst + 2] = palette[idx * 3 + 2];
                }
                out[dst + 3] = transparency && idx < transparency.length ? transparency[idx] : 255;
                break;
            }
        }
    }

    return { width, height, data: out };
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

function makeChunk(type: string, data: Buffer): Buffer {
    const typeBuf = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([length, typeBuf, data, crcBuf]);
}

/** Encode an `RgbaImage` to a PNG buffer (8-bit RGBA, filter None). */
export function encodePng(img: RgbaImage): Buffer {
    const { width, height, data } = img;

    // IHDR: width, height, bitDepth=8, colorType=6 (RGBA), comp=0, filter=0, interlace=0
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr.writeUInt8(8, 8);
    ihdr.writeUInt8(6, 9);
    ihdr.writeUInt8(0, 10);
    ihdr.writeUInt8(0, 11);
    ihdr.writeUInt8(0, 12);

    // Raw image data: each scanline prefixed with filter byte 0 (None).
    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        const rawRow = y * (stride + 1);
        raw[rawRow] = 0; // filter: None
        for (let i = 0; i < stride; i++) {
            raw[rawRow + 1 + i] = data[y * stride + i];
        }
    }

    const idat = zlib.deflateSync(raw, { level: 9 });

    return Buffer.concat([
        PNG_SIGNATURE,
        makeChunk('IHDR', ihdr),
        makeChunk('IDAT', idat),
        makeChunk('IEND', Buffer.alloc(0))
    ]);
}
