import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

if (process.env.SIGN_RELEASE !== "1") throw new Error("SIGN_RELEASE=1 is required to sign plugin executables");
const root = path.resolve(import.meta.dirname, "..");
const plugins = path.join(root, "plugins");
// metadata-raw/video-tools used to be signed here too, back when they were
// separate required plugins - they're plain core dependencies now
// (server/node_modules), covered by the app's own code-signing step instead.
const nativeRoots = [path.join(plugins, "optional", "com.memorylane.ai-runtime"), path.join(plugins, "optional", "com.memorylane.apple-photos")]
  .filter((directory) => fs.existsSync(directory));
// src/python hold a plugin's own out-of-band source (build tooling, venvs,
// test caches - see plugins/optional/com.memorylane.ai-runtime/python/),
// never descended into - same reasoning, and the same directory names, as
// build-plugin-repository.mjs's PLUGIN_SOURCE_DIR_NAMES.
const SOURCE_DIR_NAMES = ["src", "python"];
const files = nativeRoots.flatMap((directory) => walk(directory));
if (process.platform === "win32") {
  const signer = path.join(root, "tray-go", "scripts", "sign-app-windows.ps1");
  const targets = files.filter((file) => file.toLowerCase().endsWith(".exe"));
  if (!targets.length) throw new Error("No Windows plugin executables found");
  for (const target of targets) execFileSync("powershell.exe", ["-ExecutionPolicy", "Bypass", "-File", signer, target], { stdio: "inherit" });
} else if (process.platform === "darwin") {
  const identity = process.env.MACOS_SIGNING_IDENTITY;
  const entitlements = path.join(plugins, "native-service-entitlements.plist");
  if (!identity) throw new Error("MACOS_SIGNING_IDENTITY is required");
  const targets = files.filter((file) => file.endsWith(".dylib") || file.endsWith(".node") || (fs.statSync(file).mode & 0o111) !== 0);
  if (!targets.length) throw new Error("No macOS plugin executables found");
  for (const target of targets) {
    execFileSync("codesign", ["--force", "--options", "runtime", "--timestamp", "--entitlements", entitlements, "--sign", identity, target], { stdio: "inherit" });
    execFileSync("codesign", ["--verify", "--strict", "--verbose=2", target], { stdio: "inherit" });
  }
} else throw new Error("Release plugin signing is supported only on Windows and macOS");
fs.writeFileSync(path.join(plugins, `.signed-${process.platform}-${process.arch}`), `${JSON.stringify({
  signedAt: new Date().toISOString(),
  files: files
    .filter((file) => process.platform === "win32"
      ? file.toLowerCase().endsWith(".exe")
      : file.endsWith(".dylib") || file.endsWith(".node") || (fs.statSync(file).mode & 0o111) !== 0)
    .map((file) => ({
      path: path.relative(root, file).replaceAll("\\", "/"),
      sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
    })),
}, null, 2)}\n`);

function walk(directory, out = []) { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { if(entry.isDirectory() && SOURCE_DIR_NAMES.includes(entry.name)) continue; const item=path.join(directory,entry.name); if(entry.isDirectory()) walk(item,out); else out.push(item); } return out; }
