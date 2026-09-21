import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const plugin = path.join(root, "plugins", "optional", "com.memorylane.ai-runtime");
const ai = path.join(plugin, "python");
const bin = path.join(plugin, "bin");
const venv = path.join(ai, ".venv");
const win = process.platform === "win32";
const python = path.join(venv, win ? "Scripts/python.exe" : "bin/python");
const minimumPython = [3, 11];

function probe(command, args = []) {
  const result = spawnSync(
    command,
    [...args, "-c", "import sys; print(sys.version_info[0], sys.version_info[1])"],
    { encoding: "utf8" },
  );
  if (result.status !== 0 || !result.stdout) return null;
  const [major, minor] = result.stdout.trim().split(" ").map(Number);
  return { command, args, major, minor };
}

function supported(candidate) {
  return candidate &&
    (candidate.major > minimumPython[0] ||
      (candidate.major === minimumPython[0] && candidate.minor >= minimumPython[1]));
}

function findPython() {
  const configured = process.env.PYTHON ? [[process.env.PYTHON, []]] : [];
  const candidates = win
    ? [["py", ["-3.13"]], ["py", ["-3.12"]], ["py", ["-3.11"]], ["py", ["-3"]], ["python", []], ["python3", []]]
    : [["python3.13", []], ["python3.12", []], ["python3.11", []], ["python3", []], ["python", []]];

  const found = [];
  for (const [command, args] of [...configured, ...candidates]) {
    const candidate = probe(command, args);
    if (!candidate) continue;
    found.push(`${command} ${candidate.major}.${candidate.minor}`);
    if (supported(candidate)) return candidate;
  }

  const details = found.length ? ` Found: ${found.join(", ")}.` : "";
  throw new Error(
    `Python ${minimumPython.join(".")}+ is required.${details}\n` +
      (win
        ? "Install it from python.org or run: winget install Python.Python.3.12"
        : "On macOS, run: brew install python@3.12"),
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
  execFileSync(selected.command, [...selected.args, "-m", "venv", venv], { stdio: "inherit" });
}

try {
  execFileSync(python, ["-c", "import PyInstaller, memorylane_ai"], { stdio: "ignore" });
} catch {
  // Older pip versions cannot perform PEP 660 editable installs from pyproject.toml.
  execFileSync(python, ["-m", "pip", "install", "--quiet", "--upgrade", "pip", "setuptools", "wheel"], { stdio: "inherit" });
  execFileSync(python, ["-m", "pip", "install", "--quiet", "-e", ai, "pyinstaller"], { stdio: "inherit" });
}

const work = path.join(root, "dist", "ai-runtime-build");
fs.rmSync(work, { recursive: true, force: true });
fs.rmSync(bin, { recursive: true, force: true });
fs.mkdirSync(bin, { recursive: true });
execFileSync(
  python,
  [
    "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile", "--name", "memorylane-ai",
    "--paths", ai, "--collect-all", "onnxruntime", "--collect-all", "tokenizers",
    "--collect-all", "huggingface_hub", "--distpath", bin, "--workpath", path.join(work, "work"),
    "--specpath", path.join(work, "spec"), path.join(ai, "pyinstaller_entry.py"),
  ],
  { cwd: ai, stdio: "inherit" },
);

const target = path.join(bin, win ? "memorylane-ai.exe" : "memorylane-ai");
if (!win) {
  fs.chmodSync(target, 0o755);
  // PyInstaller's one-file assembly can leave its ad-hoc Mach-O signature
  // invalid. macOS then kills the plugin before it can open its health port,
  // which the desktop app reports only as exit code 255. Give development
  // builds a valid ad-hoc signature; the release signing step replaces it
  // with the Developer ID signature later.
  if (process.platform === "darwin") {
    const entitlements = path.join(root, "plugins", "native-service-entitlements.plist");
    execFileSync("codesign", ["--force", "--sign", "-", "--entitlements", entitlements, target], { stdio: "inherit" });
    execFileSync("codesign", ["--verify", "--strict", "--verbose=2", target], { stdio: "inherit" });
  }
}
console.log(`Prepared AI Runtime plugin: ${(fs.statSync(target).size / 1024 / 1024).toFixed(1)} MiB`);
