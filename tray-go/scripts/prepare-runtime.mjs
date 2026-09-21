// Assembles tray-go/runtime/ - the exact folder layout the Go supervisor
// expects beside the desktop executable. A copied
// node.exe running the server's own compiled dist/server.js works
// identically to a real Node install, with zero code changes - see the
// desktop-packaging investigation.
//
// Does a fresh production-only `npm install` into the runtime folder rather
// than copying the monorepo's root node_modules wholesale - that root tree
// carries every workspace's devDependencies too (vite, typescript, vitest,
// electron-forge itself, ...), which is both slow to copy (400+ packages)
// and wrong to ship. @memorylane/shared is a workspace-only package with no
// real npm registry entry, so it's assembled by hand alongside the install
// rather than fetched.
//
// Requires the root build to have already run (`npm run build` at the repo
// root) so server/dist, server/public, and shared/dist all exist.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = path.join(import.meta.dirname, "..", "..");
const runtimeDir = path.resolve(import.meta.dirname, "..", "runtime");

const serverDist = path.join(repoRoot, "server", "dist");
const serverPublic = path.join(repoRoot, "server", "public");
const sharedDist = path.join(repoRoot, "shared", "dist");
const pluginSdkDist = path.join(repoRoot, "plugin-sdk", "dist");
const serverPackageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "server", "package.json"), "utf8"));
const sharedPackageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "shared", "package.json"), "utf8"));
const pluginSdkPackageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "plugin-sdk", "package.json"), "utf8"));

if (!fs.existsSync(serverDist) || !fs.existsSync(serverPublic) || !fs.existsSync(sharedDist) || !fs.existsSync(pluginSdkDist)) {
  console.error('server/dist, server/public, shared/dist, or plugin-sdk/dist not found - run "npm run build" at the repo root first.');
  process.exit(1);
}

fs.rmSync(runtimeDir, { recursive: true, force: true });
fs.mkdirSync(runtimeDir, { recursive: true });

console.log("Copying server/dist...");
fs.cpSync(serverDist, path.join(runtimeDir, "dist"), { recursive: true });

console.log("Copying server/public...");
fs.cpSync(serverPublic, path.join(runtimeDir, "public"), { recursive: true });

// A minimal package.json listing only the server's real production
// dependencies (excluding the workspace-only @memorylane/shared, handled
// below) - `npm install` here pulls just what's actually needed, not the
// whole monorepo's tooling.
const { "@memorylane/shared": _workspaceOnly, "@memorylane/plugin-sdk": _pluginSdkWorkspace, ...externalDeps } = serverPackageJson.dependencies;
fs.writeFileSync(
  path.join(runtimeDir, "package.json"),
  JSON.stringify({ name: "memorylane-runtime", private: true, type: "module", dependencies: externalDeps }, null, 2),
);

console.log("Installing production dependencies...");
execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: runtimeDir, stdio: "inherit", shell: true });

// ffprobe-static ships a prebuilt binary for every platform/arch it supports
// (336 MB unpruned as of this writing) - only the one this runtime actually
// needs belongs in the packaged output. Same pruning that used to live in
// the now-removed prepare-required-plugins.mjs, back when video-tools was a
// separate plugin with its own node_modules.
const ffprobeBinDir = path.join(runtimeDir, "node_modules", "ffprobe-static", "bin");
if (fs.existsSync(ffprobeBinDir)) {
  const keep = path.join(ffprobeBinDir, process.platform, process.arch);
  if (!fs.existsSync(keep)) throw new Error(`ffprobe-static has no binary for ${process.platform}/${process.arch}`);
  for (const platformEntry of fs.readdirSync(ffprobeBinDir, { withFileTypes: true })) {
    if (!platformEntry.isDirectory()) continue;
    const platformPath = path.join(ffprobeBinDir, platformEntry.name);
    if (platformEntry.name !== process.platform) { fs.rmSync(platformPath, { recursive: true, force: true }); continue; }
    for (const archEntry of fs.readdirSync(platformPath, { withFileTypes: true })) {
      if (archEntry.isDirectory() && archEntry.name !== process.arch) fs.rmSync(path.join(platformPath, archEntry.name), { recursive: true, force: true });
    }
  }
  console.log(`Pruned ffprobe-static to ${process.platform}/${process.arch}`);
}

// Native addons in this tree (better-sqlite3, argon2, sharp) are
// prebuilt against the Visual C++ runtime (the MSVC toolchain - see the
// "-msvc" in lancedb's platform package name). LoadLibrary for one of these
// fails on any end-user machine that doesn't already have that
// redistributable installed system-wide, which most clean Windows installs
// won't - the exact "Cannot find native binding" crash this runtime hit
// after being copied to a second machine, even though the .node file itself
// was present and byte-for-byte intact (confirmed by inspecting it there:
// Node's Windows error text for "this file's own dependency is missing" is
// identical to "this file is missing", which is what made that look like a
// packaging bug at first).
//
// Rather than asking every end user to install the redistributable
// themselves, ship the specific runtime DLLs directly next to each native
// binary. Node's dlopen() on Windows uses LOAD_WITH_ALTERED_SEARCH_PATH, so
// a .node file's own directory is checked first for its dependencies - this
// is Microsoft's own documented "app-local" redistribution method:
// https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files
if (process.platform === "win32") {
  const vcRuntimeDlls = ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll"];
  const systemDir = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const dllSources = vcRuntimeDlls.map((name) => path.join(systemDir, name));
  const missingDlls = dllSources.filter((p) => !fs.existsSync(p));
  if (missingDlls.length > 0) {
    throw new Error(
      `Cannot bundle the VC++ runtime for end users - missing from this build machine: ${missingDlls.join(", ")}. ` +
      "Install the Visual C++ Redistributable (x64) on the build machine and retry: https://aka.ms/vs/17/release/vc_redist.x64.exe",
    );
  }

  function findNativeAddonDirs(dir, found = new Set()) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        findNativeAddonDirs(full, found);
      } else if (entry.isFile() && entry.name.endsWith(".node")) {
        found.add(dir);
      }
    }
    return found;
  }

  const nativeAddonDirs = findNativeAddonDirs(path.join(runtimeDir, "node_modules"));
  console.log(
    `Bundling VC++ runtime DLLs into ${nativeAddonDirs.size} native addon director${nativeAddonDirs.size === 1 ? "y" : "ies"}...`,
  );
  for (const dir of nativeAddonDirs) {
    for (const dllPath of dllSources) {
      fs.copyFileSync(dllPath, path.join(dir, path.basename(dllPath)));
    }
  }
}

console.log("Placing @memorylane/shared...");
const sharedTarget = path.join(runtimeDir, "node_modules", "@memorylane", "shared");
fs.mkdirSync(sharedTarget, { recursive: true });
fs.cpSync(sharedDist, path.join(sharedTarget, "dist"), { recursive: true });
fs.writeFileSync(
  path.join(sharedTarget, "package.json"),
  JSON.stringify({ name: "@memorylane/shared", version: sharedPackageJson.version, type: "module", main: "./dist/index.js" }, null, 2),
);

console.log("Placing @memorylane/plugin-sdk...");
const pluginSdkTarget = path.join(runtimeDir, "node_modules", "@memorylane", "plugin-sdk");
fs.mkdirSync(pluginSdkTarget, { recursive: true });
fs.cpSync(pluginSdkDist, path.join(pluginSdkTarget, "dist"), { recursive: true });
fs.writeFileSync(path.join(pluginSdkTarget, "package.json"), JSON.stringify({
  name: "@memorylane/plugin-sdk", version: pluginSdkPackageJson.version, type: "module", main: "./dist/index.js",
  exports: { ".": "./dist/index.js" }, dependencies: pluginSdkPackageJson.dependencies,
}, null, 2));

// A plain copy of the currently-running Node binary - no compilation, no
// bundling, just Node itself under a different name so end users never need
// their own Node install. See the desktop-packaging investigation for why
// this is simpler and more reliable than Node's SEA feature for this app.
const nodeBinName = process.platform === "win32" ? "node-runtime.exe" : "node-runtime";
console.log(`Copying node binary as ${nodeBinName}...`);
fs.copyFileSync(process.execPath, path.join(runtimeDir, nodeBinName));
if (process.platform !== "win32") {
  fs.chmodSync(path.join(runtimeDir, nodeBinName), 0o755);
}

console.log(`Runtime assembled at ${runtimeDir}`);
