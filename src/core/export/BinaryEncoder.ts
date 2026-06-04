/**
 * Binary Encoder - Prepares data for binary serialization
 * @module core/export/BinaryEncoder
 * 
 * This module provides utilities for converting animation data
 * to binary-friendly formats for use with FlatBuffer, MessagePack, etc.
 */

import { Project } from '../models/Project';
import { ProjectData, FrameData, META_VERSION } from '../models/types';

// Binary format constants
const MOBIK_MAGIC = 0x4D4F424B; // 'MOBK'
const HEADER_SIZE = 16;

export interface BinaryHeader {
    magic: number;
    version: number;
    flags: number;
    frameCount: number;
    dataOffset: number;
}

export interface PackedFrame {
    sourceIndex: number;   // Index into source file list
    rectX: number;
    rectY: number;
    rectW: number;
    rectH: number;
    pivotX: number;        // Fixed-point 0-65535 (normalized * 65535)
    pivotY: number;
    offsetX: number;
    offsetY: number;
    duration: number;      // Fixed-point 0-65535 (duration * 1000)
}

export class BinaryEncoder {
    /**
     * Pack project data into binary-optimized structure
     */
    static pack(project: Project): ArrayBuffer {
        const data = project.toData();
        const frames = this.packFrames(data);
        const sources = this.packStrings(data.source.files);
        const animName = this.packString(data.animation.name);

        // Calculate total size
        const headerSize = HEADER_SIZE;
        const animInfoSize = 4 + animName.byteLength + 4; // fps (2) + loop (1) + nameLen (1) + name
        const sourcesSize = 4 + sources.byteLength; // count (2) + data
        const framesSize = frames.byteLength;

        const totalSize = headerSize + animInfoSize + sourcesSize + framesSize;
        const buffer = new ArrayBuffer(totalSize);
        const view = new DataView(buffer);
        let offset = 0;

        // Write header
        view.setUint32(offset, MOBIK_MAGIC, true); offset += 4;
        view.setUint16(offset, this.encodeVersion(META_VERSION), true); offset += 2;
        view.setUint16(offset, 0, true); offset += 2; // flags
        view.setUint16(offset, data.animation.frameCount, true); offset += 2;
        view.setUint16(offset, data.source.files.length, true); offset += 2;
        view.setUint32(offset, headerSize, true); offset += 4; // data offset

        // Write animation info
        view.setUint16(offset, data.animation.defaultFPS, true); offset += 2;
        view.setUint8(offset, data.animation.loop ? 1 : 0); offset += 1;
        view.setUint8(offset, animName.byteLength); offset += 1;
        new Uint8Array(buffer, offset, animName.byteLength).set(new Uint8Array(animName));
        offset += animName.byteLength;

        // Write source files
        view.setUint16(offset, sources.byteLength, true); offset += 2;
        new Uint8Array(buffer, offset, sources.byteLength).set(new Uint8Array(sources));
        offset += sources.byteLength;

        // Write frames
        new Uint8Array(buffer, offset, frames.byteLength).set(new Uint8Array(frames));

        return buffer;
    }

    /**
     * Pack frames into fixed-size binary structure
     */
    private static packFrames(data: ProjectData): ArrayBuffer {
        const FRAME_SIZE = 20; // bytes per frame
        const buffer = new ArrayBuffer(data.animation.frames.length * FRAME_SIZE);
        const view = new DataView(buffer);

        let offset = 0;
        for (const frame of data.animation.frames) {
            // Source index (2 bytes)
            const sourceIndex = data.source.files.indexOf(frame.sourceFile);
            view.setUint16(offset, sourceIndex >= 0 ? sourceIndex : 0, true);
            offset += 2;

            // Source rect (8 bytes)
            view.setUint16(offset, frame.sourceRect.x, true); offset += 2;
            view.setUint16(offset, frame.sourceRect.y, true); offset += 2;
            view.setUint16(offset, frame.sourceRect.w, true); offset += 2;
            view.setUint16(offset, frame.sourceRect.h, true); offset += 2;

            // Pivot (4 bytes) - normalized to 0-65535
            view.setUint16(offset, Math.round(frame.pivot.x * 65535), true); offset += 2;
            view.setUint16(offset, Math.round(frame.pivot.y * 65535), true); offset += 2;

            // Offset (4 bytes) - signed
            view.setInt16(offset, Math.round(frame.offset.x), true); offset += 2;
            view.setInt16(offset, Math.round(frame.offset.y), true); offset += 2;

            // Duration (2 bytes) - fixed point * 1000
            view.setUint16(offset, Math.round(frame.duration * 1000), true); offset += 2;
        }

        return buffer;
    }

    /**
     * Pack string array into binary format
     */
    private static packStrings(strings: string[]): ArrayBuffer {
        const encoder = new TextEncoder();
        const encoded = strings.map(s => encoder.encode(s));

        // Calculate total size: count + (length + data) for each string
        let size = 0;
        for (const bytes of encoded) {
            size += 2 + bytes.byteLength; // length (2) + data
        }

        const buffer = new ArrayBuffer(size);
        const view = new DataView(buffer);
        const bytes = new Uint8Array(buffer);

        let offset = 0;
        for (const data of encoded) {
            view.setUint16(offset, data.byteLength, true);
            offset += 2;
            bytes.set(data, offset);
            offset += data.byteLength;
        }

        return buffer;
    }

    /**
     * Pack single string to binary
     */
    private static packString(str: string): ArrayBuffer {
        return new TextEncoder().encode(str).buffer;
    }

    /**
     * Encode version string to uint16 (major * 100 + minor)
     */
    private static encodeVersion(version: string): number {
        const parts = version.split('.').map(Number);
        return (parts[0] || 0) * 100 + (parts[1] || 0);
    }

    /**
     * Export to MessagePack format (returns structure ready for msgpackr)
     */
    static toMessagePackData(project: Project): object {
        const data = project.toData();

        return {
            v: META_VERSION,
            a: {
                n: data.animation.name,
                f: data.animation.defaultFPS,
                l: data.animation.loop ? 1 : 0,
                c: data.animation.frameCount,
                d: data.animation.frames.map(f => [
                    data.source.files.indexOf(f.sourceFile),
                    f.sourceRect.x, f.sourceRect.y, f.sourceRect.w, f.sourceRect.h,
                    Math.round(f.pivot.x * 65535),
                    Math.round(f.pivot.y * 65535),
                    Math.round(f.offset.x),
                    Math.round(f.offset.y),
                    Math.round(f.duration * 1000)
                ])
            },
            s: data.source.files
        };
    }

    /**
     * Calculate estimated binary size for project
     */
    static estimateSize(project: Project): { json: number; binary: number; ratio: number } {
        const jsonSize = new Blob([project.toJSON(false)]).size;
        const binarySize = this.pack(project).byteLength;

        return {
            json: jsonSize,
            binary: binarySize,
            ratio: binarySize / jsonSize
        };
    }
}
