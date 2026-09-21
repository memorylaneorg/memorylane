type Resource = Record<string, unknown>;

function flatten(resource: Resource, prefix = ""): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, value] of Object.entries(resource)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") result.set(path, value);
    else if (value && typeof value === "object") {
      for (const [nestedKey, nestedValue] of flatten(value as Resource, path)) result.set(nestedKey, nestedValue);
    }
  }
  return result;
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/{{\s*([\w.]+)\s*}}/g)].map((match) => match[1]).sort();
}

export function resourceParityErrors(source: Resource, translation: Resource, language: string): string[] {
  const sourceEntries = flatten(source);
  const translatedEntries = flatten(translation);
  const errors: string[] = [];
  for (const [key, value] of sourceEntries) {
    const translated = translatedEntries.get(key);
    if (translated === undefined) errors.push(`${language}: missing ${key}`);
    else if (placeholders(value).join("|") !== placeholders(translated).join("|")) errors.push(`${language}: placeholders differ for ${key}`);
  }
  for (const key of translatedEntries.keys()) if (!sourceEntries.has(key)) errors.push(`${language}: extra ${key}`);
  return errors;
}
