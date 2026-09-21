import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const releaseRoot = path.resolve(root, process.argv[2] ?? "tray-go/release");
// exiftool-vendored/ffmpeg-static/ffprobe-static are core dependencies now
// (server/node_modules), not a separately-bundled required plugin - same
// binaries as before the fold-into-core migration, just packaged differently,
// so the installer's real size hasn't moved much (~120 MiB zipped as of this
// writing). These defaults keep some headroom above that for future growth.
const warningMiB = Number(process.env.MEMORYLANE_SIZE_WARNING_MIB ?? 200);
const limitMiB = Number(process.env.MEMORYLANE_SIZE_LIMIT_MIB ?? 220);

function bytesIn(target) {
  if (!fs.existsSync(target)) return 0;
  const stat = fs.statSync(target);
  if (stat.isFile()) return stat.size;
  return fs.readdirSync(target, { withFileTypes: true }).reduce((sum, entry) =>
    sum + bytesIn(path.join(target, entry.name)), 0);
}

function filesUnder(target, result = []) {
  if (!fs.existsSync(target)) return result;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const item = path.join(target, entry.name);
    if (entry.isDirectory()) filesUnder(item, result);
    else result.push({ path: path.relative(root, item).replaceAll("\\", "/"), bytes: fs.statSync(item).size });
  }
  return result;
}

const files = filesUnder(releaseRoot);
const installers = files.filter(({ path: value }) => /(?:Setup\.exe|\.dmg|\.msi|\.pkg|MemoryLane-[^/]+\.zip)$/i.test(value));
const largest = [...files].sort((a, b) => b.bytes - a.bytes).slice(0, 25);
const runtimeDirs = [...new Set(files.map(({ path: value }) => {
  const match = value.match(/^(.*?(?:resources\/runtime|MemoryLane-[^/]+\/runtime))(?:\/|$)/);
  return match ? path.resolve(root, match[1]) : null;
}).filter(Boolean))];
const report = {
  generatedAt: new Date().toISOString(),
  releaseRoot: path.relative(root, releaseRoot).replaceAll("\\", "/"),
  warningBytes: warningMiB * 1024 * 1024,
  limitBytes: limitMiB * 1024 * 1024,
  installers: installers.map((item) => ({ ...item, status: item.bytes > limitMiB * 1024 * 1024 ? "fail" : item.bytes > warningMiB * 1024 * 1024 ? "warn" : "pass" })),
  unpackedBytes: bytesIn(releaseRoot),
  runtimeBytes: runtimeDirs.reduce((sum, directory) => sum + bytesIn(directory), 0),
  largestFiles: largest,
};

if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`Release: ${report.releaseRoot}`);
  for (const item of report.installers) console.log(`${item.status.toUpperCase().padEnd(4)} ${(item.bytes / 1024 / 1024).toFixed(1).padStart(7)} MiB  ${item.path}`);
  console.log(`Unpacked release tree: ${(report.unpackedBytes / 1024 / 1024).toFixed(1)} MiB`);
  console.log(`Runtime copies: ${(report.runtimeBytes / 1024 / 1024).toFixed(1)} MiB`);
  console.log("Largest files:");
  for (const item of largest) console.log(`${(item.bytes / 1024 / 1024).toFixed(1).padStart(7)} MiB  ${item.path}`);
}

if (process.argv.includes("--enforce") && report.installers.some((item) => item.status === "fail")) process.exitCode = 1;
