/**
 * Shared constants for Mobik Animator
 */

// Application
export const APP_NAME = 'Mobik Animator';
export const APP_VERSION = '1.0.0';

// Canvas
export const CANVAS_BACKGROUND = '#1a1a1a';
export const CANVAS_GRID_COLOR = '#2a2a2a';
export const CANVAS_GRID_SIZE = 32;

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 10;
export const ZOOM_STEP = 0.1;

// Timeline
export const TIMELINE_HEIGHT = 120;
export const FRAME_THUMBNAIL_SIZE = 64;
export const FRAME_THUMBNAIL_SPACING = 8;

// Pivot
export const PIVOT_HANDLE_SIZE = 12;
export const PIVOT_CROSSHAIR_SIZE = 20;
export const PIVOT_COLOR = '#ff6b6b';
export const PIVOT_COLOR_HOVER = '#ff8787';

// Onion Skin
export const ONION_SKIN_OPACITY_PREV = 0.3;
export const ONION_SKIN_OPACITY_NEXT = 0.2;
export const ONION_SKIN_COLOR_PREV = '#4dabf7';
export const ONION_SKIN_COLOR_NEXT = '#69db7c';

// Playback
export const DEFAULT_FPS = 12;
export const MIN_FPS = 1;
export const MAX_FPS = 60;

// Colors
export const COLORS = {
    background: '#1e1e1e',
    backgroundAlt: '#252525',
    surface: '#2d2d2d',
    surfaceHover: '#353535',
    border: '#3d3d3d',
    borderLight: '#4d4d4d',
    text: '#e0e0e0',
    textSecondary: '#a0a0a0',
    textMuted: '#707070',
    accent: '#4fc3f7',
    accentHover: '#29b6f6',
    warning: '#ffb74d',
    error: '#ef5350',
    success: '#66bb6a'
};

// IPC Channels
export const IPC_CHANNELS = {
    READ_DIRECTORY: 'read-directory',
    OPEN_FILE_DIALOG: 'open-file-dialog',
    OPEN_FOLDER_DIALOG: 'open-folder-dialog',
    SAVE_FILE_DIALOG: 'save-file-dialog',
    READ_FILE: 'read-file',
    WRITE_FILE: 'write-file',
    GET_APP_PATH: 'get-app-path'
};
