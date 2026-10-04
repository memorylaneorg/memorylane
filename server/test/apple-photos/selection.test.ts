import { describe, expect, it } from 'vitest';
import { createTestDb } from '../helpers/db.js';
import { ensureAppleSelection, appleSelectionAllowed } from '../../src/plugins/apple-photos/selection.js';
import { upsertAppleAsset, type AppleCatalogAsset } from '../../src/plugins/apple-photos/sync.js';

const asset:AppleCatalogAsset={uuid:'cloud',original_filename:'cloud.jpg',original_path:null,derivative_path:null,original_available:false,date:'2020-01-01',title:null,description:null,keywords:[],favorite:false,hidden:false,in_trash:false,latitude:1,longitude:2,faces:[]};
describe('explicit Apple cloud selection',()=>{
 it('creates one stable identity without a preparation job; sync preserves explicit membership',async()=>{
  const db=await createTestDb();
  try{
   const root=Number(db.prepare("INSERT INTO scan_roots(path,kind) VALUES('/Cloud.photoslibrary','apple-photos')").run().lastInsertRowid);
   upsertAppleAsset(db,root,asset);
   const id=ensureAppleSelection(db,root,'cloud');
   expect(ensureAppleSelection(db,root,'cloud')).toBe(id);
   expect(db.prepare('SELECT COUNT(*) c FROM apple_photo_preparation').get()).toEqual({c:0});
   expect(appleSelectionAllowed(db,id)).toBe(false);
   upsertAppleAsset(db,root,asset);
   expect(db.prepare('SELECT status FROM media WHERE id=?').get(id)).toEqual({status:'missing'});
   expect(ensureAppleSelection(db,root,'cloud')).toBe(id);
   expect(db.prepare('SELECT status FROM media WHERE id=?').get(id)).toEqual({status:'active'});
   db.prepare("UPDATE media SET fingerprint='formerly-local',status='missing' WHERE id=?").run(id);
   expect(ensureAppleSelection(db,root,'cloud')).toBe(id);
   db.prepare('INSERT INTO media_engagement(media_id,favorite) VALUES(?,1)').run(id);
   expect(appleSelectionAllowed(db,id)).toBe(true);
   upsertAppleAsset(db,root,asset);
   expect(db.prepare('SELECT status,gps_lat,gps_lon FROM media WHERE id=?').get(id)).toEqual({status:'active',gps_lat:1,gps_lon:2});
   upsertAppleAsset(db,root,{...asset,hidden:true});
   expect(appleSelectionAllowed(db,id)).toBe(false);
  }finally{db.close();}
 });
 it('rejects a pre-existing video identity instead of treating it as a preparable photo',async()=>{
  const db=await createTestDb();
  try{
   const root=Number(db.prepare("INSERT INTO scan_roots(path,kind) VALUES('/Cloud.photoslibrary','apple-photos')").run().lastInsertRowid);
   upsertAppleAsset(db,root,asset); const id=ensureAppleSelection(db,root,'cloud');
   db.prepare("UPDATE media SET media_type='video' WHERE id=?").run(id);
   expect(()=>ensureAppleSelection(db,root,'cloud')).toThrow(/still/);
  }finally{db.close();}
 });
});
