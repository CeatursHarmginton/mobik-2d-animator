import {
    clamp,
    lerp,
    round,
    formatTime,
    formatFileSize,
    generateId,
    deepClone,
    throttle,
    isElectron
} from '../../src/shared/utils';

describe('clamp', () => {
    it('returns the value when within range', () => {
        expect(clamp(5, 0, 10)).toBe(5);
    });

    it('clamps to the minimum', () => {
        expect(clamp(-3, 0, 10)).toBe(0);
    });

    it('clamps to the maximum', () => {
        expect(clamp(42, 0, 10)).toBe(10);
    });

    it('treats the bounds as inclusive', () => {
        expect(clamp(0, 0, 10)).toBe(0);
        expect(clamp(10, 0, 10)).toBe(10);
    });
});

describe('lerp', () => {
    it('returns a at t = 0', () => {
        expect(lerp(0, 10, 0)).toBe(0);
    });

    it('returns b at t = 1', () => {
        expect(lerp(0, 10, 1)).toBe(10);
    });

    it('interpolates intermediate values', () => {
        expect(lerp(0, 10, 0.5)).toBe(5);
        expect(lerp(10, 20, 0.25)).toBe(12.5);
    });
});

describe('round', () => {
    it('rounds to two decimals by default', () => {
        expect(round(3.14159)).toBe(3.14);
        expect(round(1.2356)).toBe(1.24);
    });

    it('honours an explicit decimal count', () => {
        expect(round(3.14159, 3)).toBe(3.142);
        expect(round(2.5, 0)).toBe(3);
    });
});

describe('formatTime', () => {
    it('formats zero', () => {
        expect(formatTime(0)).toBe('00:00.00');
    });

    it('formats seconds and centiseconds', () => {
        expect(formatTime(5)).toBe('00:05.00');
        expect(formatTime(125.25)).toBe('02:05.25');
    });

    it('does not roll minutes into hours', () => {
        expect(formatTime(3661)).toBe('61:01.00');
    });
});

describe('formatFileSize', () => {
    it('formats bytes', () => {
        expect(formatFileSize(0)).toBe('0 B');
        expect(formatFileSize(512)).toBe('512 B');
    });

    it('formats kilobytes with one decimal', () => {
        expect(formatFileSize(1024)).toBe('1.0 KB');
        expect(formatFileSize(1536)).toBe('1.5 KB');
    });

    it('formats megabytes with two decimals', () => {
        expect(formatFileSize(1024 * 1024)).toBe('1.00 MB');
        expect(formatFileSize(5 * 1024 * 1024)).toBe('5.00 MB');
    });
});

describe('generateId', () => {
    it('produces a non-empty base36 string', () => {
        const id = generateId();
        expect(typeof id).toBe('string');
        expect(id.length).toBeGreaterThan(0);
        expect(id).toMatch(/^[a-z0-9]+$/);
    });

    it('produces distinct ids on successive calls', () => {
        expect(generateId()).not.toBe(generateId());
    });
});

describe('deepClone', () => {
    it('produces a structurally equal copy', () => {
        const original = { a: 1, b: { c: 2, d: [3, 4] } };
        expect(deepClone(original)).toEqual(original);
    });

    it('does not share nested references with the source', () => {
        const original = { nested: { value: 1 } };
        const clone = deepClone(original);
        clone.nested.value = 99;
        expect(original.nested.value).toBe(1);
    });
});

describe('throttle', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('invokes immediately, suppresses calls within the limit, then resumes', () => {
        const calls: number[] = [];
        const throttled = throttle((...args: unknown[]) => {
            calls.push(args[0] as number);
        }, 100);

        throttled(1);
        throttled(2);
        throttled(3);
        expect(calls).toEqual([1]);

        jest.advanceTimersByTime(100);
        throttled(4);
        expect(calls).toEqual([1, 4]);
    });
});

describe('isElectron', () => {
    it('returns false outside of an Electron renderer window', () => {
        expect(isElectron()).toBe(false);
    });
});
