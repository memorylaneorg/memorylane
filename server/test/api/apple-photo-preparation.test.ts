import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ensureAppleSelection } from '../../src/plugins/apple-photos/selection.js';
import { createTestApp } from '../helpers/app.js';

describe('Apple Photos explicit preparation routes',()=>{
 it.skipIf(process.platform!=='darwin')('creates cloud identity only on explicit select, prepares on favorite, and overlays ready viewing availability',async()=>{
  const t=await createTestApp();
  try{
   const root=Number(t.db.prepare("INSERT INTO scan_roots(path,kind) VALUES('/Cloud.photoslibrary','apple-photos')").run().lastInsertRowid);
   t.db.prepare("INSERT INTO apple_photos_assets(scan_root_id,uuid,original_filename,catalog_date) VALUES(?,'cloud','cloud.jpg','2020-01-01')").run(root);
   const post=(url:string,payload:unknown)=>t.app.inject({method:'POST',url,headers:{cookie:t.cookie},payload});
   expect((await post(`/api/plugins/apple-photos/roots/${root}/select`,{uuid:'cloud'})).statusCode).toBe(404);
   t.db.prepare("INSERT INTO plugin_settings(id,enabled) VALUES('apple-photos',1) ON CONFLICT(id) DO UPDATE SET enabled=1").run();
   t.ctx.applePreparation!.configure({paused:true});
   const selected=await post(`/api/plugins/apple-photos/roots/${root}/select`,{uuid:'cloud'});
   expect(selected.statusCode).toBe(200);
   const id=selected.json().mediaId;
   expect(t.ctx.applePreparation!.status().queued).toBe(0);
   const favorite=await t.app.inject({method:'PUT',url:`/api/media/${id}/favorite`,headers:{cookie:t.cookie},payload:{favorite:true}});
   expect(favorite.statusCode).toBe(200);
   expect(t.ctx.applePreparation!.status().queued).toBe(1);
   const get=()=>t.app.inject({method:'GET',url:`/api/plugins/apple-photos/roots/${root}/browse?year=all`,headers:{cookie:t.cookie}});
   expect((await get()).json().items[0]).toMatchObject({available:false,mediaType:'image',media:{thumbnailStatus:'unsupported'}});
   const cached=path.join(t.ctx.paths.dataDir,'apple-photos-cache',`${id}.jpg`);
   fs.writeFileSync(cached,Buffer.from([255,216,255,217]));
   t.db.prepare("UPDATE apple_photo_preparation SET state='ready' WHERE media_id=?").run(id);
   expect((await get()).json().items[0]).toMatchObject({available:true,mediaType:'image',media:{thumbnailStatus:'done'}});
   t.db.prepare('UPDATE scan_roots SET enabled=0 WHERE id=?').run(root);
   expect(t.ctx.applePreparation!.readPath(id)).toBeNull();
   expect((await get()).statusCode).toBe(404);
  }finally{await t.close();}
 });
 it.skipIf(process.platform!=='darwin')('filters revoked failed jobs before the retry batch limit',async()=>{
  const t=await createTestApp();
  try{
   t.db.prepare("INSERT INTO plugin_settings(id,enabled) VALUES('apple-photos',1) ON CONFLICT(id) DO UPDATE SET enabled=1").run();
   t.ctx.applePreparation!.configure({paused:true});
   const root=Number(t.db.prepare("INSERT INTO scan_roots(path,kind) VALUES('/Cloud.photoslibrary','apple-photos')").run().lastInsertRowid);
   let selected=0;
   t.db.transaction(()=>{
    for(let n=0;n<1001;n++){
     t.db.prepare('INSERT INTO apple_photos_assets(scan_root_id,uuid,original_filename) VALUES(?,?,?)').run(root,`cloud-${n}`,`${n}.jpg`);
     const id=ensureAppleSelection(t.db,root,`cloud-${n}`);
     t.db.prepare("INSERT INTO apple_photo_preparation(media_id,state) VALUES(?,'failed')").run(id);
     selected=id;
    }
    t.db.prepare('INSERT INTO media_engagement(media_id,favorite) VALUES(?,1)').run(selected);
   })();
   const retried=await t.app.inject({method:'POST',url:'/api/plugins/apple-photos/preparation/retry',headers:{cookie:t.cookie}});
   expect(retried.statusCode).toBe(200);
   expect(t.db.prepare('SELECT state FROM apple_photo_preparation WHERE media_id=?').get(selected)).toEqual({state:'queued'});
   expect((t.db.prepare("SELECT COUNT(*) c FROM apple_photo_preparation WHERE state='queued'").get() as {c:number}).c).toBe(1);
  }finally{await t.close();}
 });
});
