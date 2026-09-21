// Uploads MemoryLane's release artifacts to the live server, following the
// procedures in docs/plugin-repository-deployment.md exactly. Two
// independent modes - each takes the platform to publish:
//
//   node scripts/publish-release.mjs catalog <platform> [--channel stable]
//   node scripts/publish-release.mjs update  <platform> [--installer path] [--manifest path]
//
// "catalog" uploads dist/plugin-repository/v1/<channel>/<platform>/ (from
// `npm run plugins:build`). "update" uploads the installer + signed manifest
// (from `npm run desktop:installer` and `npm run desktop:update-manifest`)
// to the core-update feed.
//
// Both modes upload to a "*.next"/temporary path first and only make it
// live with a final remote rename, so a reader mid-download or mid-fetch
// never sees a half-uploaded file - the live path is only ever replaced
// atomically, never edited in place. "catalog" additionally keeps the
// previous live directory as "*.previous" for rollback (see
// docs/plugin-repository-deployment.md); "update" doesn't, since the
// installer's own filename isn't versioned (there's nothing separate to
// keep - see the comment above publishUpdate for why that's a known
// tradeoff, not an oversight).
//
// Uses `ssh` for the remote mkdir/rm/rename shell commands and `sftp` only
// for the actual file transfer - the SFTP protocol has no recursive
// delete/rename of its own (OpenSSH's sftp client's `rm` doesn't accept
// `-r`, confirmed against a real OpenSSH 9.9 client: it just errors
// "Invalid flag -r"), so the atomic-swap logic needs a real remote shell
// regardless.
//
// Needs OpenSSH-compatible `ssh`/`sftp` binaries on PATH (present by
// default on modern Windows, macOS, and Linux) and:
//   MEMORYLANE_DEPLOY_SSH_KEY   path to your .pem private key (required)
//   MEMORYLANE_DEPLOY_HOST      user@host (default: root@memorylaneapp.org -
//                                see docs/plugin-repository-deployment.md:
//                                no dedicated deploy user exists yet)
//   MEMORYLANE_DEPLOY_ROOT      remote web root (default: /var/www/memorylaneapp.org)
//
// This only transfers files - run `npm run plugins:verify` (catalog mode)
// on the local build first, the same separation the docs already draw
// between building/verifying and publishing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const mode = args[0];
const platform = args[1];
const valueAfter = (flag) => {
  const i = args.indexOf(flag);
  return i < 0 ? null : args[i + 1];
};
const usage = "Usage: node scripts/publish-release.mjs <catalog|update> <platform> [options]";
if (mode !== "catalog" && mode !== "update") throw new Error(usage);
if (!platform) throw new Error(usage);

const keyPath = process.env.MEMORYLANE_DEPLOY_SSH_KEY;
if (!keyPath) throw new Error("MEMORYLANE_DEPLOY_SSH_KEY must point to your .pem private key");
if (!fs.existsSync(keyPath)) throw new Error(`No such SSH key: ${keyPath}`);
const host = process.env.MEMORYLANE_DEPLOY_HOST ?? "root@memorylaneapp.org";
const remoteRoot = process.env.MEMORYLANE_DEPLOY_ROOT ?? "/var/www/memorylaneapp.org";

if (mode === "catalog") publishCatalog(); else publishUpdate();

function publishCatalog() {
  const channel = valueAfter("--channel") ?? "stable";
  const localDir = path.join(root, "dist", "plugin-repository", "v1", channel, platform);
  if (!fs.existsSync(path.join(localDir, "catalog.json"))) {
    throw new Error(`No built catalog at ${localDir} - run "npm run plugins:build -- ${channel} --platforms ${platform}" first`);
  }

  const remoteChannelDir = `${remoteRoot}/plugins/v1/${channel}`;
  const remoteLive = `${remoteChannelDir}/${platform}`;
  const remoteNext = `${remoteLive}.next`;
  const remotePrevious = `${remoteLive}.previous`;

  console.log(`Publishing ${channel}/${platform} from ${localDir}`);
  console.log(`  -> ${host}:${remoteLive}`);

  // Clears out any ".next" left behind by a previous interrupted attempt -
  // this directory always exists solely as this run's staging area.
  runSsh(`mkdir -p '${remoteChannelDir}' && rm -rf '${remoteNext}'`);
  runSftpPut([[localDir, remoteNext]]);
  // sftp's own `put -r` creates remote directories in a restrictive mode
  // (confirmed: 0700, owner-only) regardless of the uploading user's umask -
  // nginx (running as www-data) then gets a 403 trying to even traverse into
  // it, no matter how permissive the files inside are. Force it back to
  // world-readable before this ever goes live.
  runSsh(`chmod -R a+rX '${remoteNext}'`);
  // "mv live previous" only runs when something is actually live yet (a
  // first-ever deploy has nothing to preserve) - the exit code of the `[ -e ]`
  // test controls that without needing sftp's own error-tolerant "-" prefix.
  runSsh(`rm -rf '${remotePrevious}'; [ -e '${remoteLive}' ] && mv '${remoteLive}' '${remotePrevious}'; mv '${remoteNext}' '${remoteLive}'`);

  console.log(`Live at https://${hostname()}/plugins/v1/${channel}/${platform}/catalog.json`);
  console.log(`Rollback: ssh -i <key> ${host} "rm -rf '${remoteLive}' && mv '${remotePrevious}' '${remoteLive}'"`);
}

// The installer's remote filename isn't versioned (MemoryLane-Setup.exe, not
// MemoryLane-Setup-0.2.0.exe) - unlike the plugin catalog's immutable,
// per-version artifact files, a new release overwrites the previous
// installer outright, and there's no history to roll back to once that
// happens (only re-publishing an older signed manifest, which would then
// point at a binary that's gone). That matches the manifest this repo
// already generates (scripts/build-core-update-manifest.mjs bakes the
// unversioned URL in) - changing the scheme would mean regenerating and
// re-signing it. The one thing this script does guard against is a reader
// catching the file mid-overwrite: both the installer and the manifest are
// uploaded to a temporary path and only swapped into their live path with a
// remote rename, same technique as the catalog's ".next", so a concurrent
// download never sees a half-written file - installer first, then manifest,
// per docs/plugin-repository-deployment.md ("Publish the signed installer
// before its manifest").
function publishUpdate() {
  const defaultInstallerNames = { "win32-x64": "MemoryLane-Setup.exe", "darwin-arm64": "MemoryLane-arm64.dmg" };
  const defaultInstaller = defaultInstallerNames[platform] ? path.join(root, "dist", "installer", defaultInstallerNames[platform]) : null;
  const installerPath = valueAfter("--installer") ?? defaultInstaller;
  const manifestPath = valueAfter("--manifest") ?? path.join(root, "dist", "updates", platform, "manifest.json");
  if (!installerPath) throw new Error(`No default installer path for ${platform} - pass --installer explicitly`);
  if (!fs.existsSync(installerPath)) throw new Error(`No installer at ${installerPath}`);
  if (!fs.existsSync(manifestPath)) throw new Error(`No manifest at ${manifestPath} - run "npm run desktop:update-manifest" first`);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const installerDigest = createHash("sha256").update(fs.readFileSync(installerPath)).digest("hex");
  if (installerDigest !== manifest.sha256) {
    throw new Error(`${installerPath} does not match ${manifestPath}'s sha256 - regenerate the manifest with "npm run desktop:update-manifest" against this exact installer`);
  }

  // The manifest's own `url` is the one source of truth for where the
  // installer has to end up - deriving the remote path from it (rather than
  // just reusing the local filename) means a mismatch between the two is
  // impossible by construction.
  const manifestUrl = new URL(manifest.url);
  const remoteDir = `${remoteRoot}/updates/${platform}`;
  const remoteInstaller = `${remoteRoot}${manifestUrl.pathname}`;
  if (!remoteInstaller.startsWith(`${remoteDir}/`)) {
    throw new Error(`Manifest url ${manifest.url} doesn't live under ${remoteDir}/ - refusing to publish somewhere the manifest doesn't point at`);
  }
  const remoteManifest = `${remoteDir}/manifest.json`;

  console.log(`Publishing ${platform} core update ${manifest.version} from ${installerPath}`);
  console.log(`  -> ${host}:${remoteDir}`);

  runSsh(`mkdir -p '${remoteDir}' && rm -f '${remoteInstaller}.next' '${remoteManifest}.next'`);
  runSftpPut([[installerPath, `${remoteInstaller}.next`], [manifestPath, `${remoteManifest}.next`]]);
  runSsh(`mv '${remoteInstaller}.next' '${remoteInstaller}' && mv '${remoteManifest}.next' '${remoteManifest}'`);

  console.log(`Live at ${manifest.url}`);
  console.log(`Feed:   https://${hostname()}${manifestUrl.pathname.replace(/\/[^/]+$/, "/manifest.json")}`);
}

// Local paths get forward-slashed regardless of host OS - sftp's own batch
// command parser treats "\" as an escape character even inside quotes, so a
// literal Windows path silently loses its separators otherwise (confirmed:
// "C:\Users\...\win32-x64" arrived server-side as "C:UsersUsersWin32-x64",
// one non-existent path). Forward slashes work as local paths on Windows
// too, so this is safe on every platform this runs on.
function runSftpPut(pairs) {
  const commands = pairs.map(([local, remote]) => {
    const forwardSlashed = local.replaceAll("\\", "/");
    const recursive = fs.statSync(local).isDirectory() ? "-r " : "";
    return `put ${recursive}"${forwardSlashed}" "${remote}"`;
  });
  const batchFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "memorylane-deploy-")), "batch.sftp");
  fs.writeFileSync(batchFile, `${commands.join("\n")}\n`);
  try {
    execFileSync("sftp", ["-i", keyPath, "-b", batchFile, host], { cwd: root, stdio: "inherit" });
  } finally {
    fs.rmSync(path.dirname(batchFile), { recursive: true, force: true });
  }
}

function runSsh(remoteScript) {
  execFileSync("ssh", ["-i", keyPath, host, remoteScript], { stdio: "inherit" });
}

function hostname() {
  return host.split("@").pop();
}
