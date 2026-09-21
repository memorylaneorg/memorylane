// Bumps the core version (package.json, server/package.json) and every
// plugin's own version (plugins/optional/*/manifest.template.json) together,
// to one new version number - for a coordinated release, not the
// independent-plugin-versioning path (plugins keep their own requiresCore
// range regardless of what core's version is - see the manifests' comments).
//
// Usage:
//   node scripts/bump-version.mjs patch   # 1.0.0 -> 1.0.1
//   node scripts/bump-version.mjs minor   # 1.0.0 -> 1.1.0
//   node scripts/bump-version.mjs major   # 1.0.0 -> 2.0.0
//   node scripts/bump-version.mjs 1.2.3   # set an exact version
//
// Only ever does a plain string replacement of the version value in each
// file - never a JSON.parse/stringify round trip - so nothing else about a
// file's formatting (line endings, key order, spacing) changes. package.json
// here is CRLF; the plugin manifests are LF single-line JSON; a reformat
// would make an otherwise one-line diff sprawl across the whole file.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const arg = process.argv[2];
const usage = "Usage: node scripts/bump-version.mjs <patch|minor|major|X.Y.Z>";
if (!arg) throw new Error(usage);

function parse(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`"${version}" isn't a plain X.Y.Z version`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

const rootPackagePath = path.join(root, "package.json");
const currentVersion = JSON.parse(fs.readFileSync(rootPackagePath, "utf8")).version;

const nextVersion = (() => {
  if (arg === "major" || arg === "minor" || arg === "patch") {
    const { major, minor, patch } = parse(currentVersion);
    if (arg === "major") return `${major + 1}.0.0`;
    if (arg === "minor") return `${major}.${minor + 1}.0`;
    return `${major}.${minor}.${patch + 1}`;
  }
  parse(arg); // throws on anything that isn't a plain X.Y.Z
  return arg;
})();

function setVersion(filePath, pattern) {
  const relative = path.relative(root, filePath);
  const text = fs.readFileSync(filePath, "utf8");
  const matches = [...text.matchAll(new RegExp(pattern, "g"))];
  if (matches.length !== 1) throw new Error(`${relative}: found ${matches.length} "version" field(s) matching the expected format, expected exactly 1`);
  const oldVersion = matches[0][0].match(/\d+\.\d+\.\d+/)[0];
  fs.writeFileSync(filePath, text.replace(pattern, (match) => match.replace(/\d+\.\d+\.\d+/, nextVersion)));
  console.log(`${relative}: ${oldVersion} -> ${nextVersion}`);
}

// package.json files: 2-space indented, `"version": "X.Y.Z"` with a space after the colon.
setVersion(rootPackagePath, /"version":\s*"\d+\.\d+\.\d+"/);
setVersion(path.join(root, "server", "package.json"), /"version":\s*"\d+\.\d+\.\d+"/);

// Plugin manifests: compact single-line JSON, `"version":"X.Y.Z"` with no space.
const pluginsDir = path.join(root, "plugins", "optional");
for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifestPath = path.join(pluginsDir, entry.name, "manifest.template.json");
  if (fs.existsSync(manifestPath)) setVersion(manifestPath, /"version":"\d+\.\d+\.\d+"/);
}

console.log(`\nDone. Rebuild before publishing: npm run build, then the usual plugins:build / desktop:installer / desktop:update-manifest sequence.`);
