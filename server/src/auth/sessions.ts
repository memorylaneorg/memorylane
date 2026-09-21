import { nanoid } from "nanoid";
import type Database from "better-sqlite3";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, sliding

export interface SessionRow {
  id: string;
  user_id: number;
  expires_at: string;
}

export class SessionStore {
  constructor(private db: Database.Database) {}

  create(userId: number): { id: string; expiresAt: Date } {
    const id = nanoid(32);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    this.db
      .prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)")
      .run(id, userId, expiresAt.toISOString());
    return { id, expiresAt };
  }

  // Returns the user id for a valid, non-expired session, sliding the expiry forward.
  touch(sessionId: string): number | null {
    const row = this.db
      .prepare("SELECT id, user_id, expires_at FROM sessions WHERE id = ?")
      .get(sessionId) as SessionRow | undefined;
    if (!row) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) {
      this.destroy(sessionId);
      return null;
    }
    const newExpiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    this.db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").run(newExpiresAt, sessionId);
    return row.user_id;
  }

  destroy(sessionId: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
  }

  // Used after a password change - signs the user out everywhere except the
  // session that just performed the change, in case a lost/stolen session
  // elsewhere was the reason for changing the password.
  destroyAllForUser(userId: number, exceptSessionId?: string): void {
    this.db
      .prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?")
      .run(userId, exceptSessionId ?? "");
  }

  destroyAllExpired(): void {
    this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString());
  }
}

export const SESSION_COOKIE_NAME = "memorylane_session";
export const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;
