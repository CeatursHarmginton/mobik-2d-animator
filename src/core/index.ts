/**
 * Core Module - Barrel export
 */

// Models
export * from './models';

// Loaders
export * from './loaders';

// Slicing - explicit exports to avoid conflicts with models/types
export { GridSlicer } from './slicing/GridSlicer';
export { ManualSlicer } from './slicing/ManualSlicer';
export type { GridSliceConfig } from './slicing/GridSlicer';
export type { ManualSliceRegion } from './slicing/ManualSlicer';

// Export
export * from './export';

// Color
export * from './color';

// Runtime - explicit exports to avoid conflicts with models
export { AnimationPlayer } from './runtime/AnimationPlayer';
export { MetaParser } from './runtime/MetaParser';
export type {
    RuntimeMeta,
    RuntimeFrame,
    ParsedFrame,
    RenderOptions
} from './runtime/types';

