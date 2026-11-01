import { it, expect } from 'vitest';
import { createTestApp } from '../helpers/app.js';
it('keeps administration authenticated and refuses activation without the plugin', async () => {
    const t = await createTestApp();
    try {
        expect((await t.app.inject({ url: '/api/tv-sharing' })).statusCode).toBe(401);
        const state = await t.app.inject({ url: '/api/tv-sharing', headers: { cookie: t.cookie } });
        expect(state.json()).toMatchObject({ installed: false, settings: { enabled: false, folders: [] }, runtime: null });
        expect((await t.app.inject({ method: 'PUT', url: '/api/tv-sharing', headers: { cookie: t.cookie }, payload: { enabled: true } })).statusCode).toBe(409);
    }
    finally {
        await t.close();
    }
});

it('requires authentication to clear the TV cache and works with sharing disabled',async()=>{
 const t=await createTestApp();
 try {
  const fs=await import('node:fs/promises');
  const dir=t.ctx.paths.dataDir+'/tv-sharing-cache';
  await fs.mkdir(dir);await fs.writeFile(dir+'/test.jpg','cached');
  expect((await t.app.inject({method:'DELETE',url:'/api/tv-sharing/cache'})).statusCode).toBe(401);
  expect(await fs.readFile(dir+'/test.jpg','utf8')).toBe('cached');
  const result=await t.app.inject({method:'DELETE',url:'/api/tv-sharing/cache',headers:{cookie:t.cookie}});
  expect(result.statusCode).toBe(200);expect(result.json()).toEqual({freedBytes:6});
  expect(await fs.readdir(dir)).toEqual([]);
 }finally {await t.close();}
});

it('validates and authenticates preview processing controls',async()=>{
 const t=await createTestApp();
 try {
  const url='/api/tv-sharing/preview-processing';
  expect((await t.app.inject({method:'POST',url,payload:{enabled:false}})).statusCode).toBe(401);
  expect((await t.app.inject({method:'POST',url,headers:{cookie:t.cookie},payload:{enabled:'false'}})).statusCode).toBe(400);
  expect((await t.app.inject({method:'POST',url,headers:{cookie:t.cookie},payload:{enabled:false}})).statusCode).toBe(409);
 }finally {await t.close();}
});
