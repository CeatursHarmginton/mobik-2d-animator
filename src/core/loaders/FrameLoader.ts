/**
 * Frame Loader - Loads Type A assets (multiple PNG files from folder)
 * @module core/loaders/FrameLoader
 */

import { Frame } from '../models/Frame';
import { SourceInfo } from '../models/types';

export interface LoaderResult {
    frames: Frame[];
    basePath: string;
    files: string[];
}

export class FrameLoader {
    private static readonly SUPPORTED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

    /**
     * Load frames from a folder containing individual image files
     * This is for Electron environment - uses Node.js fs
     */
    static async loadFromFolder(folderPath: string): Promise<LoaderResult> {
        // In Electron, we'll use the main process to read directory
        // This method will be called via IPC
        const { ipcRenderer } = require('electron');

        const files: string[] = await ipcRenderer.invoke('read-directory', folderPath);
        const sortedFiles = this.sortFrameFiles(
            files.filter(f => this.isImageFile(f))
        );

        const frames: Frame[] = [];

        for (let i = 0; i < sortedFiles.length; i++) {
            const frame = new Frame({
                index: i,
                sourceFile: sortedFiles[i]
            });
            frames.push(frame);
        }

        return {
            frames,
            basePath: folderPath,
            files: sortedFiles
        };
    }

    /**
     * Load frames from a FileList (for web/drag-drop)
     */
    static async loadFromFileList(fileList: FileList): Promise<LoaderResult> {
        const files: string[] = [];
        const frames: Frame[] = [];

        // Convert FileList to sorted array
        const sortedFiles = this.sortFrameFiles(
            Array.from(fileList)
                .filter(f => this.isImageFile(f.name))
                .map(f => f.name)
        );

        for (let i = 0; i < sortedFiles.length; i++) {
            const file = Array.from(fileList).find(f => f.name === sortedFiles[i]);
            if (!file) continue;

            const frame = new Frame({
                index: i,
                sourceFile: sortedFiles[i]
            });

            // Load image from File object
            await this.loadImageFromFile(frame, file);
            frames.push(frame);
            files.push(sortedFiles[i]);
        }

        return {
            frames,
            basePath: '',
            files
        };
    }

    /**
     * Load image from File object (browser API)
     */
    private static async loadImageFromFile(frame: Frame, file: File): Promise<void> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const img = new Image();
                img.onload = () => {
                    (frame as any)._image = {
                        element: img,
                        width: img.naturalWidth,
                        height: img.naturalHeight,
                        loaded: true
                    };
                    frame.sourceRect = {
                        x: 0,
                        y: 0,
                        w: img.naturalWidth,
                        h: img.naturalHeight
                    };
                    resolve();
                };
                img.onerror = () => reject(new Error(`Failed to load: ${file.name}`));
                img.src = reader.result as string;
            };
            reader.onerror = () => reject(new Error(`Failed to read: ${file.name}`));
            reader.readAsDataURL(file);
        });
    }

    /**
     * Check if file is a supported image
     */
    private static isImageFile(filename: string): boolean {
        const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
        return this.SUPPORTED_EXTENSIONS.includes(ext);
    }

    /**
     * Sort frame files by natural number order
     * e.g., idle_0, idle_1, idle_2, ..., idle_10, idle_11
     */
    private static sortFrameFiles(files: string[]): string[] {
        return files.sort((a, b) => {
            // Extract numbers from filenames
            const numA = this.extractFrameNumber(a);
            const numB = this.extractFrameNumber(b);

            if (numA !== null && numB !== null) {
                return numA - numB;
            }

            // Fallback to alphabetical
            return a.localeCompare(b, undefined, { numeric: true });
        });
    }

    /**
     * Extract frame number from filename
     * Handles: frame_0, frame_00, frame0, 0_frame, etc.
     */
    private static extractFrameNumber(filename: string): number | null {
        // Remove extension
        const name = filename.replace(/\.[^.]+$/, '');

        // Try to find number at end
        const endMatch = name.match(/(\d+)$/);
        if (endMatch) {
            return parseInt(endMatch[1], 10);
        }

        // Try to find number anywhere
        const anyMatch = name.match(/(\d+)/);
        if (anyMatch) {
            return parseInt(anyMatch[1], 10);
        }

        return null;
    }

    /**
     * Create SourceInfo from loader result
     */
    static createSourceInfo(result: LoaderResult): SourceInfo {
        return {
            type: 'frames',
            basePath: result.basePath,
            files: result.files
        };
    }
}
