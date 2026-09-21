import { describe, it, expect } from "vitest";
import { phashFromGray, hammingHex, PHASH_SIZE } from "../../src/stacks/phash.js";

// A synthetic "scene" with real low-frequency structure (a flat gradient has
// most DCT coefficients hugging the median, so noise flips marginal bits).
function scene(seed = 0, noise = 0, shift = 0): Uint8Array {
  const px = new Uint8Array(PHASH_SIZE * PHASH_SIZE);
  let s = seed;
  for (let y = 0; y < PHASH_SIZE; y++)
    for (let x = 0; x < PHASH_SIZE; x++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const n = noise ? (s % (2 * noise + 1)) - noise : 0;
      const v = 128 + 60 * Math.sin((x + shift) / 5) * Math.cos(y / 7) + 40 * Math.sin((x + y + shift) / 9) + n;
      px[y * PHASH_SIZE + x] = Math.max(0, Math.min(255, Math.round(v)));
    }
  return px;
}

describe("phash", () => {
  it("is 16 hex chars and deterministic", () => {
    const h = phashFromGray(scene());
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(phashFromGray(scene())).toBe(h);
  });
  it("is stable under small noise and far for a different image", () => {
    const a = phashFromGray(scene());
    expect(hammingHex(a, phashFromGray(scene(7, 6)))).toBeLessThanOrEqual(8); // sensor noise
    expect(hammingHex(a, phashFromGray(scene(0, 0, 2)))).toBeLessThanOrEqual(10); // slight subject shift
    const inverted = scene().map((v) => 255 - v);
    expect(hammingHex(a, phashFromGray(inverted))).toBeGreaterThanOrEqual(40);
    const gradient = Uint8Array.from({ length: PHASH_SIZE * PHASH_SIZE }, (_, i) => (i % PHASH_SIZE) * 8);
    expect(hammingHex(a, phashFromGray(gradient))).toBeGreaterThanOrEqual(30); // unrelated scene
  });
  it("hammingHex counts differing bits", () => {
    expect(hammingHex("0000000000000000", "0000000000000000")).toBe(0);
    expect(hammingHex("0000000000000000", "ffffffffffffffff")).toBe(64);
    expect(hammingHex("0000000000000001", "0000000000000003")).toBe(1);
  });
  it("rejects a wrong pixel count", () => {
    expect(() => phashFromGray(new Uint8Array(10))).toThrow();
  });
});
