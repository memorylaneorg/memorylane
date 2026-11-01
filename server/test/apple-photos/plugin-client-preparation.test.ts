import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareApplePhoto } from '../../src/plugins/apple-photos/plugin-client.js';
import type { PluginManager } from '../../src/plugin-platform/manager.js';
const manager={supervisor:{get:()=>({port:1234,token:'private'})}} as unknown as PluginManager;
afterEach(()=>vi.unstubAllGlobals());
describe('Apple helper preparation client',()=>{
 it('requires a helper advertising preparation instead of issuing requests to an old helper',async()=>{
  const fetch=vi.fn().mockResolvedValue(Response.json({status:'ready'}));vi.stubGlobal('fetch',fetch);
  await expect(prepareApplePhoto(manager,'/library','id',new AbortController().signal)).rejects.toThrow(/Update/);
  expect(fetch).toHaveBeenCalledTimes(1);
 });
 it('rejects malformed base64 rather than silently decoding partial payloads',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(Response.json({preparation:{version:1}})).mockResolvedValueOnce(Response.json({jpeg_base64:'%%%invalid%%%'})).mockResolvedValue(Response.json({ok:true})));
  await expect(prepareApplePhoto(manager,'/library','id',new AbortController().signal)).rejects.toThrow(/invalid/);
 });
 it('returns only bounded JPEG bytes and targets one uuid and library',async()=>{
  const fetch=vi.fn().mockResolvedValueOnce(Response.json({preparation:{version:1}})).mockResolvedValueOnce(Response.json({jpeg_base64:Buffer.from([255,216,255,217]).toString('base64')}));vi.stubGlobal('fetch',fetch);
  expect(await prepareApplePhoto(manager,'/library','id',new AbortController().signal)).toEqual(Buffer.from([255,216,255,217]));
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({library_path:'/library',uuid:'id'});
 });
});
