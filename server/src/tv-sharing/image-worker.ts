import path from 'node:path';
import sharp from 'sharp';
import { sharpFromBmpFile } from '../media/thumbnail-generator.js';
// Do not retain a blocked source read after the owning core exits.
process.once('disconnect', () => process.kill(process.pid, 'SIGKILL'));
// A separate process lets the host terminate a stalled native/NAS read.
process.once('message', async (job: {
    source: string;
    width: number;
    height: number;
}) => {
    try {
        const input = path.extname(job.source).toLowerCase() === '.bmp'
            ? await sharpFromBmpFile(job.source) : sharp(job.source);
        const data = await input.rotate().resize({ width: job.width, height: job.height, fit: 'inside', withoutEnlargement: true })
            .toColourspace('srgb').jpeg({ quality: 85, progressive: false }).toBuffer();
        if (data.length > 16 * 1024 * 1024)
            throw Error('Image too large');
        process.send?.({ bytes: data.toString('base64') }, () => process.exit(0));
    }
    catch {
        process.send?.({ error: 'Could not convert photo' }, () => process.exit(1));
    }
});
