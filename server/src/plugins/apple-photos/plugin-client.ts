import { z } from "zod";
import type { PluginManager } from "../../plugin-platform/manager.js";
import type { CatalogPage } from "./sync.js";

export const APPLE_PHOTOS_SERVICE_ID = "com.memorylane.apple-photos";
const faceSchema=z.object({name:z.string(),x:z.number(),y:z.number(),w:z.number(),h:z.number()});
const exifSchema=z.object({camera_make:z.string().nullable(),camera_model:z.string().nullable(),lens_model:z.string().nullable(),focal_length:z.number().nullable(),aperture:z.number().nullable(),iso:z.number().nullable(),shutter_speed:z.number().nullable()});
const assetSchema=z.object({uuid:z.string().min(1),original_filename:z.string().nullable(),original_path:z.string().nullable(),derivative_path:z.string().nullable(),original_available:z.boolean(),date:z.string().nullable(),title:z.string().nullable(),description:z.string().nullable(),keywords:z.array(z.string()),favorite:z.boolean(),hidden:z.boolean(),in_trash:z.boolean(),screenshot:z.boolean().optional(),latitude:z.number().nullable(),longitude:z.number().nullable(),faces:z.array(faceSchema),exif:exifSchema.nullable().optional()});
const pageSchema=z.object({assets:z.array(z.unknown()).max(500),failures:z.array(z.object({uuid:z.string(),error:z.string()})).max(500).optional(),next_cursor:z.number().int().nonnegative().nullable(),total:z.number().int().nonnegative()});

async function request(manager:PluginManager,path:string,body?:unknown):Promise<unknown>{
  const instance=manager.supervisor.get(APPLE_PHOTOS_SERVICE_ID); if(!instance)throw new Error("Install and enable the Apple Photos plugin first");
  const response=await fetch(`http://127.0.0.1:${instance.port}${path}`,{method:body===undefined?"GET":"POST",headers:{authorization:`Bearer ${instance.token}`,"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(120_000)});
  const payload=await response.json() as {error?:string}; if(!response.ok)throw new Error(payload.error??`Apple Photos plugin returned HTTP ${response.status}`); return payload;
}
export async function applePhotosHealth(manager:PluginManager){return z.object({status:z.literal("ready")}).passthrough().parse(await request(manager,"/health"));}
export async function detectApplePhotosLibraries(manager:PluginManager){return z.array(z.object({path:z.string(),readable:z.boolean(),reason:z.string().optional()})).parse(await request(manager,"/libraries"));}
export async function openInApplePhotos(manager:PluginManager,uuid:string){await request(manager,"/open",{uuid});}
export async function fetchCatalogPage(manager:PluginManager,libraryPath:string,cursor:number):Promise<CatalogPage>{const page=pageSchema.parse(await request(manager,"/catalog",{library_path:libraryPath,cursor,limit:200}));const assets:CatalogPage["assets"]=[],failures=[...(page.failures??[])];for(const raw of page.assets){const parsed=assetSchema.safeParse(raw);if(parsed.success)assets.push(parsed.data);else failures.push({uuid:typeof raw==="object"&&raw!==null&&"uuid" in raw?String(raw.uuid):"unknown",error:"Invalid Photos catalogue item"});}return{assets,failures,next_cursor:page.next_cursor,total:page.total};}

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  if (!response.body) throw Error('Apple Photos returned an empty response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw Error('Apple Photos viewing image exceeds the response size limit');
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function prepareApplePhoto(manager:PluginManager, libraryPath:string, uuid:string, signal:AbortSignal):Promise<Buffer> {
  const instance=manager.supervisor.get(APPLE_PHOTOS_SERVICE_ID);
  if(!instance) throw Error('Apple Photos helper is unavailable. Enable the plugin and try again.');
  const base=`http://127.0.0.1:${instance.port}`;
  const headers={authorization:`Bearer ${instance.token}`,'content-type':'application/json'};
  const healthResponse=await fetch(base+'/health',{headers,signal:AbortSignal.any([signal,AbortSignal.timeout(5000)])});
  const health=await boundedJson(healthResponse,16384) as {preparation?:{version?:number}};
  if(!healthResponse.ok || health.preparation?.version!==1) throw Error('Update the Apple Photos plugin to a version supporting photo preparation.');
  signal.throwIfAborted();
  const job_id=crypto.randomUUID();
  const cancel=()=>{void fetch(base+'/prepare/cancel',{method:'POST',headers,body:JSON.stringify({job_id}),signal:AbortSignal.timeout(5000)}).catch(()=>{});};
  signal.addEventListener('abort',cancel,{once:true});
  try {
    const response=await fetch(base+'/prepare',{method:'POST',headers,body:JSON.stringify({job_id,library_path:libraryPath,uuid}),signal:AbortSignal.any([signal,AbortSignal.timeout(125000)])});
    const body=await boundedJson(response,45*1024*1024) as {jpeg_base64?:string;error?:string};
    if(!response.ok) throw Error(body.error ?? 'Apple Photos could not prepare this photo');
    if(typeof body.jpeg_base64!=='string' || body.jpeg_base64.length>45*1024*1024 || body.jpeg_base64.length%4!==0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.jpeg_base64)) throw Error('Apple Photos returned an invalid viewing image');
    const bytes=Buffer.from(body.jpeg_base64,'base64');
    if(bytes.length<4 || bytes[0]!==0xff || bytes[1]!==0xd8 || bytes[bytes.length-2]!==0xff || bytes[bytes.length-1]!==0xd9) throw Error('Apple Photos returned an invalid viewing image');
    if(bytes.length>32*1024*1024) throw Error('Apple Photos viewing image exceeds 32 MiB');
    return bytes;
  } catch(error) { cancel(); throw error; }
  finally {signal.removeEventListener('abort',cancel);}
}
