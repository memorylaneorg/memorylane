import fs from "node:fs";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";

const root = path.resolve(import.meta.dirname, "..");
const privatePath = path.join(root, ".keys", "plugin-release-private.pem");
const publicModule = path.join(root, "server", "src", "plugin-platform", "release-public-key.ts");
const publicPath = path.join(root, "server", "config", "plugin-release-public-key.pem");
if (fs.existsSync(privatePath) || fs.existsSync(publicModule) || fs.existsSync(publicPath)) throw new Error("Refusing to replace an existing plugin signing key");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
const publicPem = publicKey.export({ type: "spki", format: "pem" });
fs.mkdirSync(path.dirname(privatePath), { recursive: true });
fs.writeFileSync(privatePath, privatePem, { mode: 0o600 });
fs.mkdirSync(path.dirname(publicPath), { recursive: true });
fs.writeFileSync(publicPath, publicPem);
fs.writeFileSync(publicModule, `// Public half of the MemoryLane plugin release key. Safe to distribute.\nexport const PLUGIN_RELEASE_PUBLIC_KEY = ${JSON.stringify(publicPem)};\n`);
console.log(`Created private key at ${path.relative(root, privatePath)} (gitignored), public PEM, and embedded public key module.`);
