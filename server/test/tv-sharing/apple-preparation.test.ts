import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { createTestDb, seedScanRoot, seedFolder, seedMedia } from '../helpers/db.js';
import { TvSharingBroker, TV_PLUGIN_ID } from '../../src/tv-sharing/broker.js';
import { TvImageCache } from '../../src/tv-sharing/images.js';
import { CollectionRepo } from '../../src/collections/collection-repo.js';
import type { AppPaths } from '../../src/config/paths.js';

// Exercise the visibility gate on every host; production additionally requires macOS.
vi.mock('../../src/plugins/registry.js', () => ({ isApplePhotosEnabled: (db: any) => !!db.prepare("SELECT 1 FROM plugin_settings WHERE id='apple-photos' AND enabled=1").get() }));
const cleanup: Array<()=>void> = [];
afterEach(() => { vi.restoreAllMocks(); for(const fn of cleanup.splice(0)) fn(); });
async function setup() {
  const db = await createTestDb();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(),'tv-apple-prepared-'));
  cleanup.push(()=>{db.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  const root=seedScanRoot(db), folder=seedFolder(db,root,'/library'), id=seedMedia(db,folder,root,{thumbnail_status:'unsupported'});
  db.prepare("UPDATE scan_roots SET kind='apple-photos' WHERE id=?").run(root);
  db.prepare("UPDATE media SET source_kind='apple-photos',absolute_path='apple-photos:1:cloud' WHERE id=?").run(id);
  db.prepare("INSERT INTO apple_photos_assets(scan_root_id,uuid,media_id) VALUES(?,'cloud',?)").run(root,id);
  db.prepare("INSERT INTO plugin_settings(id,enabled) VALUES('apple-photos',1)").run();
  db.prepare('INSERT INTO media_engagement(media_id,favorite) VALUES(?,1)').run(id);
  db.prepare("INSERT INTO apple_photo_preparation(media_id,state) VALUES(?,'queued')").run(id);
  const file=path.join(dataDir,`${id}.jpg`);
  await sharp({create:{width:64,height:32,channels:3,background:'red'}}).jpeg().toFile(file);
  const readPath=vi.fn(()=>fs.existsSync(file)?file:null);
  const broker=new TvSharingBroker(db,{dataDir} as AppPaths,()=>true,undefined,{readPath});
  broker.save({enabled:true,address:'192.168.1.2',collections:['favorites']});
  const browse=()=>broker.call(TV_PLUGIN_ID,'tv.collection',{collectionId:'favorites',start:0,count:100});
  return {db,dataDir,root,folder,id,file,readPath,broker,browse};
}

it('lists and serves only ready explicit Apple selections, never folders or Moments',async()=>{
  const t=await setup();
  expect(await t.browse()).toMatchObject({total:0});
  expect(t.broker.allowedMedia(t.id,'favorites')).toBeUndefined();
  t.db.prepare("UPDATE apple_photo_preparation SET state='ready' WHERE media_id=?").run(t.id);
  expect(await t.browse()).toMatchObject({total:1,items:[{id:t.id}]});
  expect(t.broker.allowedMedia(t.id,'favorites')).toBeTruthy();
  expect(t.broker.allowedMedia(t.id)).toBeUndefined();
  t.broker.save({momentsHighlights:true});
  expect(t.broker.allowedMedia(t.id,'moments-highlights')).toBeUndefined();
  expect(await t.broker.call(TV_PLUGIN_ID,'tv.collection',{collectionId:'moments-highlights',start:0,count:100})).toMatchObject({total:0});
  for(const profile of ['display','thumbnail']) {
    const result=await t.broker.call(TV_PLUGIN_ID,'tv.image',{id:`p:${t.id}`,profile,collectionId:'favorites'}) as {bytes:string};
    expect((await sharp(Buffer.from(result.bytes,'base64')).metadata()).format).toBe('jpeg');
  }
  // Even a warm TV derivative cannot be delivered after prepared bytes disappear.
  fs.unlinkSync(t.file);
  await expect(t.broker.call(TV_PLUGIN_ID,'tv.image',{id:`p:${t.id}`,profile:'display',collectionId:'favorites'})).rejects.toThrow('Not shared');
});

it('rechecks Apple plugin, source, selection, and collection provenance',async()=>{
  const t=await setup();
  t.db.prepare("UPDATE apple_photo_preparation SET state='ready' WHERE media_id=?").run(t.id);
  const repo=new CollectionRepo(t.db), collection=repo.create('Private');
  t.db.prepare('INSERT INTO collection_media(collection_id,media_id) VALUES(?,?)').run(collection.id,t.id);
  t.broker.save({collections:['favorites',collection.id]});
  expect(t.broker.allowedMedia(t.id,collection.id)).toBeTruthy();
  t.db.prepare('DELETE FROM collection_media WHERE collection_id=?').run(collection.id);
  expect(t.broker.allowedMedia(t.id,collection.id)).toBeUndefined();
  expect(t.broker.allowedMedia(t.id,'favorites')).toBeTruthy();
  for(const [table,column,value] of [['plugin_settings','enabled',0],['scan_roots','enabled',0],['apple_photos_assets','hidden',1]] as const) {
    t.db.prepare(`UPDATE ${table} SET ${column}=?`).run(value);
    expect(await t.browse()).toMatchObject({total:0});
    expect(t.broker.allowedMedia(t.id,'favorites')).toBeUndefined();
    t.db.prepare(`UPDATE ${table} SET ${column}=?`).run(value?0:1);
  }
  t.db.prepare('DELETE FROM media_engagement WHERE media_id=?').run(t.id);
  expect(await t.browse()).toMatchObject({total:0});
});

it('reauthorizes after asynchronous derivative delivery',async()=>{
  const t=await setup();
  t.db.prepare("UPDATE apple_photo_preparation SET state='ready' WHERE media_id=?").run(t.id);
  vi.spyOn(TvImageCache.prototype,'get').mockImplementation(async()=>{
    t.db.prepare('UPDATE scan_roots SET enabled=0 WHERE id=?').run(t.root);
    return Buffer.from('cached bytes');
  });
  await expect(t.broker.call(TV_PLUGIN_ID,'tv.image',{id:`p:${t.id}`,profile:'display',collectionId:'favorites'})).rejects.toThrow('Sharing revoked');
});
