import path from "node:path";
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";

interface Grant { pluginId: string; mediaId: number; sourcePath: string; expiresAt: number }

// Plugins receive short-lived opaque tokens. Only core resolves database paths,
// checks active media and scan-root containment, and chooses output paths.
export class SourceAuthority {
  private grants = new Map<string, Grant>();
  constructor(private db: Database.Database, private ttlMs = 5 * 60_000) {}

  issue(pluginId: string, mediaId: number): string {
    const row = this.db.prepare(`SELECT media.absolute_path, scan_roots.path AS root_path FROM media
      JOIN scan_roots ON scan_roots.id = media.scan_root_id WHERE media.id = ? AND media.status = 'active'`)
      .get(mediaId) as { absolute_path: string; root_path: string } | undefined;
    if (!row) throw new Error("Active media not found");
    const sourcePath = path.resolve(row.absolute_path);
    const root = path.resolve(row.root_path);
    if (sourcePath !== root && !sourcePath.startsWith(root + path.sep)) throw new Error("Media path is outside its scan root");
    const token = randomBytes(32).toString("base64url");
    this.grants.set(token, { pluginId, mediaId, sourcePath, expiresAt: Date.now() + this.ttlMs });
    return token;
  }

  resolve(pluginId: string, token: string, mediaId: number): string {
    const grant = this.grants.get(token);
    this.grants.delete(token); // single use, including rejected attempts
    if (!grant || grant.expiresAt < Date.now() || grant.pluginId !== pluginId || grant.mediaId !== mediaId) {
      throw new Error("Invalid or expired source token");
    }
    return grant.sourcePath;
  }
}
