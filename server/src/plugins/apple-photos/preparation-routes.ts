import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../context.js';
import { isApplePhotosEnabled } from '../registry.js';
import { ApplePhotoPreparation } from './preparation.js';
import { APPLE_SELECTED_SQL, appleSelectionAllowed, ensureAppleSelection } from './selection.js';
import { prepareApplePhoto, APPLE_PHOTOS_SERVICE_ID } from './plugin-client.js';

export async function registerApplePreparationRoutes(app:FastifyInstance,ctx:AppContext) {
  const enabled=(id:number)=>isApplePhotosEnabled(ctx.db) && !!ctx.db.prepare('SELECT 1 FROM media JOIN scan_roots r ON r.id=media.scan_root_id WHERE media.id=? AND r.enabled=1').get(id);
  const queue=ctx.applePreparation=new ApplePhotoPreparation(ctx.db,ctx.paths,async(id,signal)=>{
    const asset=ctx.db.prepare(`SELECT a.uuid,a.original_path,a.derivative_path,r.path library FROM apple_photos_assets a JOIN scan_roots r ON r.id=a.scan_root_id WHERE a.media_id=? AND a.hidden=0 AND a.in_trash=0 AND r.enabled=1`).get(id) as {uuid:string;original_path:string|null;derivative_path:string|null;library:string}|undefined;
    if(!asset) throw Error('Apple photo is no longer available');
    // Prefer a local image; this path never contacts iCloud.
    for(const candidate of [asset.original_path,asset.derivative_path]) {
      if(!candidate) continue;
      try {
        const [root,file]=await Promise.all([fs.realpath(asset.library),fs.realpath(candidate)]);
        if(!file.startsWith(root+path.sep)) continue;
        if(signal.aborted) throw signal.reason;
        return await sharp(file,{limitInputPixels:80_000_000}).rotate().resize(3840,2160,{fit:'inside',withoutEnlargement:true}).jpeg({quality:90}).toBuffer();
      } catch(error) {if(signal.aborted) throw error;}
    }
    if(!ctx.pluginManager) throw Error('Apple Photos helper is unavailable');
    return prepareApplePhoto(ctx.pluginManager,asset.library,asset.uuid,signal);
  },id=>appleSelectionAllowed(ctx.db,id),enabled);
  app.addHook('onClose',()=>queue.close());
  const unpreparedWhere=`${APPLE_SELECTED_SQL} AND EXISTS(SELECT 1 FROM scan_roots r WHERE r.id=media.scan_root_id AND r.kind='apple-photos' AND r.enabled=1) AND NOT EXISTS(SELECT 1 FROM apple_photo_preparation j WHERE j.media_id=media.id)`;
  const unprepared=()=>ctx.db.prepare(`SELECT media.id FROM media WHERE ${unpreparedWhere} ORDER BY media.id LIMIT 1000`).all() as {id:number}[];
  const unpreparedCount=()=> (ctx.db.prepare(`SELECT COUNT(*) count FROM media WHERE ${unpreparedWhere}`).get() as {count:number}).count;
  const state=()=>({...queue.status(),existing:unpreparedCount(),batchLimit:1000,helperRunning:!!ctx.pluginManager?.supervisor.get(APPLE_PHOTOS_SERVICE_ID)});
  const auth={preHandler:app.requireAuth};
  app.get('/api/plugins/apple-photos/preparation',auth,async()=>state());
  app.put('/api/plugins/apple-photos/preparation',auth,async(req,reply)=>{
    const body=z.object({paused:z.boolean().optional(),cacheMiB:z.number().int().min(64).max(1048576).optional()}).strict().safeParse(req.body);
    if(!body.success)return reply.code(400).send({error:'Invalid preparation settings'});
    queue.configure(body.data);return state();
  });
  app.post('/api/plugins/apple-photos/preparation/start',auth,async(_req,reply)=>{
    if(!isApplePhotosEnabled(ctx.db)) return reply.code(409).send({error:'Enable Apple Photos first'});
    const ids=unprepared().map(r=>r.id);
    queue.enqueue(ids);return state();
  });
  app.post('/api/plugins/apple-photos/preparation/retry',auth,async(_req,reply)=>{
    if(!isApplePhotosEnabled(ctx.db))return reply.code(409).send({error:'Enable Apple Photos first'});
    const ids=ctx.db.prepare(`SELECT j.media_id FROM apple_photo_preparation j JOIN media ON media.id=j.media_id WHERE j.state IN ('failed','blocked') AND ${APPLE_SELECTED_SQL} AND EXISTS(SELECT 1 FROM scan_roots r WHERE r.id=media.scan_root_id AND r.enabled=1) ORDER BY j.media_id LIMIT 1000`).all() as {media_id:number}[];
    queue.retry(ids.map(r=>r.media_id));return state();
  });
  app.delete('/api/plugins/apple-photos/preparation/cache',auth,async()=>{await queue.clear();return state();});
  app.post('/api/plugins/apple-photos/roots/:id/select',auth,async(req,reply)=>{
    if(!isApplePhotosEnabled(ctx.db))return reply.code(404).send({error:'Apple Photos is disabled'});
    const root=z.coerce.number().int().positive().safeParse((req.params as {id:string}).id);
    const body=z.object({uuid:z.string().min(1).max(200)}).strict().safeParse(req.body);
    if(!root.success||!body.success)return reply.code(400).send({error:'Invalid Apple photo'});
    try{return {mediaId:ensureAppleSelection(ctx.db,root.data,body.data.uuid)};}
    catch(e){return reply.code(400).send({error:e instanceof Error?e.message:'Apple photo unavailable'});}
  });
}
