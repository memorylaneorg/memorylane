#!/usr/bin/env node
// One-command launcher for the memorylane-ai sidecar: finds a Python >= 3.11,
// creates its .venv if missing, installs the package when needed, then runs
// it with your environment (MEMORYLANE_AI_* variables pass through).
// Cross-platform so `npm run ai` works the same on macOS, Windows and Linux.
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Lives inside the plugin it backs (plugins/optional/com.memorylane.ai-runtime/python/)
// rather than at the repo root - see build-plugin-repository.mjs's packaging
// filter, which already excludes a plugin's own src/ or python/ subdirectory
// from what ships, same convention every plugin's source follows.
const aiDir = path.join(root, "plugins", "optional", "com.memorylane.ai-runtime", "python");
const venv = path.join(aiDir, ".venv");
const win = process.platform === "win32";
const binDir = path.join(venv, win ? "Scripts" : "bin");
const pip = path.join(binDir, win ? "pip.exe" : "pip");
const entry = path.join(binDir, win ? "memorylane-ai.exe" : "memorylane-ai");
const stamp = path.join(venv, ".installed-for");
const MIN = [3, 11];

function log(msg) {
  console.log(`[memorylane-ai] ${msg}`);
}

function probe(cmd, args) {
  const r = spawnSync(cmd, [...args, "-c", "import sys; print(sys.version_info[0], sys.version_info[1])"], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return null;
  const [major, minor] = r.stdout.trim().split(" ").map(Number);
  return { cmd, args, major, minor };
}

// Candidates in order of preference; the first that is >= 3.11 wins.
function findPython() {
  const candidates = win
    ? [["py", ["-3.13"]], ["py", ["-3.12"]], ["py", ["-3.11"]], ["py", ["-3"]], ["python", []], ["python3", []]]
    : [["python3.13", []], ["python3.12", []], ["python3.11", []], ["python3", []], ["python", []]];
  const seen = [];
  for (const [cmd, args] of candidates) {
    const p = probe(cmd, args);
    if (!p) continue;
    seen.push(`${cmd} ${args.join(" ")} = ${p.major}.${p.minor}`.trim());
    if (p.major > MIN[0] || (p.major === MIN[0] && p.minor >= MIN[1])) return p;
  }
  console.error(`[memorylane-ai] No Python ${MIN.join(".")}+ found.${seen.length ? ` Found: ${seen.join(", ")}.` : ""}`);
  console.error(win ? "  Install from python.org or `winget install Python.Python.3.12`." : "  Install with `brew install python@3.12` (macOS) or your package manager.");
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: aiDir, ...opts });
  if (r.status !== 0) {
    console.error(`[memorylane-ai] ${cmd} ${args.join(" ")} failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

if (!fs.existsSync(path.join(aiDir, "pyproject.toml"))) {
  console.error(`[memorylane-ai] Python source not found at ${aiDir}`);
  process.exit(1);
}

if (!fs.existsSync(entry)) {
  const py = findPython();
  log(`Creating virtual environment with ${py.cmd} ${py.args.join(" ")} (Python ${py.major}.${py.minor})...`);
  run(py.cmd, [...py.args, "-m", "venv", venv]);
}

// Reinstall when pyproject.toml changed since the last install.
const pyproject = fs.statSync(path.join(aiDir, "pyproject.toml")).mtimeMs;
const installedFor = fs.existsSync(stamp) ? Number(fs.readFileSync(stamp, "utf8")) : 0;
if (!fs.existsSync(entry) || installedFor < pyproject) {
  log("Installing dependencies (first run only; the models download on first use)...");
  run(pip, ["install", "--quiet", "--upgrade", "pip"]);
  run(pip, ["install", "--quiet", "-e", ".[dev]"]);
  fs.writeFileSync(stamp, String(pyproject));
}

const port = process.env.MEMORYLANE_AI_PORT ?? "4281";
log(`Starting on http://${process.env.MEMORYLANE_AI_HOST ?? "127.0.0.1"}:${port} (Ctrl+C to stop)`);
const child = spawn(entry, [], { stdio: "inherit", cwd: aiDir, env: process.env });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));
