/**
 * Shared utilities for Mobik Animator
 */

/**
 * Clamp value between min and max
 */
export function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

/**
 * Linear interpolation
 */
export function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

/**
 * Round to specified decimal places
 */
export function round(value: number, decimals: number = 2): number {
    const factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
}

/**
 * Format time as MM:SS.ms
 */
export function formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}

/**
 * Format file size
 */
export function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Debounce function
 */
export function debounce<T extends (...args: unknown[]) => void>(
    fn: T,
    delay: number
): (...args: Parameters<T>) => void {
    let timeoutId: number | null = null;
    return (...args: Parameters<T>) => {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
        timeoutId = window.setTimeout(() => fn(...args), delay);
    };
}

/**
 * Throttle function
 */
export function throttle<T extends (...args: unknown[]) => void>(
    fn: T,
    limit: number
): (...args: Parameters<T>) => void {
    let inThrottle = false;
    return (...args: Parameters<T>) => {
        if (!inThrottle) {
            fn(...args);
            inThrottle = true;
            setTimeout(() => inThrottle = false, limit);
        }
    };
}

/**
 * Generate unique ID
 */
export function generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

/**
 * Deep clone object
 */
export function deepClone<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj));
}

/**
 * Check if running in Electron
 */
export function isElectron(): boolean {
    return typeof window !== 'undefined' &&
        typeof window.process === 'object' &&
        (window.process as NodeJS.Process).type === 'renderer';
}

/**
 * Create element with classes
 */
export function createElement<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    parent?: HTMLElement
): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    if (className) {
        element.className = className;
    }
    if (parent) {
        parent.appendChild(element);
    }
    return element;
}

/**
 * Remove all children from element
 */
export function clearElement(element: HTMLElement): void {
    while (element.firstChild) {
        element.removeChild(element.firstChild);
    }
}

/**
 * Get mouse position relative to element
 */
export function getMousePosition(
    event: MouseEvent,
    element: HTMLElement
): { x: number; y: number } {
    const rect = element.getBoundingClientRect();
    return {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top
    };
}

/**
 * Animation loop return type
 */
export interface AnimationLoop {
    start: () => void;
    stop: () => void;
}

/**
 * Request animation frame with delta time
 */
export function createAnimationLoop(
    callback: (deltaTime: number) => void
): AnimationLoop {
    let running = false;
    let lastTime = 0;
    let animationId: number;

    const loop = (time: number) => {
        if (!running) return;

        const deltaTime = lastTime ? (time - lastTime) / 1000 : 0;
        lastTime = time;

        callback(deltaTime);
        animationId = requestAnimationFrame(loop);
    };

    return {
        start: () => {
            if (!running) {
                running = true;
                lastTime = 0;
                animationId = requestAnimationFrame(loop);
            }
        },
        stop: () => {
            running = false;
            cancelAnimationFrame(animationId);
        }
    };
}
