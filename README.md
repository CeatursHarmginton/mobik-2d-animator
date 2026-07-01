# Mobik – 2D Animator

Professional 2D animation editor and sprite-sheet pipeline for game/app
mascots. The color/normalize core is **DOM-free** so the exact same code runs in
the Electron renderer, in a pure-Node CLI, and under Jest.

## Scripts

| Command | Description |
| --- | --- |
| `npm run build` | Compile TypeScript (`tsc`) and copy static assets. |
| `npm start` | Build and launch the Electron editor. |
| `npm test` | Run the Jest unit tests. |
| `npm run normalize -- <args>` | Run the sprite-sheet normalize CLI (see below). |
| `npm run demo` | Build and launch the interactive demo. |
| `npm run package` | Build a distributable with electron-builder. |

## Core modules

- `src/core/normalize` – **Normalize by Reference**: align every frame of a
  sheet against one reference image so a set of separately-generated animations
  share one canvas size, one global scale, one anchor and stable placement.
- `src/core/color` – **Reference Palette Match**: perceptual, part-aware LAB
  palette harmonization (recolor a sheet toward a reference while preserving
  each pixel's own shading).

---

## Normalize by Reference

`SpriteSheetNormalizer.normalize(reference, sheet)` returns a `NormalizeResult`
(combined `sheet`, per-frame `frames`, `placements`, `globalScale`,
`rawGlobalScale`, `autoReduced`, `metadata`, `warnings`, …).

A **single global scale** is computed for the whole sheet and applied to every
frame (never per-frame) so the character does not pulse/breathe during playback.
Crop-safety can only ever reduce the scale, never increase it.

Presets: `standing`, `floating`, `jump`, `kaboo`
(`SpriteSheetNormalizer.fromPreset(name, { columns, rows, … })`).

### Debug overlay / before-after preview

All three flags default **off** and never change the primary `sheet` output.

| Option (`NormalizeOptions`) | Effect |
| --- | --- |
| `debugOverlay` | Adds `result.overlaySheet`: a copy of the normalized sheet annotated per frame with bbox, placement rect, anchor point, safe area, reference baseline, canvas center, frame index, global scale, and clamp / crop-risk flags. Drawn with a built-in DOM-free bitmap font. |
| `includeBeforeAfterPreview` | Adds `result.beforeSheet`: a verbatim copy of the input sheet (the "before" of a before/after comparison). |
| `debugMetadata` | Adds a backward-compatible optional `debug` block to `result.debug` and to the metadata JSON (`raw_global_scale`, `auto_reduced`, `canvas_center`, `reference_baseline_y`, and per-frame `clamped_x` / `clamped_y` / `crop_risk`). The base metadata schema is unchanged when off. |

Structured, DOM-free diagnostics are exposed via `result.debug`
(`NormalizeDebugInfo`); the overlay image is rendered from it by
`renderDebugOverlaySheet(afterSheet, debug, layout)`.

### CLI

```
node dist/cli/normalize-cli.js --reference ref.png --columns 8 --rows 1 \
  --preset standing --output out/ sheet1.png sheet2.png
```

Debug flags (all optional, off by default; never change the primary output):

| Flag | Output |
| --- | --- |
| `--debug-overlay` | also writes `<name>_overlay.png` (annotated sheet) |
| `--before-after` | also writes `<name>_before.png` (copy of the input) |
| `--debug-metadata` | adds a `debug` block to the metadata JSON |

In the editor, the same flags are exposed as the **Debug output** checkboxes in
the *Normalize by Reference* panel.

---

## Reference Palette Match

The engine maps every source cluster to the perceptually nearest reference
cluster (hue/chroma-weighted CIEDE2000) and recolors pixels toward it while
re-applying each pixel's original lightness delta, so shading survives.
`strength`, `preserveShading` and `lightnessTolerance` behave as before.

### Cross-frame color consistency

Matching frames independently can cause color **flicker** across an animation
(each frame clusters its own source palette differently). The
`paletteConsistency` option controls this:

| Mode | Behavior |
| --- | --- |
| `per_frame` | Legacy: each frame extracts and maps its own palette. Byte-for-byte unchanged. |
| `global_sheet` | Samples **one** source palette across all target frames (bounded sampling) and maps it to the reference once, then applies that single plan to every frame → no flicker, shading preserved. |
| `reference_locked` | Locks the clustering to the reference palette itself (identity map); the palette is identical for every frame. |

Guards: an empty reference palette, a fully transparent sheet, or a failed
sample all fall back to returning untouched copies.

**Defaults:** the core primitives keep `per_frame` (backward compatible). The
editor UI, "Apply to frames" and scaled export default to `global_sheet` and
expose a **Color Consistency** dropdown (Global / Locked to reference / Per
frame). The live single-frame preview uses the *same shared plan* as the full
apply, so the preview matches the applied/exported result exactly.

### API

```ts
// Extract a weighted reference palette.
extractReferencePalette(referenceFrame, options): ReferencePalette

// Match one frame (per-frame).
applyPaletteMatch(frame, palette, options): ImageData

// Match many frames; palette is taken from frames[referenceIndex].
applyPaletteMatchToFrames(frames, referenceIndex, options): ImageData[]

// Match many frames against an EXTERNAL / cached palette, with a consistency mode.
applyPaletteMatchAcrossFrames(frames, palette, options): ImageData[]

// Build a reusable cross-frame plan (global_sheet / reference_locked) and apply
// it to a single frame — used so a UI preview matches the full apply exactly.
buildPaletteMatchPlan(frames, palette, options): PaletteMatchPlan | null
applyPaletteMatchPlan(frame, plan, options): ImageData
```

`options.paletteConsistency` is `'per_frame' | 'global_sheet' | 'reference_locked'`.

---

## Testing

```
npm test
```

Jest runs in a `node` environment with a small `ImageData` polyfill
(`tests/setup.ts`). Coverage includes normalize math, image ops, palette
extraction/matching, cross-frame consistency (per-frame parity, shared-plan
stability, reference-locked safety), and the debug outputs.
