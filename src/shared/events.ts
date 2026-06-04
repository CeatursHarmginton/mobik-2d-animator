/**
 * Event System for Mobik Animator
 */

export type EventCallback<T = unknown> = (data: T) => void;

export class EventEmitter {
    private _listeners: Map<string, Set<EventCallback>> = new Map();

    on<T = unknown>(event: string, callback: EventCallback<T>): void {
        if (!this._listeners.has(event)) {
            this._listeners.set(event, new Set());
        }
        this._listeners.get(event)!.add(callback as EventCallback);
    }

    off<T = unknown>(event: string, callback: EventCallback<T>): void {
        const listeners = this._listeners.get(event);
        if (listeners) {
            listeners.delete(callback as EventCallback);
        }
    }

    emit<T = unknown>(event: string, data?: T): void {
        const listeners = this._listeners.get(event);
        if (listeners) {
            listeners.forEach(callback => callback(data));
        }
    }

    once<T = unknown>(event: string, callback: EventCallback<T>): void {
        const wrapper: EventCallback<T> = (data) => {
            this.off(event, wrapper);
            callback(data);
        };
        this.on(event, wrapper);
    }

    removeAllListeners(event?: string): void {
        if (event) {
            this._listeners.delete(event);
        } else {
            this._listeners.clear();
        }
    }
}

// Editor Events
export const EditorEvents = {
    // Project
    PROJECT_NEW: 'project:new',
    PROJECT_LOADED: 'project:loaded',
    PROJECT_SAVED: 'project:saved',
    PROJECT_MODIFIED: 'project:modified',

    // Animation
    ANIMATION_UPDATED: 'animation:updated',
    FRAMES_LOADED: 'frames:loaded',

    // Selection
    FRAME_SELECTED: 'frame:selected',
    FRAME_DESELECTED: 'frame:deselected',
    SELECTION_CHANGED: 'selection:changed',

    // Playback
    PLAYBACK_STARTED: 'playback:started',
    PLAYBACK_STOPPED: 'playback:stopped',
    PLAYBACK_FRAME_CHANGED: 'playback:frame-changed',

    // Canvas
    VIEWPORT_CHANGED: 'viewport:changed',
    ZOOM_CHANGED: 'zoom:changed',

    // Pivot
    PIVOT_CHANGED: 'pivot:changed',
    PIVOT_DRAG_START: 'pivot:drag-start',
    PIVOT_DRAG_END: 'pivot:drag-end',

    // Editor
    TOOL_CHANGED: 'tool:changed',
    ONION_SKIN_TOGGLED: 'onionskin:toggled',

    // Context Menu
    FRAME_CONTEXT_MENU: 'frame:context-menu',

    // Frame Transform
    FRAME_SCALE_CHANGED: 'frame:scale-changed',

    // Speed Control
    SPEED_CHANGED: 'speed:changed'
};

// Global event bus
export const globalEvents = new EventEmitter();
