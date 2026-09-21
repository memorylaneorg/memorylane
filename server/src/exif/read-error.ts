export function exifReadError(tags: Record<string, unknown> | null): string | null {
  if (!tags) return null;
  if (typeof tags.Error === "string") return tags.Error;
  if (Array.isArray(tags.errors) && tags.errors.length > 0) return String(tags.errors[0]);
  return null;
}
