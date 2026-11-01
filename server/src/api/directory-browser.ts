import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DirectoryBrowseDto } from '@memorylane/shared';

/** Read-only, bounded directory pages on the server's filesystem. */
export async function browseDirectory(requested?: string, offset = 0): Promise<DirectoryBrowseDto> {
  const current = requested ?? os.homedir();
  if (!path.isAbsolute(current) || current.includes('\0')) throw new Error('An absolute folder path is required');
  const directory = await fs.realpath(current);
  const handle = await fs.opendir(directory);
  const folders: DirectoryBrowseDto['folders'] = [];
  let seen = 0, scanned = 0, more = false;
  try {
    for await (const entry of handle) {
      if (seen++ < offset) continue;
      if (scanned >= 1000 || folders.length >= 200) { more = true; break; }
      scanned++;
      if (entry.name.startsWith('.')) continue;
      const child = path.join(directory, entry.name);
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try { isDirectory = (await fs.stat(child)).isDirectory(); } catch { continue; }
      }
      if (isDirectory) folders.push({name: entry.name, path: child});
    }
  } finally { await handle.close().catch(() => {}); }
  const locations: DirectoryBrowseDto["locations"] = [{name: 'home' as const, path: os.homedir()}, {name: 'computer' as const, path: path.parse(directory).root}];
  if (process.platform === 'darwin') locations.push({name: 'drives' as const, path: '/Volumes'});
  else if (process.platform === 'win32') {
    for (let code = 65; code <= 90; code++) {
      const drive = String.fromCharCode(code) + ':\\';
      try { if ((await fs.stat(drive)).isDirectory()) locations.push({name: 'drives' as const, path: drive}); } catch { /* Unmounted drive. */ }
    }
  } else for (const mount of ['/mnt', '/media']) {
    try { if ((await fs.stat(mount)).isDirectory()) locations.push({name: 'drives' as const, path: mount}); } catch { /* Optional mount point. */ }
  }
  return {path: directory, parent: path.dirname(directory) === directory ? null : path.dirname(directory), folders: folders.sort((a,b)=>a.name.localeCompare(b.name)), locations, nextOffset: more ? offset + scanned : null};
}
