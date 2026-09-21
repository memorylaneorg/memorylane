import path from "node:path";

/** Validate a path stored inside a plugin archive before it touches disk. */
export function isSafePluginRelativePath(value: string): boolean {
  if (!value || value.includes("\0") || value.includes("\\")) return false;
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;

  const normalized = path.posix.normalize(value);
  return normalized !== "." && normalized !== ".." && !normalized.startsWith("../") && normalized === value;
}

export function assertSafePluginRelativePath(value: string): string {
  if (!isSafePluginRelativePath(value)) {
    throw new Error(`Unsafe plugin package path: ${JSON.stringify(value)}`);
  }
  return value;
}
