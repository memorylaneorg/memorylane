import {it,expect} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createTestApp} from '../helpers/app.js';
it('requires authentication, lists only visible folders, and never adds or scans them',async()=>{
 const t=await createTestApp();
 try {
  const root=path.join(t.ctx.paths.dataDir,'picker'); await fs.mkdir(root);
  await fs.mkdir(path.join(root,'Photos')); await fs.mkdir(path.join(root,'.hidden'));
  await fs.writeFile(path.join(root,'photo.jpg'),'original');
  const url='/api/scan-roots/directories?'+new URLSearchParams({path:root});
  expect((await t.app.inject({url})).statusCode).toBe(401);
  const result=await t.app.inject({url,headers:{cookie:t.cookie}});
  expect(result.statusCode).toBe(200);
  expect(result.json().folders).toEqual([{name:'Photos',path:path.join(await fs.realpath(root),'Photos')}]);
  expect(result.json().nextOffset).toBeNull();
  expect(t.db.prepare('SELECT COUNT(*) n FROM scan_roots').get()).toEqual({n:0});
  expect((await t.app.inject({url:'/api/scan-roots/directories?path=relative',headers:{cookie:t.cookie}})).statusCode).toBe(400);
  expect((await t.app.inject({url:'/api/scan-roots/directories?'+new URLSearchParams({path:path.join(root,'missing')}),headers:{cookie:t.cookie}})).statusCode).toBe(400);
 }finally{await t.close();}
});
it('pages large directory lists without dropping folders',async()=>{
 const t=await createTestApp();
 try {
  const root=path.join(t.ctx.paths.dataDir,'many');await fs.mkdir(root);
  await Promise.all(Array.from({length:205},(_,i)=>fs.mkdir(path.join(root,String(i)))));
  const get=(offset:number)=>t.app.inject({url:'/api/scan-roots/directories?'+new URLSearchParams({path:root,offset:String(offset)}),headers:{cookie:t.cookie}});
  const first=(await get(0)).json();expect(first.folders.length).toBe(200);
  const second=(await get(first.nextOffset)).json();expect(second.folders.length).toBe(5);expect(second.nextOffset).toBeNull();
  expect(new Set([...first.folders,...second.folders].map((r:{path:string})=>r.path)).size).toBe(205);
 }finally{await t.close();}
});
