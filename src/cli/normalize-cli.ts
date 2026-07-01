/**
 * Sprite Sheet Normalize - CLI / batch entry point.
 * @module cli/normalize-cli
 *
 * Runs the exact same DOM-free SpriteSheetNormalizer used by the UI, decoding /
 * encoding PNGs with the dependency-free codec in ./png. Supports batch mode:
 * one reference + one preset/option set applied to many sheets.
 *
 * Build first (`npm run build`), then:
 *
 *   node dist/cli/normalize-cli.js \
 *     --reference ref.png --columns 8 --rows 1 \
 *     --preset standing --output out/ sheet1.png sheet2.png
 *
 * or via the npm script:  npm run normalize -- --reference ref.png ... sheet.png
 */

import * as fs from 'fs';
import * as path from 'path';
import { SpriteSheetNormalizer } from '../core/normalize/SpriteSheetNormalizer';
import {
    AnchorMode,
    NORMALIZE_PRESETS,
    NormalizeOptions,
    NormalizePresetName,
    ScaleMode
} from '../core/normalize/types';
import { decodePng, encodePng } from './png';

interface CliArgs {
    reference?: string;
    output?: string;
    preset?: NormalizePresetName;
    options: Partial<NormalizeOptions>;
    inputs: string[];
    metadata: boolean;
    individualFrames: boolean;
    help: boolean;
}

const ANCHOR_MODES: AnchorMode[] = ['bottom-center', 'center', 'upper-center'];
const SCALE_MODES: ScaleMode[] = ['match_reference_height', 'fit_safe_area', 'manual_scale'];

function printUsage(): void {
    const presets = Object.keys(NORMALIZE_PRESETS).join(' | ');
    console.log(`
Sprite Sheet Normalize by Reference - CLI

Usage:
  node dist/cli/normalize-cli.js --reference <ref.png> --columns <n> --rows <n> [options] <sheet.png> [more.png ...]

Required:
  -r, --reference <path>     Reference image (defines canvas size + character size)
  -c, --columns <n>          Grid columns
  -R, --rows <n>             Grid rows

Output:
  -o, --output <path>        Output file (single sheet) or directory (batch).
                             Default: alongside each input as <name>_normalized.png
      --no-metadata          Do not write the metadata JSON
      --individual-frames    Also write each normalized frame as a separate PNG

Preset (applied first, then overridden by explicit options):
      --preset <name>        ${presets}

Scale / anchor:
      --anchor <mode>        ${ANCHOR_MODES.join(' | ')}
      --scale-mode <mode>    ${SCALE_MODES.join(' | ')}
      --scale-ratio <f>      match_reference_height multiplier (default 1.0)
      --target-height-ratio <f>  fit_safe_area ratio (default 0.85)
      --manual-scale <f>     manual_scale value (default 1.0)
      --safe-padding <n>     transparent margin px (default 40)
      --alpha-threshold <n>  alpha cutoff for bbox (default 10)
      --bbox-padding <n>     extra px kept around bbox (default 2)
      --top-offset <n>       extra top offset for upper-center (default 0)
      --no-smoothing         disable temporal placement smoothing
      --no-auto-reduce       disable auto scale reduction (allow cropping)

Debug (all optional, off by default; never change the primary output):
      --debug-overlay        also write <name>_overlay.png (annotated sheet)
      --before-after         also write <name>_before.png (copy of the input)
      --debug-metadata       add a "debug" block to the metadata JSON

  -h, --help                 Show this help
`);
}

function parseArgs(argv: string[]): CliArgs {
    const args: CliArgs = {
        options: {},
        inputs: [],
        metadata: true,
        individualFrames: false,
        help: false
    };

    const needNumber = (flag: string, value: string | undefined): number => {
        const n = Number(value);
        if (value === undefined || Number.isNaN(n)) throw new Error(`Option ${flag} requires a number.`);
        return n;
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = (): string | undefined => argv[++i];
        switch (arg) {
            case '-h': case '--help': args.help = true; break;
            case '-r': case '--reference': args.reference = next(); break;
            case '-o': case '--output': args.output = next(); break;
            case '-c': case '--columns': args.options.columns = needNumber(arg, next()); break;
            case '-R': case '--rows': args.options.rows = needNumber(arg, next()); break;
            case '--preset': {
                const v = next() as NormalizePresetName | undefined;
                if (!v || !(v in NORMALIZE_PRESETS)) throw new Error(`Unknown preset "${v}".`);
                args.preset = v;
                break;
            }
            case '--anchor': {
                const v = next() as AnchorMode;
                if (!ANCHOR_MODES.includes(v)) throw new Error(`Unknown anchor "${v}".`);
                args.options.anchorMode = v;
                break;
            }
            case '--scale-mode': {
                const v = next() as ScaleMode;
                if (!SCALE_MODES.includes(v)) throw new Error(`Unknown scale mode "${v}".`);
                args.options.scaleMode = v;
                break;
            }
            case '--scale-ratio': args.options.scaleRatio = needNumber(arg, next()); break;
            case '--target-height-ratio': args.options.targetHeightRatio = needNumber(arg, next()); break;
            case '--manual-scale': args.options.manualScale = needNumber(arg, next()); break;
            case '--safe-padding': args.options.safePadding = needNumber(arg, next()); break;
            case '--alpha-threshold': args.options.alphaThreshold = needNumber(arg, next()); break;
            case '--bbox-padding': args.options.bboxPadding = needNumber(arg, next()); break;
            case '--top-offset': args.options.topOffset = needNumber(arg, next()); break;
            case '--no-smoothing': args.options.smoothing = false; break;
            case '--no-auto-reduce': args.options.autoReduceScale = false; break;
            case '--debug-overlay': args.options.debugOverlay = true; break;
            case '--before-after': args.options.includeBeforeAfterPreview = true; break;
            case '--debug-metadata': args.options.debugMetadata = true; break;
            case '--no-metadata': args.metadata = false; break;
            case '--individual-frames': args.individualFrames = true; break;
            default:
                if (arg.startsWith('-')) throw new Error(`Unknown option "${arg}".`);
                args.inputs.push(arg);
        }
    }

    return args;
}

/** Decide the output PNG path for one input sheet. */
function resolveOutputPath(input: string, output: string | undefined, isBatch: boolean): string {
    const base = path.basename(input, path.extname(input));
    const defaultName = `${base}_normalized.png`;

    if (!output) {
        return path.join(path.dirname(input), defaultName);
    }

    // Treat as a directory when batching, when it already exists as a dir, or
    // when it does not look like a .png file path.
    const looksLikeDir = isBatch
        || (fs.existsSync(output) && fs.statSync(output).isDirectory())
        || path.extname(output).toLowerCase() !== '.png';

    if (looksLikeDir) {
        fs.mkdirSync(output, { recursive: true });
        return path.join(output, defaultName);
    }

    fs.mkdirSync(path.dirname(output), { recursive: true });
    return output;
}

function processSheet(
    normalizer: SpriteSheetNormalizer,
    referenceBuf: Buffer,
    inputPath: string,
    outputPng: string,
    writeMetadata: boolean,
    writeFrames: boolean
): void {
    const reference = decodePng(referenceBuf);
    const sheet = decodePng(fs.readFileSync(inputPath));

    const result = normalizer.normalize(reference, sheet);

    // Write the combined normalized sheet.
    fs.writeFileSync(outputPng, encodePng(result.sheet));
    console.log(`  -> ${outputPng}  (${result.sheet.width}x${result.sheet.height}, scale ${result.globalScale.toFixed(4)})`);

    // Metadata JSON sits next to the output PNG.
    if (writeMetadata) {
        const metaPath = outputPng.replace(/\.png$/i, '') + '.normalize.json';
        fs.writeFileSync(metaPath, SpriteSheetNormalizer.metadataToJson(result.metadata));
        console.log(`  -> ${metaPath}`);
    }

    // Optional individual frames.
    if (writeFrames) {
        const stem = outputPng.replace(/\.png$/i, '');
        const pad = String(result.frames.length - 1).length;
        result.frames.forEach((frame, i) => {
            const framePath = `${stem}_frame_${String(i).padStart(pad, '0')}.png`;
            fs.writeFileSync(framePath, encodePng(frame));
        });
        console.log(`  -> ${result.frames.length} individual frames`);
    }

    // Optional debug outputs (only present when the matching flag was set).
    const stem = outputPng.replace(/\.png$/i, '');
    if (result.overlaySheet) {
        const overlayPath = `${stem}_overlay.png`;
        fs.writeFileSync(overlayPath, encodePng(result.overlaySheet));
        console.log(`  -> ${overlayPath}  (debug overlay)`);
    }
    if (result.beforeSheet) {
        const beforePath = `${stem}_before.png`;
        fs.writeFileSync(beforePath, encodePng(result.beforeSheet));
        console.log(`  -> ${beforePath}  (before)`);
    }

    // Surface warnings (non-fatal).
    for (const w of result.warnings) {
        console.warn(`  [warn:${w.code}] ${w.message}`);
    }
}

function main(): void {
    let args: CliArgs;
    try {
        args = parseArgs(process.argv.slice(2));
    } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        printUsage();
        process.exit(1);
        return;
    }

    if (args.help) {
        printUsage();
        return;
    }

    // Validate required inputs.
    const missing: string[] = [];
    if (!args.reference) missing.push('--reference');
    if (args.options.columns === undefined) missing.push('--columns');
    if (args.options.rows === undefined) missing.push('--rows');
    if (args.inputs.length === 0) missing.push('<sheet.png>');
    if (missing.length > 0) {
        console.error(`Error: missing required argument(s): ${missing.join(', ')}`);
        printUsage();
        process.exit(1);
        return;
    }

    // Build the normalizer (preset first, then explicit overrides).
    const config = { columns: args.options.columns!, rows: args.options.rows!, ...args.options };
    const normalizer = args.preset
        ? SpriteSheetNormalizer.fromPreset(args.preset, config)
        : new SpriteSheetNormalizer(config);

    const referenceBuf = fs.readFileSync(args.reference!);
    const isBatch = args.inputs.length > 1;

    console.log(`Normalizing ${args.inputs.length} sheet(s) against ${path.basename(args.reference!)}`);
    if (args.preset) console.log(`Preset: ${args.preset}`);

    let failures = 0;
    for (const input of args.inputs) {
        console.log(`\n${input}`);
        try {
            const outputPng = resolveOutputPath(input, args.output, isBatch);
            processSheet(normalizer, referenceBuf, input, outputPng, args.metadata, args.individualFrames);
        } catch (err) {
            failures++;
            console.error(`  Failed: ${(err as Error).message}`);
        }
    }

    console.log(`\nDone. ${args.inputs.length - failures}/${args.inputs.length} succeeded.`);
    if (failures > 0) process.exit(1);
}

main();
