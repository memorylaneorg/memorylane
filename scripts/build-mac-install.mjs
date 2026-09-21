// One command for the whole macOS release: builds core, prepares and
// (optionally) signs AI Runtime's and Apple Photos' native binaries, builds
// and verifies the darwin-arm64 plugin catalog, builds MemoryLane.app +
// MemoryLane-arm64.dmg (package-macos.sh already stages, signs, notarizes
// and staples as part of producing the DMG - see README.md's "Building for
// production"), then signs a core update manifest against that exact DMG.
// Doesn't upload anything - see scripts/publish-release.mjs for that, run
// separately once you've checked the local build. Mirrors
// build-windows-install.mjs; see that file for the Windows equivalent.
//
// Signing is entirely env-driven, same as every other script in this
// pipeline: set SIGN_RELEASE=1 (and MACOS_SIGNING_IDENTITY,
// APPLE_NOTARY_KEYCHAIN_PROFILE for notarization) before running this for a
// signed, notarized DMG and a signed plugin catalog; leave it unset for a
// plain local/unsigned build. Nothing here decides that on its own.
import { execFileSync } from "node:child_process";
import path from "node:path";

if (process.platform !== "darwin") throw new Error("build-mac-install.mjs only runs on macOS (produces MemoryLane.app + a DMG via the macOS tray build)");
// Intel Mac is not currently a published release target. Refuse it here rather
// than quietly producing a catalog or DMG that the release layout does not use.
if (process.arch !== "arm64") throw new Error(`build-mac-install.mjs only runs on Apple Silicon (arm64) - this host is ${process.arch}, and Intel Mac is out of scope for now`);

const root = path.resolve(import.meta.dirname, "..");
const sign = process.env.SIGN_RELEASE === "1";

function run(command, args) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd: root, stdio: "inherit", shell: true });
}

console.log(sign ? "SIGN_RELEASE=1 - building a signed, notarized DMG and a signed plugin catalog." : "SIGN_RELEASE not set - building a plain, unsigned local DMG.");

run("npm", ["install"]);
run("npm", ["run", "build"]);

run("npm", ["run", "plugins:prepare-ai-runtime"]);
run("npm", ["run", "plugins:prepare-apple-photos"]);
if (sign) run("npm", ["run", "plugins:sign-native"]);
run("npm", ["run", "plugins:build", "--", "stable", "--platforms", "darwin-arm64"]);
run("npm", ["run", "plugins:verify", "--", "dist/plugin-repository/v1/stable/darwin-arm64"]);

// Stages the app, builds MemoryLane, signs everything and notarizes/staples
// the DMG under SIGN_RELEASE=1 (package-macos.sh already checks that env var
// itself - nothing extra to pass through here) - which it also copies to
// dist/installer/ (see package-macos.sh) for exactly this next step to pick up.
run("bash", ["tray-go/scripts/package-macos.sh"]);

// Same URL package-macos.sh compiles in as MEMORYLANE_UPDATE_FEED_URL's
// default, so the manifest generated here matches what a plain packaged
// build actually checks against without any extra configuration.
run("npm", ["run", "desktop:update-manifest", "--", "dist/installer/MemoryLane-arm64.dmg", "https://memorylaneapp.org/updates/darwin-arm64/MemoryLane-arm64.dmg", "dist/updates/darwin-arm64/manifest.json"]);

console.log("\nDone: tray-go/release/<version>/MemoryLane-arm64.dmg, dist/installer/MemoryLane-arm64.dmg, dist/updates/darwin-arm64/manifest.json");
console.log("Publish with: node scripts/publish-release.mjs catalog darwin-arm64  &&  node scripts/publish-release.mjs update darwin-arm64");
