import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`package.json contains an invalid release version: ${version}`);
}

const tag = `v${version}`;
const message = `MemoryLane ${tag}`;
const dryRun = process.argv.includes("--dry-run");

function git(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  return result;
}

if (dryRun) {
  console.log(`git tag -a ${tag} -m "${message}"`);
  console.log(`git push origin ${tag}`);
  process.exit(0);
}

const status = git(["status", "--porcelain"], { capture: true });
if (status.status !== 0) process.exit(status.status ?? 1);
if (status.stdout.trim()) {
  throw new Error("Working tree is not clean. Commit your release changes before creating the tag.");
}

const existing = git(["rev-parse", "--quiet", "--verify", `refs/tags/${tag}`], { capture: true });
if (existing.status === 0) throw new Error(`Tag ${tag} already exists locally.`);

const tagged = git(["tag", "-a", tag, "-m", message]);
if (tagged.status !== 0) process.exit(tagged.status ?? 1);

const pushed = git(["push", "origin", tag]);
if (pushed.status !== 0) {
  console.error(`Push failed. The local ${tag} tag was created and has not been removed.`);
  process.exit(pushed.status ?? 1);
}

console.log(`Created and pushed ${tag}.`);
