import { describe, it, expect } from 'vitest';
import { createTestDb, seedScanRoot, seedFolder, seedMedia } from '../helpers/db.js';
import { TvSharingBroker, TV_PLUGIN_ID } from '../../src/tv-sharing/broker.js';
import type { AppPaths } from '../../src/config/paths.js';
describe('TV sharing policy', () => {
    it('defaults off and enforces current folder policy for direct photo IDs', async () => {
        const db = await createTestDb();
        let plugin = true;
        try {
            const root = seedScanRoot(db), a = seedFolder(db, root, '/library/a'), b = seedFolder(db, root, '/library/b'), child = seedFolder(db, root, '/library/a/child', a);
            const photo = seedMedia(db, a, root), nested = seedMedia(db, child, root), privatePhoto = seedMedia(db, b, root);
            const broker = new TvSharingBroker(db, {} as AppPaths, () => plugin);
            expect(broker.settings().enabled).toBe(false);
            await expect(broker.call(TV_PLUGIN_ID, 'tv.browse', { objectId: '0', flag: 'BrowseDirectChildren', start: 0, count: 100 })).rejects.toThrow();
            broker.save({ enabled: true, address: '192.168.1.2', folders: [{ id: a, recursive: false }] });
            expect(broker.allowedMedia(photo)).toBeTruthy();
            expect(broker.allowedMedia(nested)).toBeUndefined();
            expect(broker.allowedMedia(privatePhoto)).toBeUndefined();
            broker.save({ folders: [{ id: a, recursive: true }] });
            expect(broker.allowedMedia(nested)).toBeTruthy();
            const results = await broker.call(TV_PLUGIN_ID, 'tv.browse', { objectId: `f:${a}`, flag: 'BrowseDirectChildren', start: 0, count: 100 }) as {
                items: unknown[];
            };
            expect(results.items).toHaveLength(2);
            await expect(broker.call('com.memorylane.people', 'tv.config', {})).rejects.toThrow();
            broker.save({ folders: [], enabled: false });
            expect(broker.allowedMedia(photo)).toBeUndefined();
            plugin = false;
            expect((await broker.call(TV_PLUGIN_ID, 'tv.config', {}) as {
                enabled: boolean;
            }).enabled).toBe(false);
        }
        finally {
            db.close();
        }
    });
    it('excludes video, missing, Apple Photos and deletion-marked records', async () => {
        const db = await createTestDb();
        try {
            const root = seedScanRoot(db), folder = seedFolder(db, root, '/library'), broker = new TvSharingBroker(db, {} as AppPaths, () => true);
            broker.save({ enabled: true, address: '10.0.0.5', folders: [{ id: folder, recursive: true }] });
            const video = seedMedia(db, folder, root, { media_type: 'video' }), missing = seedMedia(db, folder, root, { status: 'missing' }), apple = seedMedia(db, folder, root);
            db.prepare("UPDATE media SET source_kind='apple-photos' WHERE id=?").run(apple);
            for (const id of [video, missing, apple])
                expect(broker.allowedMedia(id)).toBeUndefined();
            expect(() => broker.save({ address: '8.8.8.8' })).toThrow();
            const raw = seedMedia(db, folder, root, { media_type: 'raw' }), jpeg = seedMedia(db, folder, root);
            db.prepare('UPDATE media SET raw_pair_id=? WHERE id=?').run(raw, jpeg);
            expect(broker.allowedMedia(raw)).toBeUndefined();
            db.prepare('INSERT INTO deletion_marks(media_id) VALUES(?)').run(jpeg);
            expect(broker.allowedMedia(jpeg)).toBeUndefined();
            db.prepare("UPDATE folders SET status='missing' WHERE id=?").run(folder);
            expect(broker.save({ enabled: false }).enabled).toBe(false);
        }
        finally {
            db.close();
        }
    });
});

it('shares explicit collections independently of folders and revokes scoped image access immediately',async()=>{
 const db=await createTestDb();try{
  const {CollectionRepo}=await import('../../src/collections/collection-repo.js');
  const repo=new CollectionRepo(db),root=seedScanRoot(db),folder=seedFolder(db,root,'/library');
  const a=seedMedia(db,folder,root),b=seedMedia(db,folder,root),c=repo.create('Trips');
  repo.add(Number(c.id),{kind:'ids',ids:[a]});
  const broker=new TvSharingBroker(db,{} as AppPaths,()=>true);
  expect(broker.settings().collections).toEqual([]);
  broker.save({enabled:true,address:'192.168.1.2',collections:[c.id,'favorites']});
  expect(broker.allowedMedia(a)).toBeTruthy();expect(broker.allowedMedia(b)).toBeUndefined();
  const args={collectionId:c.id,start:0,count:100,sort:'+dc:title'};
  expect(await broker.call(TV_PLUGIN_ID,'tv.collection',args)).toMatchObject({total:1,items:[{id:a}]});
  repo.rename(Number(c.id),'Renamed');
  expect(await broker.call(TV_PLUGIN_ID,'tv.collections',{})).toMatchObject({items:expect.arrayContaining([expect.objectContaining({id:c.id,name:'Renamed'})])});
  db.prepare('INSERT INTO media_engagement(media_id,favorite) VALUES(?,1)').run(b);
  expect(broker.allowedMedia(b)).toBeTruthy();
  // Another share may still grant the photo, but a removed collection alias must fail.
  broker.save({folders:[{id:folder,recursive:true}]});repo.remove(Number(c.id),[a]);
  await expect(broker.call(TV_PLUGIN_ID,'tv.image',{id:`p:${a}`,profile:'display',collectionId:c.id})).rejects.toThrow('Not shared');
  expect(broker.allowedMedia(a)).toBeTruthy();
  repo.delete(Number(c.id));await expect(broker.call(TV_PLUGIN_ID,'tv.collection',args)).rejects.toThrow('Not shared');
  expect(repo.create('Replacement').id).not.toBe(c.id);
  broker.save({collections:[],folders:[{id:folder,recursive:true}]});
  await expect(broker.call(TV_PLUGIN_ID,'tv.collection',{...args,collectionId:'favorites'})).rejects.toThrow('Not shared');
 }finally{db.close();}
});

it('never shares collection members from disabled scan roots or Apple Photos',async()=>{
 const db=await createTestDb();try{
  const {CollectionRepo}=await import('../../src/collections/collection-repo.js');const repo=new CollectionRepo(db);
  const root=seedScanRoot(db),folder=seedFolder(db,root,'/library'),photo=seedMedia(db,folder,root),c=repo.create('Test');
  repo.add(Number(c.id),{kind:'ids',ids:[photo]});const broker=new TvSharingBroker(db,{} as AppPaths,()=>true);
  broker.save({enabled:true,address:'10.0.0.2',collections:[c.id]});
  db.prepare('UPDATE scan_roots SET enabled=0 WHERE id=?').run(root);expect(broker.allowedMedia(photo)).toBeUndefined();
  db.prepare('UPDATE scan_roots SET enabled=1 WHERE id=?').run(root);db.prepare("UPDATE media SET source_kind='apple-photos' WHERE id=?").run(photo);expect(broker.allowedMedia(photo)).toBeUndefined();
 }finally{db.close();}
});

it('prunes deleted TV selections and lists only selected names without counting collection contents',async()=>{
 const db=await createTestDb();try{
  const {CollectionRepo}=await import('../../src/collections/collection-repo.js');const repo=new CollectionRepo(db);
  const a=repo.create('Removed'),b=repo.create('Keep');
  const broker=new TvSharingBroker(db,{} as AppPaths,()=>true);
  broker.save({enabled:true,address:'10.0.0.2',collections:[a.id,b.id]});repo.delete(Number(a.id));
  expect(broker.settings().collections).toEqual([b.id]);
  expect(broker.save({quality:'4k'}).collections).toEqual([b.id]);
  // A descriptor listing must not need media tables or counts at all.
  db.exec('DROP TABLE collection_media; DROP TABLE media_engagement;');
  expect(await broker.call(TV_PLUGIN_ID,'tv.collections',{})).toMatchObject({items:[{id:b.id,name:'Keep'}]});
 }finally{db.close();}
});
