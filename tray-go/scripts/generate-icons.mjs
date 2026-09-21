import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const assets = path.join(repoRoot, "tray-go/assets");
const publicDir = path.join(repoRoot, "client/public");
const master = path.join(assets, "icon-1024.png");

async function png(size) {
  return sharp(master).resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
}

function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, index) => {
    const at = 6 + index * 16;
    header[at] = size === 256 ? 0 : size; header[at + 1] = size === 256 ? 0 : size;
    header[at + 2] = 0; header[at + 3] = 0;
    header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(data.length, at + 8); header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.data)]);
}

function icns(images) {
  const chunks = images.map(({ type, data }) => {
    const header = Buffer.alloc(8); header.write(type, 0, 4, "ascii"); header.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([header, data]);
  });
  const header = Buffer.alloc(8); header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}

const sizes = [16, 24, 32, 48, 64, 128, 180, 256, 512, 1024];
const rendered = new Map(await Promise.all(sizes.map(async (size) => [size, await png(size)])));
await Promise.all([
  fs.writeFile(path.join(publicDir, "icon-32.png"), rendered.get(32)),
  fs.writeFile(path.join(publicDir, "apple-touch-icon.png"), rendered.get(180)),
  fs.writeFile(path.join(assets, "icon-32.png"), rendered.get(32)),
  fs.writeFile(path.join(assets, "icon-256.png"), rendered.get(256)),
]);

const icoSizes = [16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: rendered.get(size) }));
const icoData = ico(icoSizes);
await Promise.all([
  fs.writeFile(path.join(publicDir, "favicon.ico"), icoData),
  fs.writeFile(path.join(assets, "icon.ico"), icoData),
]);

const icnsTypes = [["icp4", 16], ["icp5", 32], ["icp6", 64], ["ic07", 128], ["ic08", 256], ["ic09", 512], ["ic10", 1024]];
await fs.writeFile(path.join(assets, "icon.icns"), icns(icnsTypes.map(([type, size]) => ({ type, data: rendered.get(size) }))));

const traySize = 36;
const trayAlpha = await sharp(master)
  .resize(traySize, traySize, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .ensureAlpha().extractChannel("alpha").threshold(80).png().toBuffer();
const trayPng = await sharp({ create: { width: traySize, height: traySize, channels: 3, background: "black" } })
  .joinChannel(trayAlpha).png().toBuffer();
await fs.writeFile(path.join(assets, "trayTemplate.png"), trayPng);

await fs.writeFile(path.join(assets, "trayTemplate.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">
  <mask id="icon" mask-type="alpha"><image href="icon-1024.png" x="0" y="0" width="36" height="36" preserveAspectRatio="xMidYMid meet"/></mask>
  <rect width="36" height="36" fill="#000" mask="url(#icon)"/>
</svg>\n`);

console.log("Generated web, Windows, macOS, and tray icons from tray-go/assets/icon-1024.png");
