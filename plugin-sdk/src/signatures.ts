import { createHash, verify, type KeyLike } from "node:crypto";

/** Catalog publishers must sign the exact UTF-8 bytes they distribute. */
export function verifyEd25519Signature(payload: Uint8Array, signatureBase64: string, publicKey: KeyLike): boolean {
  try {
    return verify(null, payload, publicKey, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}

export function sha256Hex(payload: Uint8Array): string {
  return createHash("sha256").update(payload).digest("hex");
}

export function verifySha256(payload: Uint8Array, expectedHex: string): boolean {
  const actual = Buffer.from(sha256Hex(payload), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && actual.equals(expected);
}
