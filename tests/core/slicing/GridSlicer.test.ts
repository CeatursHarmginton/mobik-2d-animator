import { GridSlicer, GridSliceConfig } from '../../../src/core/slicing/GridSlicer';

/** Minimal HTMLImageElement stand-in exposing only the natural dimensions. */
function fakeImage(naturalWidth: number, naturalHeight: number): HTMLImageElement {
    return { naturalWidth, naturalHeight } as unknown as HTMLImageElement;
}

describe('GridSlicer.detectGridSize', () => {
    it('detects the first common cell size that divides both dimensions', () => {
        const config = GridSlicer.detectGridSize(fakeImage(64, 32));
        expect(config).not.toBeNull();
        expect(config).toMatchObject({
            cellWidth: 16,
            cellHeight: 16,
            columns: 4,
            rows: 2
        });
    });

    it('falls back to the greatest common divisor when no common size fits', () => {
        const config = GridSlicer.detectGridSize(fakeImage(24, 36));
        expect(config).toMatchObject({
            cellWidth: 12,
            cellHeight: 12,
            columns: 2,
            rows: 3
        });
    });

    it('returns null when the GCD is too small to be a sensible cell', () => {
        expect(GridSlicer.detectGridSize(fakeImage(7, 13))).toBeNull();
    });
});

describe('GridSlicer.previewSlice', () => {
    it('derives the grid from the image size when columns/rows are omitted', () => {
        const slicer = new GridSlicer(fakeImage(64, 64), 'sheet.png');
        const regions = slicer.previewSlice({ cellWidth: 32, cellHeight: 32 });

        expect(regions).toHaveLength(4);
        expect(regions[0]).toEqual({ x: 0, y: 0, w: 32, h: 32 });
        expect(regions[3]).toEqual({ x: 32, y: 32, w: 32, h: 32 });
    });

    it('honours explicit columns and rows', () => {
        const slicer = new GridSlicer(fakeImage(100, 100), 'sheet.png');
        const config: GridSliceConfig = { cellWidth: 16, cellHeight: 16, columns: 3, rows: 2 };
        expect(slicer.previewSlice(config)).toHaveLength(6);
    });

    it('accounts for spacing between cells', () => {
        const slicer = new GridSlicer(fakeImage(64, 32), 'sheet.png');
        // columns = floor((64 + 2) / (30 + 2)) = 2, rows = floor((32 + 2) / 32) = 1
        const regions = slicer.previewSlice({ cellWidth: 30, cellHeight: 30, spacing: 2 });

        expect(regions).toHaveLength(2);
        expect(regions[0]).toEqual({ x: 0, y: 0, w: 30, h: 30 });
        expect(regions[1]).toEqual({ x: 32, y: 0, w: 30, h: 30 });
    });
});
