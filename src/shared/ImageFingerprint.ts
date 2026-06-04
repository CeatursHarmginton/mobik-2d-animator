/**
 * Image Fingerprinting Utility
 * Uses perceptual hashing (pHash) to compare images for visual similarity.
 * Detects if two images are the same content with different sizes.
 * @module shared/ImageFingerprint
 */

/** Size to resize images for hash computation */
const HASH_SIZE = 8;

/** Default similarity threshold for "same image" detection */
const DEFAULT_THRESHOLD = 0.9;

/**
 * Compute a perceptual hash for an image.
 * The hash is a 64-bit binary string representing the image's visual fingerprint.
 */
export function computeHash(image: HTMLImageElement): string {
    // Create a small canvas for processing
    const canvas = document.createElement('canvas');
    canvas.width = HASH_SIZE;
    canvas.height = HASH_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';

    // Disable smoothing for consistent results
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'low';

    // Draw image scaled down to HASH_SIZE x HASH_SIZE
    ctx.drawImage(image, 0, 0, HASH_SIZE, HASH_SIZE);

    // Get pixel data
    const imageData = ctx.getImageData(0, 0, HASH_SIZE, HASH_SIZE);
    const pixels = imageData.data;

    // Convert to grayscale values
    const grays: number[] = [];
    for (let i = 0; i < pixels.length; i += 4) {
        // Use luminance formula: 0.299R + 0.587G + 0.114B
        const gray = pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114;
        grays.push(gray);
    }

    // Compute the mean value
    const mean = grays.reduce((a, b) => a + b, 0) / grays.length;

    // Generate binary hash: 1 if pixel >= mean, 0 otherwise
    let hash = '';
    for (const gray of grays) {
        hash += gray >= mean ? '1' : '0';
    }

    return hash;
}

/**
 * Compute the Hamming distance between two hashes.
 * Returns the number of differing bits.
 */
export function hammingDistance(hash1: string, hash2: string): number {
    if (hash1.length !== hash2.length) {
        throw new Error('Hashes must be the same length');
    }

    let distance = 0;
    for (let i = 0; i < hash1.length; i++) {
        if (hash1[i] !== hash2[i]) {
            distance++;
        }
    }
    return distance;
}

/**
 * Compare two hashes and return a similarity score (0-1).
 * 1 = identical, 0 = completely different.
 */
export function compareHashes(hash1: string, hash2: string): number {
    if (!hash1 || !hash2) return 0;
    if (hash1.length !== hash2.length) return 0;

    const distance = hammingDistance(hash1, hash2);
    const maxDistance = hash1.length; // 64 bits
    return 1 - (distance / maxDistance);
}

/**
 * Compare two images and return their similarity score (0-1).
 */
export function compareImages(img1: HTMLImageElement, img2: HTMLImageElement): number {
    const hash1 = computeHash(img1);
    const hash2 = computeHash(img2);
    return compareHashes(hash1, hash2);
}

/**
 * Check if two images are visually the same (accounting for size differences).
 * @param img1 First image
 * @param img2 Second image
 * @param threshold Minimum similarity score to consider "same" (default 0.9)
 */
export function isSameImage(
    img1: HTMLImageElement,
    img2: HTMLImageElement,
    threshold: number = DEFAULT_THRESHOLD
): boolean {
    return compareImages(img1, img2) >= threshold;
}

/**
 * Check if two images have different dimensions.
 */
export function sizesAreDifferent(img1: HTMLImageElement, img2: HTMLImageElement): boolean {
    return img1.naturalWidth !== img2.naturalWidth || img1.naturalHeight !== img2.naturalHeight;
}

/**
 * Calculate the scale factors needed to match img2's size to img1's size.
 */
export function calculateScaleToMatch(
    referenceImg: HTMLImageElement,
    targetImg: HTMLImageElement
): { scaleX: number; scaleY: number } {
    return {
        scaleX: referenceImg.naturalWidth / targetImg.naturalWidth,
        scaleY: referenceImg.naturalHeight / targetImg.naturalHeight
    };
}

/**
 * Convenience class for image fingerprinting operations.
 */
export class ImageFingerprint {
    static computeHash = computeHash;
    static compareHashes = compareHashes;
    static hammingDistance = hammingDistance;
    static compareImages = compareImages;
    static isSameImage = isSameImage;
    static sizesAreDifferent = sizesAreDifferent;
    static calculateScaleToMatch = calculateScaleToMatch;
}

export default ImageFingerprint;
