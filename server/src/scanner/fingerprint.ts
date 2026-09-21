// Cheap change-detection signature: (size, mtime). Deliberately not a content
// hash - full-file hashing of a multi-TB library is too slow to run on every
// scan (see PLAN.md section 12 / section 5 of the product spec). This is
// isolated in one function so stronger hashing can replace it later without
// touching scanner logic.
export function computeFingerprint(sizeBytes: number, mtimeMs: number): string {
  return `${sizeBytes}:${Math.round(mtimeMs)}`;
}
