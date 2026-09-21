import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

if (process.platform !== "darwin") {
  console.log("Apple Photos plugin is macOS-only; skipping on this host.");
  process.exit(0);
}

const root = path.resolve(import.meta.dirname, "..");
const plugin = path.join(root, "plugins", "optional", "com.memorylane.apple-photos");
const source = path.join(plugin, "python");
const bin = path.join(plugin, "bin");
const venv = path.join(root, "dist", "apple-photos-venv");
const python = path.join(venv, "bin", "python");
const minimumPython = [3, 11];

function probe(command) {
  const result = spawnSync(
    command,
    ["-c", "import sys; print(sys.version_info[0], sys.version_info[1])"],
    { encoding: "utf8" },
  );
  if (result.status !== 0 || !result.stdout) return null;
  const [major, minor] = result.stdout.trim().split(" ").map(Number);
  return { command, major, minor };
}

function supported(candidate) {
  return candidate &&
    (candidate.major > minimumPython[0] ||
      (candidate.major === minimumPython[0] && candidate.minor >= minimumPython[1]));
}

function findPython() {
  const candidates = [
    process.env.PYTHON,
    "python3.13",
    "python3.12",
    "python3.11",
    "python3",
    "python",
  ].filter(Boolean);
  const found = [];
  for (const command of candidates) {
    const candidate = probe(command);
    if (!candidate) continue;
    found.push(`${command} ${candidate.major}.${candidate.minor}`);
    if (supported(candidate)) return candidate;
  }
  const details = found.length ? ` Found: ${found.join(", ")}.` : "";
  throw new Error(
    `Python ${minimumPython.join(".")}+ is required.${details}\n` +
      "On macOS, run: brew install python@3.12",
  );
}

const existing = fs.existsSync(python) ? probe(python) : null;
if (existing && !supported(existing)) {
  console.log(`Replacing Python ${existing.major}.${existing.minor} virtual environment; Python 3.11+ is required.`);
  fs.rmSync(venv, { recursive: true, force: true });
}

if (!fs.existsSync(python)) {
  const selected = findPython();
  console.log(`Creating virtual environment with Python ${selected.major}.${selected.minor}...`);
  execFileSync(selected.command, ["-m", "venv", venv], { stdio: "inherit" });
}

execFileSync(
  python,
  ["-m", "pip", "install", "--quiet", "--upgrade", "pip", "setuptools", "wheel"],
  { stdio: "inherit" },
);
execFileSync(
  python,
  ["-m", "pip", "install", "--quiet", "-r", path.join(source, "requirements.txt"), "pyinstaller"],
  { stdio: "inherit" },
);

fs.rmSync(bin, { recursive: true, force: true });
fs.mkdirSync(bin, { recursive: true });
const work = path.join(root, "dist", "apple-photos-build");
execFileSync(
  python,
  [
    "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile",
    "--name", "memorylane-apple-photos", "--paths", source,
    "--collect-all", "osxphotos", "--collect-all", "utitools", "--collect-all", "photoscript",
    "--collect-all", "osxmetadata", "--collect-all", "bitstring", "--distpath", bin,
    "--workpath", work, "--specpath", work, path.join(plugin, "src", "entry.py"),
  ],
  { stdio: "inherit" },
);
const target = path.join(bin, "memorylane-apple-photos");
fs.chmodSync(target, 0o755);
// See prepare-ai-runtime-plugin.mjs: ensure the PyInstaller output can run in
// local builds. Release signing replaces this ad-hoc signature afterward.
const entitlements = path.join(root, "plugins", "native-service-entitlements.plist");
execFileSync("codesign", ["--force", "--sign", "-", "--entitlements", entitlements, target], { stdio: "inherit" });
execFileSync("codesign", ["--verify", "--strict", "--verbose=2", target], { stdio: "inherit" });
