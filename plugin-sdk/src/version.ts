const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;
const COMPARATOR_PATTERN = /^(>=|<=|>|<|=)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

interface Version {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

function parseVersion(value: string): Version | null {
  const match = VERSION_PATTERN.exec(value);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    ...(match[4] ? { prerelease: match[4] } : {}),
  };
}

function compare(left: Version, right: Version): number {
  for (const field of ["major", "minor", "patch"] as const) {
    if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease.localeCompare(right.prerelease);
}

export function isValidPluginVersion(value: string): boolean {
  return parseVersion(value) !== null;
}

/**
 * Core ranges deliberately use a small, auditable subset of npm semver:
 * whitespace-separated exact versions and <, <=, >, >= comparators.
 */
export function isValidCoreRange(range: string): boolean {
  const parts = range.trim().split(/\s+/);
  return parts.length > 0 && parts.every((part) => COMPARATOR_PATTERN.test(part));
}

export function coreVersionSatisfies(version: string, range: string): boolean {
  const parsedVersion = parseVersion(version);
  if (!parsedVersion || !isValidCoreRange(range)) return false;

  return range.trim().split(/\s+/).every((part) => {
    const match = COMPARATOR_PATTERN.exec(part)!;
    const expected = parseVersion(`${match[2]}.${match[3]}.${match[4]}${match[5] ? `-${match[5]}` : ""}`)!;
    const result = compare(parsedVersion, expected);
    switch (match[1] ?? "=") {
      case ">": return result > 0;
      case ">=": return result >= 0;
      case "<": return result < 0;
      case "<=": return result <= 0;
      default: return result === 0;
    }
  });
}
