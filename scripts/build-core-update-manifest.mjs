import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [artifactArg, url, outputArg] = process.argv.slice(2);
if (!artifactArg || !url || !outputArg) {
  console.error("Usage: node scripts/build-core-update-manifest.mjs <installer> <public-url> <output.json>");
  process.exit(1);
}
const root = path.resolve(import.meta.dirname, "..");
// Same key as the plugin catalog (see scripts/build-plugin-repository.mjs) -
// one first-party signing key for everything MemoryLane ships, core and
// plugins alike, rather than a second keypair to generate and guard.
const defaultSigningKeyPath = path.join(root, ".keys", "plugin-release-private.pem");
const configuredKey = process.env.MEMORYLANE_PLUGIN_SIGNING_KEY;
const privateKeyPem = configuredKey
  ? (configuredKey.includes("BEGIN PRIVATE KEY") ? configuredKey : fs.readFileSync(configuredKey, "utf8"))
  : fs.existsSync(defaultSigningKeyPath) ? fs.readFileSync(defaultSigningKeyPath, "utf8")
    : (() => { throw new Error(`MEMORYLANE_PLUGIN_SIGNING_KEY is required (no key found at ${defaultSigningKeyPath} either)`); })();
const artifact = path.resolve(artifactArg);
const output = path.resolve(outputArg);
const version = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const sha256 = crypto.createHash("sha256").update(fs.readFileSync(artifact)).digest("hex");
const message = `${version}\n${url}\n${sha256}`;
const signature = crypto.sign(null, Buffer.from(message), privateKeyPem).toString("base64");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify({ version, url, sha256, signature }, null, 2) + "\n");
console.log(`Wrote signed core update manifest to ${output}`);
