import fs from 'node:fs/promises';
import sharp from 'sharp';
import { expect, it, vi } from 'vitest';
import { createTestApp } from '../helpers/app.js';
import { seedFolder, seedMedia, seedScanRoot } from '../helpers/db.js';
import { previewPathForMediaId } from '../../src/config/paths.js';
import { PreviewUpgrades, previewTarget } from '../../src/media/preview-upgrades.js';
import { generatePreviewFromBuffer } from '../../src/media/thumbnail-generator.js';
import { TvSettingsSchema } from '../../src/tv-sharing/broker.js';
import type { MediaRow } from '../../src/api/mappers.js';

it('preserves native preview pixels and orientation, and preserves explicit TV settings', async () => {
  const t = await createTestApp();
  try {
    const destination = previewPathForMediaId(t.ctx.paths.previewsDir, 1);
    const input = await sharp({create:{width:2400,height:1600,channels:3,background:'red'}}).jpeg().toBuffer();
    await generatePreviewFromBuffer(input,destination,6);
    expect(await sharp(destination).metadata()).toMatchObject({width:1600,height:2400});
    expect(previewTarget(6000,4000,6)).toEqual({width:1440,height:2160});
    expect(TvSettingsSchema.parse({})).toMatchObject({quality:'4k',cacheMiB:2048});
    expect(TvSettingsSchema.parse({quality:'1080p',cacheMiB:1024})).toMatchObject({quality:'1080p',cacheMiB:1024});
  } finally { await t.close(); }
});

it('retains the existing preview on failure, retries, and invalidates derivatives only after replacement', async () => {
  const t = await createTestApp();
  await t.ctx.previewUpgrades!.close();
  let fail = true;
  const render = vi.fn(async (job: {destination:string}) => {
    if (fail) throw Error('decoder failed');
    await sharp({create:{width:3000,height:2250,channels:3,background:'blue'}}).jpeg().toFile(job.destination);
    return 'ready' as const;
  });
  const queue = new PreviewUpgrades(t.db,t.ctx.paths,render);
  try {
    const root=seedScanRoot(t.db), folder=seedFolder(t.db,root,'/library');
    const id=seedMedia(t.db,folder,root,{media_type:'raw',filename:'test.nef'});
    t.db.prepare('UPDATE media SET width=4000,height=3000 WHERE id=?').run(id);
    const row=t.db.prepare('SELECT * FROM media WHERE id=?').get(id) as MediaRow;
    const dest=previewPathForMediaId(t.ctx.paths.previewsDir,id);
    await generatePreviewFromBuffer(await sharp({create:{width:800,height:600,channels:3,background:'red'}}).jpeg().toBuffer(),dest);
    queue.enqueue(row); queue.enqueue(row);
    await vi.waitFor(()=>expect(queue.status(id)).toBe('failed'),{timeout:5000});
    expect(await sharp(dest).metadata()).toMatchObject({width:800,height:600});
    expect(render).toHaveBeenCalledTimes(1);
    fail=false; queue.enqueue(row,true);
    await vi.waitFor(()=>expect(queue.status(id)).toBe('ready'),{timeout:5000});
    expect(await sharp(dest).metadata()).toMatchObject({width:3000,height:2250});
    expect((t.db.prepare('SELECT thumbnail_version FROM media WHERE id=?').get(id) as any).thumbnail_version).toBe(row.thumbnail_version+1);
    const storage=await t.app.inject({url:'/api/settings/storage',headers:{cookie:t.cookie}});
    expect(storage.json().previewsBytes).toBeGreaterThan(0);
    expect(storage.json().tvCacheBytes).toBe(0);
  } finally { await queue.close(); await t.close(); }
});

it('drops disabled-root work, refreshes queued fingerprints and retries a concurrent thumbnail change', async () => {
  const t=await createTestApp(); await t.ctx.previewUpgrades!.close();
  let id=0, calls=0;
  const queue=new PreviewUpgrades(t.db,t.ctx.paths,async job=>{
    calls++;
    await sharp({create:{width:3000,height:2250,channels:3,background:'blue'}}).jpeg().toFile(job.destination);
    if(calls===1) t.db.prepare('UPDATE media SET thumbnail_version=thumbnail_version+1 WHERE id=?').run(id);
    return 'ready';
  });
  try {
    const root=seedScanRoot(t.db,'/old'),folder=seedFolder(t.db,root,'/old');
    const old=seedMedia(t.db,folder,root,{media_type:'raw'});
    queue.enqueue(t.db.prepare('SELECT * FROM media WHERE id=?').get(old) as MediaRow);
    t.db.prepare('UPDATE scan_roots SET enabled=0 WHERE id=?').run(root);
    const root2=seedScanRoot(t.db,'/new'),folder2=seedFolder(t.db,root2,'/new');
    id=seedMedia(t.db,folder2,root2,{media_type:'raw'});
    t.db.prepare('UPDATE media SET width=4000,height=3000 WHERE id=?').run(id);
    queue.enqueue(t.db.prepare('SELECT * FROM media WHERE id=?').get(id) as MediaRow);
    expect(queue.status(old)).toBeNull();
    t.db.prepare('UPDATE media SET file_size=2000 WHERE id=?').run(id);
    await vi.waitFor(()=>expect(queue.status(id)).toBe('ready'),{timeout:6000});
    expect(calls).toBe(2);
    expect(queue.summary().running).toBe(0);
  } finally {await queue.close();await t.close();}
});
