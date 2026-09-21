import fs from "node:fs";
import path from "node:path";
import { createHash, verify } from "node:crypto";
import extract from "extract-zip";
import { PluginCatalogSchema, PluginManifestSchema } from "../plugin-sdk/dist/index.js";

const root = process.cwd();
const repository = path.resolve(root, process.argv[2] ?? "dist/plugin-repository/v1/stable");
const configuredKey = process.env.MEMORYLANE_PLUGIN_PUBLIC_KEY;
const developmentKey = path.join(repository, "development-public-key.pem");
// Same literal value as server/src/plugin-platform/release-public-key.ts's
// PLUGIN_RELEASE_PUBLIC_KEY - duplicated rather than imported cross-workspace
// since it's public information anyway, not a secret. Falls back to it for a
// real (non-development) build, which never writes development-public-key.pem.
const realPublicKey = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA6fSlBqpHIuoB26XKwmc1lKkk4ouFJh381CrWIaQhgRM=\n-----END PUBLIC KEY-----\n";
const publicKey = configuredKey
  ? (configuredKey.includes("BEGIN PUBLIC KEY") ? configuredKey : fs.readFileSync(configuredKey, "utf8"))
  : fs.existsSync(developmentKey) ? fs.readFileSync(developmentKey, "utf8") : realPublicKey;
const catalogBytes = fs.readFileSync(path.join(repository, "catalog.json"));
const catalogSignature = fs.readFileSync(path.join(repository, "catalog.json.sig"), "utf8").trim();
if (!verify(null, catalogBytes, publicKey, Buffer.from(catalogSignature, "base64"))) throw new Error("Invalid catalog signature");
const catalog = PluginCatalogSchema.parse(JSON.parse(catalogBytes.toString("utf8")));
const releaseManifest = JSON.parse(fs.readFileSync(path.join(repository, "release-manifest.json"), "utf8"));
if (releaseManifest.formatVersion !== 1 || releaseManifest.channel !== catalog.channel || !Array.isArray(releaseManifest.files)) throw new Error("Invalid release manifest");
const actualPublished = files(repository).map((file) => path.relative(repository, file).replaceAll("\\", "/"))
  .filter((file) => file !== "release-manifest.json" && !file.startsWith(".verify-"));
const declaredPublished = releaseManifest.files.map((entry) => entry.path).sort();
if (JSON.stringify(actualPublished.sort()) !== JSON.stringify(declaredPublished)) throw new Error("Release manifest file list does not match the repository");
for (const expected of releaseManifest.files) {
  const file = resolveInside(repository, expected.path);
  const bytes = fs.readFileSync(file);
  if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) throw new Error(`Release manifest mismatch: ${expected.path}`);
}
for (const release of catalog.releases) {
  const artifactPath = resolveInside(repository, release.artifact.url);
  const bytes = fs.readFileSync(artifactPath);
  if (bytes.length !== release.artifact.size || sha256(bytes) !== release.artifact.sha256) throw new Error(`Artifact mismatch: ${release.artifact.url}`);
  if (!verify(null, Buffer.from(release.artifact.sha256, "hex"), publicKey, Buffer.from(release.artifact.signature, "base64"))) throw new Error(`Artifact signature mismatch: ${release.artifact.url}`);
  const temporary = fs.mkdtempSync(path.join(repository, ".verify-"));
  try {
    await extract(artifactPath, { dir: temporary, onEntry: (entry) => {
      const normalized = entry.fileName.replace(/\/$/, "");
      if (normalized && (normalized.includes("\\") || normalized.startsWith("/") || normalized.split("/").includes(".."))) throw new Error(`Unsafe archive path: ${entry.fileName}`);
      if (((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000) throw new Error(`Archive contains a symbolic link: ${entry.fileName}`);
    } });
    const embedded = PluginManifestSchema.parse(JSON.parse(fs.readFileSync(path.join(temporary, "manifest.json"), "utf8")));
    if (JSON.stringify(embedded) !== JSON.stringify(release.manifest)) throw new Error(`Embedded manifest mismatch: ${release.artifact.url}`);
    const installedBytes = files(temporary).reduce((sum, file) => sum + fs.statSync(file).size, 0);
    if (installedBytes !== release.artifact.installedSize) throw new Error(`Installed size mismatch: ${release.artifact.url}`);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
console.log(`Verified ${catalog.releases.length} artifact(s) in ${path.relative(root, repository)}`);

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function resolveInside(base, relative) {
  const resolved = path.resolve(base, ...relative.split("/"));
  if (!resolved.startsWith(path.resolve(base) + path.sep)) throw new Error(`Path escapes repository: ${relative}`);
  return resolved;
}
function files(directory, result = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name); if (entry.isDirectory()) files(item, result); else result.push(item);
  }
  return result;
}
