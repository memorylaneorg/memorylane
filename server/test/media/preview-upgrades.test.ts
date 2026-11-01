import fs from 'node:fs/promises';
import sharp from 'sharp';
import { expect, it, vi } from 'vitest';
import { createTestApp } from '../helpers/app.js';
import { seedFolder, seedMedia, seedScanRoot } from '../helpers/db.js';
import { previewPathForMediaId } from '../../src/config/paths.js';
import { PreviewUpgrades, previewTarget, suggestedPreviewMiB } from '../../src/media/preview-upgrades.js';
import { generatePreviewFromBuffer } from '../../src/media/thumbnail-generator.js';
import { TvSettingsSchema, TvSharingBroker } from '../../src/tv-sharing/broker.js';
import type { MediaRow } from '../../src/api/mappers.js';

it('preserves native preview pixels and orientation, and preserves explicit TV settings', async () => {
  const t = await createTestApp();
  try {
    const destination = previewPathForMediaId(t.ctx.paths.previewsDir, 1);
    const input = await sharp({create:{width:2400,height:1600,channels:3,background:'red'}}).jpeg().toBuffer();
    await generatePreviewFromBuffer(input,destination,6);
    expect(await sharp(destination).metadata()).toMatchObject({width:1600,height:2400});
    expect(previewTarget(6000,4000,6)).toEqual({width:1440,height:2160});
    expect(TvSettingsSchema.parse({})).toMatchObject({quality:'4k',cacheMiB:2048,upgradePreviews:false});
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

it('web preview/status requests do not schedule upgrades and unshared retries are rejected', async () => {
  const t=await createTestApp();
  try {
    const root=seedScanRoot(t.db),folder=seedFolder(t.db,root,'/library');
    const id=seedMedia(t.db,folder,root,{media_type:'raw'});
    const headers={cookie:t.cookie};
    await t.app.inject({url:`/api/media/${id}/preview`,headers});
    const status=await t.app.inject({url:`/api/media/${id}/preview-status`,headers});
    expect(status.json().state).toBeNull();
    expect((await t.app.inject({method:'POST',url:`/api/media/${id}/preview-retry`,headers})).statusCode).toBe(403);
    expect(t.db.prepare('SELECT * FROM preview_upgrades WHERE media_id=?').get(id)).toBeUndefined();
  } finally {await t.close();}
});

it('discards queued work when DLNA sharing is removed', async () => {
  const t=await createTestApp(); await t.ctx.previewUpgrades!.close();
  const render=vi.fn(async()=> 'ready' as const);
  const queue=new PreviewUpgrades(t.db,t.ctx.paths,render);
  try {
    const root=seedScanRoot(t.db),folder=seedFolder(t.db,root,'/library');
    const id=seedMedia(t.db,folder,root,{media_type:'raw'});
    queue.enqueue(t.db.prepare('SELECT * FROM media WHERE id=?').get(id) as MediaRow);
    queue.setEligibility(()=>false);
    await vi.waitFor(()=>expect(queue.status(id)).toBeNull(),{timeout:3000});
    expect(render).not.toHaveBeenCalled();
  } finally {await queue.close();await t.close();}
});

it('prepares shared RAWs only when the TV upgrade option is enabled', async () => {
 const t=await createTestApp();
 try {
  const root=seedScanRoot(t.db),folder=seedFolder(t.db,root,'/library');
  const id=seedMedia(t.db,folder,root,{media_type:'raw',thumbnail_status:'done'});
  const enqueue=vi.fn();
  const broker=new TvSharingBroker(t.db,t.ctx.paths,()=>true,{enqueue,reconcile:vi.fn()} as unknown as PreviewUpgrades);
  broker.save({enabled:true,address:'192.168.1.10',folders:[{id:folder,recursive:true}]});
  broker.preparePreviews();expect(enqueue).not.toHaveBeenCalled();
  broker.save({upgradePreviews:true});broker.preparePreviews();
  expect(enqueue.mock.calls.some(call=>call[0].id===id)).toBe(true);
  enqueue.mockClear();broker.save({upgradePreviews:false});broker.preparePreviews();
  expect(enqueue).not.toHaveBeenCalled();
 } finally {await t.close();}
});

it('blocks at the saved preview budget, preserves previews, and resumes after an increase', async () => {
 const t=await createTestApp(); await t.ctx.previewUpgrades!.close();
 const render=vi.fn(async (job:{destination:string})=>{
  await sharp({create:{width:3000,height:2250,channels:3,background:'blue'}}).jpeg().toFile(job.destination);
  return 'ready' as const;
 });
 const queue=new PreviewUpgrades(t.db,t.ctx.paths,render);
 const broker=new TvSharingBroker(t.db,t.ctx.paths,()=>true,queue);
 try {
  const root=seedScanRoot(t.db),folder=seedFolder(t.db,root,'/library');
  const id=seedMedia(t.db,folder,root,{media_type:'raw'});
  broker.save({enabled:true,address:'192.168.1.10',folders:[{id:folder,recursive:true}],upgradePreviews:true});
  const dest=previewPathForMediaId(t.ctx.paths.previewsDir,id);
  await generatePreviewFromBuffer(await sharp({create:{width:800,height:600,channels:3,background:'red'}}).jpeg().toBuffer(),dest);
  const original=await fs.readFile(dest);
  const padding=await fs.open(t.ctx.paths.previewsDir+'/budget-fixture','w');
  await padding.truncate(5*1024**3);await padding.close();
  broker.preparePreviews();
  await vi.waitFor(()=>expect(queue.status(id)).toBe('blocked'),{timeout:4000});
  expect(render).not.toHaveBeenCalled();
  expect(await fs.readFile(dest)).toEqual(original);
  expect(t.db.prepare('SELECT error_code FROM preview_upgrades WHERE media_id=?').get(id)).toEqual({error_code:'budget'});
  const diagnostics=await broker.diagnostics();
  expect(diagnostics.previewStorage?.suggestedMiB).toBeGreaterThan(5120);
  expect(diagnostics.previewStorage?.limitMiB).toBe(4096);
  broker.save({previewCacheMiB:8192});broker.preparePreviews();
  await vi.waitFor(()=>expect(queue.status(id)).toBe('ready'),{timeout:4000});
  expect(t.db.prepare('SELECT error_code FROM preview_upgrades WHERE media_id=?').get(id)).toEqual({error_code:null});
  expect(render).toHaveBeenCalledTimes(1);
 } finally {await queue.close();await t.close();}
});

it('persists bulk retries beyond queue capacity and excludes unshared photos', async()=>{
 const t=await createTestApp();await t.ctx.previewUpgrades!.close();
 let queue=new PreviewUpgrades(t.db,t.ctx.paths);
 let broker=new TvSharingBroker(t.db,t.ctx.paths,()=>true,queue);
 try {
  const root=seedScanRoot(t.db),folder=seedFolder(t.db,root,'/library');
  const other=seedFolder(t.db,root,'/private');
  broker.save({enabled:true,address:'192.168.1.10',folders:[{id:folder,recursive:false}],upgradePreviews:true});
  let privateId=0;
  t.db.transaction(()=>{
   for(let i=0;i<1003;i++){
    const id=seedMedia(t.db,i===1002?other:folder,root,{media_type:'raw'});
    if(i===1002)privateId=id;
    t.db.prepare("INSERT INTO preview_upgrades(media_id,fingerprint,state) SELECT id,json_array(absolute_path,file_size,fs_modified_at,orientation,1),'failed' FROM media WHERE id=?").run(id);
   }
  })();
  expect(broker.retryPreviews()).toBe(1002);
  expect(queue.summary().queued).toBe(1000);
  expect(t.db.prepare('SELECT COUNT(*) n FROM preview_upgrades WHERE retry_requested=1').get()).toEqual({n:2});
  expect(queue.status(privateId)).toBe('failed');
  // Scheduled old failures must not appear as new problems requiring action.
  expect((await queue.storage(1002)).failures).toEqual([{code:'unknown',count:1}]);
  // Simulate completing the first batch. A failed retry must not loop forever.
  t.db.prepare("UPDATE preview_upgrades SET state='failed' WHERE state='queued'").run();
  await queue.close();
  queue=new PreviewUpgrades(t.db,t.ctx.paths);
  broker=new TvSharingBroker(t.db,t.ctx.paths,()=>true,queue);
  broker.save({enabled:false});broker.preparePreviews();
  expect(queue.summary().queued).toBe(0);
  broker.save({enabled:true});broker.preparePreviews();
  expect(queue.summary().queued).toBe(2);
  expect(t.db.prepare('SELECT COUNT(*) n FROM preview_upgrades WHERE retry_requested=1').get()).toEqual({n:0});
 } finally {await queue.close();await t.close();}
});


it('suggests headroom using remaining work, while respecting free space and existing limits',()=>{
 const GiB=1024**3, MiB=1024**2;
 expect(suggestedPreviewMiB(4.3*GiB,4096,6000,2*MiB,100*GiB)).toBe(19456);
 expect(suggestedPreviewMiB(4.3*GiB,4096,6000,2*MiB,2*GiB)).toBeLessThanOrEqual(Math.floor(5.8*1024));
 expect(suggestedPreviewMiB(4.3*GiB,4096,6000,2*MiB,512*MiB)).toBeNull();
 expect(suggestedPreviewMiB(GiB,4096,10,MiB,100*GiB)).toBeNull();
 expect(suggestedPreviewMiB(4090*MiB,4096,1,MiB,100*GiB,true)).toBe(5120);
 expect(TvSettingsSchema.safeParse({previewCacheMiB:1023}).success).toBe(false);
 expect(TvSettingsSchema.safeParse({previewCacheMiB:4096.5}).success).toBe(false);
 expect(TvSettingsSchema.parse({cacheMiB:512}).previewCacheMiB).toBe(4096);
});

it('records an unavailable source through the real worker without replacing its cached preview',async()=>{
 const t=await createTestApp();await t.ctx.previewUpgrades!.close();
 const queue=new PreviewUpgrades(t.db,t.ctx.paths);
 try{
  const root=seedScanRoot(t.db),folder=seedFolder(t.db,root,'/library');
  const id=seedMedia(t.db,folder,root,{media_type:'raw',filename:'missing.nef'});
  const dest=previewPathForMediaId(t.ctx.paths.previewsDir,id);
  await generatePreviewFromBuffer(await sharp({create:{width:800,height:600,channels:3,background:'red'}}).jpeg().toBuffer(),dest);
  const old=await fs.readFile(dest);
  queue.enqueue(t.db.prepare('SELECT * FROM media WHERE id=?').get(id) as MediaRow);
  await vi.waitFor(()=>expect(queue.status(id)).toBe('failed'),{timeout:5000});
  expect(t.db.prepare('SELECT error_code,error_message FROM preview_upgrades WHERE media_id=?').get(id)).toMatchObject({error_code:'source',error_message:expect.stringContaining('ENOENT')});
  expect(await fs.readFile(dest)).toEqual(old);
 }finally{await queue.close();await t.close();}
});

it('checks projected replacement size before exceeding a budget',async()=>{
 const t=await createTestApp();await t.ctx.previewUpgrades!.close();
 const render=vi.fn(async(job:{destination:string})=>{
  await sharp({create:{width:3000,height:2250,channels:3,background:'blue'}}).jpeg().toFile(job.destination);
  return 'ready' as const;
 });
 const queue=new PreviewUpgrades(t.db,t.ctx.paths,render);
 try{
  const root=seedScanRoot(t.db),folder=seedFolder(t.db,root,'/library');
  const id=seedMedia(t.db,folder,root,{media_type:'raw'});
  t.db.prepare("INSERT INTO settings(key,value) VALUES ('tvSharing',?)").run(JSON.stringify({previewCacheMiB:1024}));
  const dest=previewPathForMediaId(t.ctx.paths.previewsDir,id);
  await generatePreviewFromBuffer(await sharp({create:{width:800,height:600,channels:3,background:'red'}}).jpeg().toBuffer(),dest);
  const old=await fs.readFile(dest);
  const padding=await fs.open(t.ctx.paths.previewsDir+'/budget-fixture','w');
  await padding.truncate(1024**3-10000);await padding.close();
  queue.enqueue(t.db.prepare('SELECT * FROM media WHERE id=?').get(id) as MediaRow);
  await vi.waitFor(()=>expect(queue.status(id)).toBe('blocked'),{timeout:4000});
  expect(render).toHaveBeenCalledTimes(1);
  expect(await fs.readFile(dest)).toEqual(old);
  expect(t.db.prepare('SELECT error_code FROM preview_upgrades WHERE media_id=?').get(id)).toEqual({error_code:'budget'});
 }finally{await queue.close();await t.close();}
});

it('requires authentication and enabled sharing for bulk retry',async()=>{
 const t=await createTestApp();
 try{
  expect((await t.app.inject({method:'POST',url:'/api/tv-sharing/preview-retry'})).statusCode).toBe(401);
  expect((await t.app.inject({method:'POST',url:'/api/tv-sharing/preview-retry',headers:{cookie:t.cookie}})).statusCode).toBe(409);
 }finally{await t.close();}
});


it('blocks without conversion below the disk reserve and permits a manual retry after recovery',async()=>{
 const t=await createTestApp();await t.ctx.previewUpgrades!.close();
 const actual=await fs.statfs(t.ctx.paths.dataDir);
 const disk=vi.spyOn(fs,'statfs').mockResolvedValue({...actual,bavail:1});
 const render=vi.fn(async(job:{destination:string})=>{
  await sharp({create:{width:3000,height:2250,channels:3,background:'blue'}}).jpeg().toFile(job.destination);
  return 'ready' as const;
 });
 const queue=new PreviewUpgrades(t.db,t.ctx.paths,render);
 try{
  const root=seedScanRoot(t.db),folder=seedFolder(t.db,root,'/library');
  const id=seedMedia(t.db,folder,root,{media_type:'raw'});
  const row=t.db.prepare('SELECT * FROM media WHERE id=?').get(id) as MediaRow;
  queue.enqueue(row);
  await vi.waitFor(()=>expect(queue.status(id)).toBe('blocked'),{timeout:4000});
  expect(render).not.toHaveBeenCalled();
  expect(t.db.prepare('SELECT error_code FROM preview_upgrades WHERE media_id=?').get(id)).toEqual({error_code:'disk'});
  disk.mockRestore();queue.enqueue(row,true);
  await vi.waitFor(()=>expect(queue.status(id)).toBe('ready'),{timeout:4000});
 }finally{disk.mockRestore();await queue.close();await t.close();}
});

it('pauses active work without failure and resumes the retained job', async () => {
  const t=await createTestApp(); await t.ctx.previewUpgrades!.close();
  let enabled=true, release!:()=>void, calls=0;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const queue=new PreviewUpgrades(t.db,t.ctx.paths,async job=>{
    if (++calls===1) await gate;
    await sharp({create:{width:100,height:100,channels:3,background:'blue'}}).jpeg().toFile(job.destination);
    return 'ready';
  });
  queue.setEnabled(()=>enabled);
  try {
    const root=seedScanRoot(t.db), folder=seedFolder(t.db,root,'/library');
    const id=seedMedia(t.db,folder,root,{media_type:'raw'});
    queue.enqueue(t.db.prepare('SELECT * FROM media WHERE id=?').get(id) as MediaRow);
    await vi.waitFor(()=>expect(calls).toBe(1),{timeout:3000});
    enabled=false; queue.reconcile(); release();
    await vi.waitFor(()=>expect(queue.status(id)).toBe('queued'));
    expect(t.db.prepare('SELECT error_code FROM preview_upgrades WHERE media_id=?').get(id)).toEqual({error_code:null});
    enabled=true; queue.reconcile();
    await vi.waitFor(()=>expect(queue.status(id)).toBe('ready'),{timeout:3000});
    expect(calls).toBe(2);
  } finally {release(); await queue.close(); await t.close();}
});

it('discards active output when its share is removed, continuing other shared photos', async () => {
  const t=await createTestApp(); await t.ctx.previewUpgrades!.close();
  let excluded=0;
  const queue=new PreviewUpgrades(t.db,t.ctx.paths,async job=>{
    await sharp({create:{width:100,height:100,channels:3,background:'blue'}}).jpeg().toFile(job.destination);
    excluded=first;
    queue.reconcile();
    return 'ready';
  });
  queue.setEligibility(id=>id!==excluded);
  let first=0;
  try {
    const root=seedScanRoot(t.db), folder=seedFolder(t.db,root,'/library');
    first=seedMedia(t.db,folder,root,{media_type:'raw',filename:'first.nef'});
    const second=seedMedia(t.db,folder,root,{media_type:'raw',filename:'second.nef'});
    for (const id of [first,second]) queue.enqueue(t.db.prepare('SELECT * FROM media WHERE id=?').get(id) as MediaRow);
    await vi.waitFor(()=>expect(queue.status(second)).toBe('ready'),{timeout:5000});
    expect(queue.status(first)).toBeNull();
    await expect(fs.access(previewPathForMediaId(t.ctx.paths.previewsDir,first))).rejects.toThrow();
  } finally {await queue.close(); await t.close();}
});

it('reports only current Favorites after replacing folder shares, including work not yet admitted',async()=>{
 const t=await createTestApp(); await t.ctx.previewUpgrades!.close();
 const queue=new PreviewUpgrades(t.db,t.ctx.paths);
 await queue.close(); // Inspect persistent counts without dispatching conversions.
 const broker=new TvSharingBroker(t.db,t.ctx.paths,()=>true,queue);
 try {
  const root=seedScanRoot(t.db),folder=seedFolder(t.db,root,'/library');
  const ids=Array.from({length:5},(_,i)=>seedMedia(t.db,folder,root,{filename:`raw${i}.nef`,media_type:'raw',thumbnail_status:'done'}));
  for(const [i,state] of ['failed','ready','ready','failed'].entries()) {
   t.db.prepare("INSERT INTO preview_upgrades(media_id,fingerprint,state,error_code,retry_requested) SELECT id,json_array(absolute_path,file_size,fs_modified_at,orientation,1),?,?,? FROM media WHERE id=?").run(state,state==='failed'?'source':null,i===3?1:0,ids[i]);
  }
  broker.save({enabled:true,address:'192.168.1.10',folders:[{id:folder,recursive:true}]});
  for(const id of ids.slice(2)) t.db.prepare('INSERT INTO media_engagement(media_id,favorite) VALUES (?,1)').run(id);
  broker.save({folders:[],collections:['favorites']});
  let d=await broker.diagnostics();
  expect(d.previews).toEqual({queued:1,running:0,ready:1,limited:0,failed:1,blocked:0});
  expect(d.previewStorage?.retryPending).toBe(1);
  expect(d.previewStorage?.failures).toEqual([]);
  t.db.prepare('UPDATE media_engagement SET favorite=0 WHERE media_id=?').run(ids[3]);
  d=await broker.diagnostics();
  expect(d.previews).toMatchObject({queued:1,ready:1,failed:0});
  expect(d.previewStorage?.retryPending).toBe(0);
  expect(d.previewStorage?.failures).toEqual([]);
  expect(queue.status(ids[0])).toBe('failed'); // History retained, excluded from current progress.
  t.db.prepare('UPDATE media SET file_size=file_size+1 WHERE id=?').run(ids[2]);
  d=await broker.diagnostics();
  expect(d.previews).toMatchObject({queued:2,ready:0,failed:0}); // Changed originals need a new attempt.
 }finally {await queue.close();await t.close();}
});

it('prepares highlights in advance, counts pending work, honors pause and preserves completed previews',async()=>{
 const t=await createTestApp();await t.ctx.previewUpgrades!.close();
 const queue=new PreviewUpgrades(t.db,t.ctx.paths);
 const broker=new TvSharingBroker(t.db,t.ctx.paths,()=>true,queue);
 const {TvImageCache}=await import('../../src/tv-sharing/images.js');
 const image=vi.spyOn(TvImageCache.prototype,'get').mockResolvedValue(Buffer.from('jpeg'));
 try{
  const root=seedScanRoot(t.db),folder=seedFolder(t.db,root,'/library');
  for(let i=0;i<10;i++){
   const id=seedMedia(t.db,folder,root,{media_type:'raw'});
   t.db.prepare("INSERT INTO media_exif(media_id,captured_at_precise,tags_json,exiftool_version) VALUES (?,'2024-01-01T12:00:00','{}','test')").run(id);
  }
  broker.save({enabled:true,address:'192.168.1.2',momentsHighlights:true,upgradePreviews:false});
  queue.setEligibility(id=>!!broker.allowedMedia(id));queue.setEnabled(()=>broker.settings().upgradePreviews);
  broker.preparePreviews();expect(queue.summary().queued).toBe(0);
  expect((await broker.diagnostics()).previews?.queued).toBe(5);
  broker.setPreviewProcessing(true);broker.preparePreviews();expect(queue.summary().queued).toBe(5);
  const {items}=await broker.call('com.memorylane.tv-sharing','tv.collection',{collectionId:'moments-highlights',start:0,count:100}) as {items:{id:number}[]};
  const request=(id:number)=>broker.call('com.memorylane.tv-sharing','tv.image',{id:`p:${id}`,profile:'display',collectionId:'moments-highlights'});
  await broker.call('com.memorylane.tv-sharing','tv.image',{id:`c:moments-highlights:p:${items[0].id}`,profile:'display'});expect(queue.status(items[0].id)).toBe('queued');
  expect(t.db.prepare('SELECT priority FROM preview_upgrades WHERE media_id=?').get(items[0].id)).toEqual({priority:5});
  t.db.prepare("UPDATE preview_upgrades SET state='ready' WHERE media_id=?").run(items[1].id);
  broker.preparePreviews();expect(queue.status(items[1].id)).toBe('ready');expect(queue.summary().queued).toBe(4);
  broker.setPreviewProcessing(false);broker.preparePreviews();expect(queue.summary().queued).toBe(4);
  broker.save({momentsHighlights:false,enabled:false});
  expect(queue.summary().queued).toBe(0);expect(queue.status(items[1].id)).toBe('ready');
  broker.save({enabled:true,folders:[{id:folder,recursive:true}]});
  await expect(request(items[0].id)).rejects.toThrow('Not shared');
 }finally{image.mockRestore();await queue.close();await t.close();}
});
