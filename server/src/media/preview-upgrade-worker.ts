import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import pino from 'pino';
import { checkExifToolAvailable, extractLargestEmbeddedPreview, shutdownExifTool } from './exiftool-client.js';
import { generatePreviewFromBuffer } from './thumbnail-generator.js';
process.once('disconnect', () => process.exit(1));
process.once('message', async (job: {source: string; destination: string; orientation: number | null; width: number; height: number}) => {
  const decoded = job.destination + '.decoded.jpg';
  let sourceReadable = false;
  try {
    await fs.access(job.source, fs.constants.R_OK);
    sourceReadable = true;
    await checkExifToolAvailable(pino({ level: 'silent' }));
    const embedded = await extractLargestEmbeddedPreview(job.source);
    let area = 0;
    let sufficient = false;
    if (embedded) {
      await generatePreviewFromBuffer(embedded, job.destination, job.orientation);
      const m = await sharp(job.destination).metadata();
      area = (m.width ?? 0) * (m.height ?? 0);
      sufficient = (m.width ?? 0) >= job.width && (m.height ?? 0) >= job.height;
    }
    if (!sufficient) {
      try {
        // Use native decoder support without adding a redistributed runtime.
        // macOS ImageIO supports camera RAW through sips; other platforms use
        // formats supported by the installed Sharp/libvips build.
        if (process.platform === 'darwin') {
          await promisify(execFile)('/usr/bin/sips', ['-s', 'format', 'jpeg', job.source, '--out', decoded], { timeout: 45000, maxBuffer: 1024 * 1024 });
        } else {
          await sharp(job.source).rotate().jpeg({ quality: 90 }).toFile(decoded);
        }
        // Normalize decoder-provided orientation and remove embedded metadata.
        const normalized = await sharp(decoded).rotate().jpeg({ quality: 90 }).toBuffer();
        await fs.writeFile(decoded, normalized);
        const m = await sharp(decoded).metadata();
        const nextArea = (m.width ?? 0) * (m.height ?? 0);
        if (nextArea > area) {
          await fs.rename(decoded, job.destination);
          area = nextArea;
          sufficient = (m.width ?? 0) >= job.width && (m.height ?? 0) >= job.height;
        }
      } catch { /* Keep the best embedded preview when native decoding is unavailable. */ }
    }
    if (!area) throw Error('No usable preview');
    process.send?.({ state: sufficient ? 'ready' : 'limited' });
  } catch (error) { process.send?.({ state: 'failed', errorCode: sourceReadable ? 'decode' : 'source', errorMessage: (error instanceof Error ? error.message : String(error)).slice(0, 1000) }); }
  finally { await fs.rm(decoded, { force: true }).catch(() => {}); await shutdownExifTool(); process.exit(0); }
});
