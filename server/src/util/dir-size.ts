import fs from "node:fs/promises";
import path from "node:path";

// Recursively sums file sizes under a directory. Used for Settings' storage
// display (thumbnail cache / logs size) - not on any hot path, so a plain
// async walk is fine even for a large thumbnail cache since it's sharded
// into many small subdirectories rather than one huge flat one.
export async function getDirectorySize(dirPath: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += await getDirectorySize(entryPath);
    } else if (entry.isFile()) {
      try {
        total += (await fs.stat(entryPath)).size;
      } catch {
        // File removed between readdir and stat - ignore.
      }
    }
  }
  return total;
}

export async function getFileSize(filePath: string): Promise<number> {
  try {
    return (await fs.stat(filePath)).size;
  } catch {
    return 0;
  }
}
