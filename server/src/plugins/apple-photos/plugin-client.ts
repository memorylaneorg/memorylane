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
