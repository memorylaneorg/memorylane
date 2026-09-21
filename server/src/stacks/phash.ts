// Classic DCT perceptual hash (pHash): 32x32 grayscale -> 2D DCT -> keep the
// 8x8 lowest frequencies -> 1 bit per coefficient vs. their median (DC term
// excluded from the median and forced to 0). Robust to resize, mild noise,
// JPEG re-encoding and small exposure shifts; sensitive to composition
// changes - exactly the "same moment, tiny variation" signal bursts need.
export const PHASH_VERSION = "phash-dct-v1";
export const PHASH_SIZE = 32;
const LOW = 8;

const COS: number[][] = [];
for (let u = 0; u < LOW; u++) {
  COS[u] = [];
  for (let x = 0; x < PHASH_SIZE; x++) COS[u][x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * PHASH_SIZE));
}

export function phashFromGray(pixels: Uint8Array | number[], size: number = PHASH_SIZE): string {
  if (size !== PHASH_SIZE) throw new Error(`phash expects ${PHASH_SIZE}x${PHASH_SIZE} input`);
  if (pixels.length !== size * size) throw new Error(`phash expects ${size * size} pixels, got ${pixels.length}`);
  // Separable DCT: rows first (only the LOW lowest u), then columns.
  const rows: number[][] = [];
  for (let y = 0; y < size; y++) {
    rows[y] = [];
    for (let u = 0; u < LOW; u++) {
      let s = 0;
      for (let x = 0; x < size; x++) s += pixels[y * size + x] * COS[u][x];
      rows[y][u] = s;
    }
  }
  const coeffs: number[] = [];
  for (let v = 0; v < LOW; v++) {
    for (let u = 0; u < LOW; u++) {
      let s = 0;
      for (let y = 0; y < size; y++) s += rows[y][u] * COS[v][y];
      coeffs.push(s);
    }
  }
  const ac = coeffs.slice(1).sort((a, b) => a - b);
  const median = (ac[31] + ac[32]) / 2;
  let bits = 0n;
  for (let i = 1; i < 64; i++) {
    if (coeffs[i] > median) bits |= 1n << BigInt(63 - i);
  }
  return bits.toString(16).padStart(16, "0");
}

export function hammingHex(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}
