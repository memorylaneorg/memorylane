import fs from "node:fs";
import path from "node:path";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import yazl from "yazl";
import { PluginCatalogSchema, PluginManifestSchema, PLUGIN_PLATFORMS } from "../plugin-sdk/dist/index.js";

const root = path.resolve(import.meta.dirname, "..");
// Directories holding a plugin's own out-of-band source (build tooling,
// venvs, test caches - see plugins/optional/com.memorylane.ai-runtime/python/)
// rather than shipped content - never descended into by either the plugin
// discovery walk or the packaging walk below.
const PLUGIN_SOURCE_DIR_NAMES = ["src", "python"];
// darwin-x64 stays a valid PLUGIN_PLATFORMS value (schema-wise) but isn't a
// supported release target for now. win32-x64/darwin-arm64 are, but only
// the one matching the machine actually running this - a plain
// `plugins:build` with no --platforms builds this host's own platform, not
// every supported platform, so running it on Windows never reaches into
// darwin-arm64 territory (harmless today since only pure-JS module plugins
// would land there, but it broke the "each platform is built and uploaded
// from its own machine, independently" model the per-platform catalog split
// is for). Pass --platforms explicitly to build a different one anyway.
const supportedReleasePlatforms = ["win32-x64", "darwin-arm64"];
const hostPlatform = `${process.platform}-${process.arch}`;
const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const assigned = args.find((item) => item.startsWith(`${flag}=`));
  if (assigned) return assigned.slice(flag.length + 1);
  const i = args.indexOf(flag); return i < 0 ? null : args[i + 1];
};
const channel = valueAfter("--channel") ?? args.find((item) => item === "stable" || item === "beta") ?? "stable";
if (!new Set(["stable", "beta"]).has(channel)) throw new Error("--channel must be stable or beta");
const flaggedPlatforms = valueAfter("--platforms");
const positionalPlatforms = args
  .flatMap((item) => item.split(","))
  .filter((item) => PLUGIN_PLATFORMS.includes(item));
const platforms = flaggedPlatforms
  ? flaggedPlatforms.split(",")
  : positionalPlatforms.length > 0
    ? positionalPlatforms
    : supportedReleasePlatforms.includes(hostPlatform) ? [hostPlatform]
      : (() => { throw new Error(`No default release platform for this host (${hostPlatform}) - pass --platforms explicitly (supported: ${supportedReleasePlatforms.join(", ")})`); })();
for (const platform of platforms) if (!PLUGIN_PLATFORMS.includes(platform)) throw new Error(`Unsupported platform: ${platform}`);
const baseOutputDir = path.resolve(root, valueAfter("--output") ?? `dist/plugin-repository/v1/${channel}`);
const sourceRoot = path.resolve(root, valueAfter("--source") ?? "plugins");
const development = args.includes("--development") || valueAfter("--development") === "true" || args.includes("development");
if (!development && process.env.SIGN_RELEASE === "1") {
  const markerPath = path.join(root, "plugins", `.signed-${process.platform}-${process.arch}`);
  if (!fs.existsSync(markerPath)) throw new Error("Native plugin executables must be signed before a release repository build");
  let marker;
  try { marker = JSON.parse(fs.readFileSync(markerPath, "utf8")); }
  catch { throw new Error("Native plugin signing marker is stale; re-run plugins:sign-native before the release repository build"); }
  if (!Array.isArray(marker.files) || marker.files.length === 0) throw new Error("Native plugin signing marker contains no files");
  for (const signed of marker.files) {
    const file = path.resolve(root, ...signed.path.split("/"));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || sha256(fs.readFileSync(file)) !== signed.sha256) {
      throw new Error(`Native plugin changed after release signing: ${signed.path}. Re-run plugins:sign-native.`);
    }
  }
}
if (!baseOutputDir.startsWith(root + path.sep) || baseOutputDir === root) throw new Error("Plugin repository output must stay inside the workspace");

// Same default-location pattern as tray-go/scripts/prepare-runtime.mjs's
// bundled-required-plugins step: MEMORYLANE_PLUGIN_SIGNING_KEY always wins if
// set, otherwise fall back to the real key at its default repo location
// before finally requiring --development's throwaway keypair.
const defaultSigningKeyPath = path.join(root, ".keys", "plugin-release-private.pem");

function readSigningKey() {
  const configured = process.env.MEMORYLANE_PLUGIN_SIGNING_KEY;
  if (configured) return configured.includes("BEGIN PRIVATE KEY") ? configured : fs.readFileSync(configured, "utf8");
  if (fs.existsSync(defaultSigningKeyPath)) return fs.readFileSync(defaultSigningKeyPath, "utf8");
  if (!development) throw new Error(`MEMORYLANE_PLUGIN_SIGNING_KEY is required outside --development builds (no key found at ${defaultSigningKeyPath} either)`);
  return null;
}

const configuredPrivateKey = readSigningKey();

// One catalog per platform, each in its own subdirectory
// (dist/plugin-repository/v1/<channel>/<platform>/) rather than one catalog
// covering every platform. A native plugin's binary can only ever be built on
// its own target OS/arch (see the "host" handling below), so a release is
// naturally built and uploaded one platform at a time, on that platform's own
// machine - splitting the catalog itself the same way means each platform's
// release is a fully independent atomic upload (see docs/plugin-repository-deployment.md),
// with no merge step and no risk of one platform's upload silently dropping
// another's releases the way a single shared catalog.json would.
let totalReleases = 0;
for (const platform of platforms) {
  const outputDir = path.join(baseOutputDir, platform);
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });

  const privateKey = configuredPrivateKey ?? (() => {
    const pair = generateKeyPairSync("ed25519");
    fs.writeFileSync(path.join(outputDir, "development-public-key.pem"), pair.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
    return pair.privateKey;
  })();

  const releases = [];
  for (const pluginRoot of findPluginRoots(sourceRoot)) {
    const rawTemplate = JSON.parse(fs.readFileSync(path.join(pluginRoot, "manifest.template.json"), "utf8"));
    const { buildPlatforms = PLUGIN_PLATFORMS, ...template } = rawTemplate;
    // "host" means the native binary can only be built on the machine it runs
    // on (no cross-compiling a PyInstaller executable for another OS/arch), so
    // it never produces more than one artifact per build. Combined with an
    // explicit platform list (e.g. ["host", "darwin-arm64"]) it also restricts
    // *which* hosts are even eligible - bare ["host"] (no list) means any host
    // is fine (ai-runtime: genuinely built fresh on whatever machine runs this).
    // Without this, a plugin restricted to darwin only would still be attempted
    // (and, before the entry.executable check below existed, silently packaged
    // empty) when this script runs on Windows.
    const declaredPlatforms = buildPlatforms.filter((entry) => entry !== "host");
    const hostPlatform = `${process.platform}-${process.arch}`;
    const allowedPlatforms = buildPlatforms.includes("host")
      ? (declaredPlatforms.length === 0 || declaredPlatforms.includes(hostPlatform)) ? [hostPlatform] : []
      : buildPlatforms;
    if (!allowedPlatforms.includes(platform)) continue;
    const manifest = PluginManifestSchema.parse({ ...template, platform });
    // src/ and python/ hold a plugin's own out-of-band source (build tooling,
    // venvs, test caches, egg-info - see plugins/optional/com.memorylane.ai-runtime/python/)
    // rather than shipped content, so they're skipped during the walk itself,
    // not just filtered out afterward - descending into a Python .venv or
    // .pytest_cache can hit locked/permission-denied files that have no
    // business slowing down or breaking a plugin release build.
    const packageFiles = listFiles(pluginRoot, [], PLUGIN_SOURCE_DIR_NAMES).filter((file) => {
      return path.basename(file) !== "manifest.template.json" && !path.basename(file).startsWith(".signed-");
    });
    // A service plugin's native executable is built per-platform (prepare-*-plugin.mjs
    // runs natively on its target OS/arch and can't cross-compile) and just sits in the
    // plugin's own directory - nothing here verified it was actually there for the
    // platform being packaged. Building on the wrong host silently produced a
    // signed, published, installable artifact missing its own entry point (caught
    // when this shipped 700-byte "darwin-arm64" artifacts for a plugin only ever
    // built on Windows). Refuse instead of publishing a broken plugin.
    if (manifest.entry.kind === "service") {
      const relativeFiles = new Set(packageFiles.map((file) => path.relative(pluginRoot, file).replaceAll("\\", "/")));
      const executable = manifest.entry.executable;
      const candidates = platform.startsWith("win32") ? [executable, `${executable}.exe`] : [executable];
      if (!candidates.some((candidate) => relativeFiles.has(candidate))) {
        throw new Error(`${manifest.id} (${platform}): entry.executable "${executable}" not found in ${pluginRoot} - build the native binary for this platform first (see scripts/prepare-*-plugin.mjs)`);
      }
      if (platform.startsWith("darwin")) {
        const executablePath = path.join(pluginRoot, ...manifest.entry.executable.split("/"));
        try {
          execFileSync("codesign", ["--verify", "--strict", "--verbose=2", executablePath], { stdio: "pipe" });
        } catch (error) {
          const detail = error.stderr?.toString().trim();
          throw new Error(`${manifest.id} (${platform}): native executable has an invalid macOS signature${detail ? `: ${detail}` : ""}. Re-run its prepare step before packaging.`);
        }
      }
    }
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const installedSize = manifestBytes.length + packageFiles.reduce((sum, file) => sum + fs.statSync(file).size, 0);
    const artifactRelative = `artifacts/${manifest.id}/${manifest.version}/${platform}.mlplugin`;
    const artifactPath = path.join(outputDir, ...artifactRelative.split("/"));
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    await writeZip(artifactPath, [{ name: "manifest.json", bytes: manifestBytes }, ...packageFiles.map((file) => ({
      name: path.relative(pluginRoot, file).replaceAll("\\", "/"), file,
    }))]);
    const artifactBytes = fs.readFileSync(artifactPath);
    const digest = sha256(artifactBytes);
    releases.push({
      manifest,
      artifact: {
        url: artifactRelative,
        size: artifactBytes.length,
        installedSize,
        sha256: digest,
        signature: sign(null, Buffer.from(digest, "hex"), privateKey).toString("base64"),
      },
      releaseNotes: "Repository lifecycle fixture.",
      mandatory: false,
    });
  }

  const catalog = PluginCatalogSchema.parse({ formatVersion: 1, channel, generatedAt: new Date().toISOString(), revoked: [], releases });
  const catalogBytes = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, "catalog.json"), catalogBytes);
  fs.writeFileSync(path.join(outputDir, "catalog.json.sig"), `${sign(null, catalogBytes, privateKey).toString("base64")}\n`);
  const published = listFiles(outputDir).filter((file) => path.basename(file) !== "release-manifest.json").map((file) => ({
    path: path.relative(outputDir, file).replaceAll("\\", "/"), bytes: fs.statSync(file).size, sha256: sha256(fs.readFileSync(file)),
  }));
  fs.writeFileSync(path.join(outputDir, "release-manifest.json"), `${JSON.stringify({ formatVersion: 1, channel, files: published }, null, 2)}\n`);
  console.log(`Built ${releases.length} plugin artifact(s) for ${platform} in ${path.relative(root, outputDir)}`);
  totalReleases += releases.length;
}
if (totalReleases === 0) console.warn(`Warning: no plugin artifacts were built for any of [${platforms.join(", ")}] on this host.`);

function listFiles(directory, result = [], skipDirNames = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && skipDirNames.includes(entry.name)) continue;
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) listFiles(item, result, skipDirNames); else result.push(item);
  }
  return result.sort();
}

// `plugins/fixtures/` holds dev/test-only plugins (e.g. com.memorylane.fixture-module,
// used to exercise the plugin platform's own install/release machinery) - they
// have no business showing up as a real feature to an end user, so a real
// (non-development) catalog build skips that directory entirely. Only checked
// at the top level, so a plugin that happens to have its own subfolder named
// "fixtures" for unrelated reasons is unaffected.
function findPluginRoots(directory, result = [], includeFixtures = development, isRoot = true) {
  if (fs.existsSync(path.join(directory, "manifest.template.json"))) result.push(directory);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules" || PLUGIN_SOURCE_DIR_NAMES.includes(entry.name)) continue;
    if (isRoot && entry.name === "fixtures" && !includeFixtures) continue;
    findPluginRoots(path.join(directory, entry.name), result, includeFixtures, false);
  }
  return result.sort();
}
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function writeZip(destination, entries) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const output = fs.createWriteStream(destination, { flags: "wx" });
    output.once("error", reject); output.once("close", resolve); zip.outputStream.once("error", reject).pipe(output);
    const mtime = new Date("2000-01-01T00:00:00.000Z");
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.file) zip.addFile(entry.file, entry.name, { mtime, mode: fs.statSync(entry.file).mode });
      else zip.addBuffer(entry.bytes, entry.name, { mtime, mode: 0o100644 });
    }
    zip.end();
  });
}
