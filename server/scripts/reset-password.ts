// CLI escape hatch for a forgotten admin password - MemoryLane has no "forgot
// password" email flow (there's no email, no cloud), so this is the recovery
// path: run it on the machine hosting MemoryLane, with the server stopped or
// running (SQLite is in WAL mode, so a concurrent write is safe either way).
//
// Usage:
//   npm run reset-password --workspace=server                     # list usernames
//   npm run reset-password --workspace=server -- <username> <new-password>
import { resolveAppPaths } from "../src/config/paths.js";
import { openDatabase } from "../src/db/connection.js";
import { hashPassword } from "../src/auth/passwords.js";
import { passwordSchema } from "@memorylane/shared";

interface UserRow {
  id: number;
  username: string;
}

async function main(): Promise<void> {
  const [username, newPassword] = process.argv.slice(2);
  const paths = resolveAppPaths();
  const db = openDatabase(paths.dbPath);

  const users = db.prepare("SELECT id, username FROM users").all() as UserRow[];

  if (!username || !newPassword) {
    console.log(`Usage: npm run reset-password --workspace=server -- <username> <new-password>\n`);
    if (users.length === 0) {
      console.log("No users exist yet - run MemoryLane and complete first-run setup instead.");
    } else {
      console.log("Existing users:");
      for (const u of users) console.log(`  - ${u.username}`);
    }
    process.exitCode = 1;
    return;
  }

  const parsedPassword = passwordSchema.safeParse(newPassword);
  if (!parsedPassword.success) {
    console.error("New password must be 8-200 characters.");
    process.exitCode = 1;
    return;
  }

  const user = users.find((u) => u.username === username);
  if (!user) {
    console.error(`No user named "${username}". Existing users: ${users.map((u) => u.username).join(", ") || "(none)"}`);
    process.exitCode = 1;
    return;
  }

  const passwordHash = await hashPassword(parsedPassword.data);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, user.id);
  // Sign out every existing session for this user - if the password was
  // forgotten, any session claiming to already be logged in as them is
  // stale/untrusted and should re-authenticate with the new password.
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);

  console.log(`Password for "${username}" has been reset. All existing sessions for this user were signed out.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
