import { expect, it, vi } from "vitest";
import { createTestApp } from "../helpers/app.js";
import { seedFolder, seedMedia, seedScanRoot } from "../helpers/db.js";

it("queues Apple viewing copies only for explicit selections, including folder snapshots", async () => {
  const t = await createTestApp();
  try {
    const headers = {cookie: t.cookie};
    t.db.prepare("INSERT OR REPLACE INTO plugin_settings(id,enabled) VALUES('apple-photos',1)").run();
    const root=seedScanRoot(t.db), folder=seedFolder(t.db,root,"/library");
    const apple=seedMedia(t.db,folder,root), other=seedMedia(t.db,folder,root);
    t.db.prepare("UPDATE media SET source_kind='apple-photos' WHERE id=?").run(apple);
    const enqueue=vi.spyOn(t.ctx.applePreparation!, "enqueue").mockReturnValue(1);
    const id=(await t.app.inject({method:"POST",url:"/api/collections",headers,payload:{name:"Selected"}})).json().id;
    const favorite=await t.app.inject({method:"PUT",url:`/api/media/${apple}/favorite`,headers,payload:{favorite:true}});
    if(process.platform === "darwin") {
      expect(favorite.statusCode).toBe(200); expect(enqueue).toHaveBeenCalledWith([apple]);
    }
    enqueue.mockClear();
    await t.app.inject({method:"PUT",url:`/api/media/${other}/favorite`,headers,payload:{favorite:true}});
    expect(enqueue).not.toHaveBeenCalled();
    await t.app.inject({method:"POST",url:`/api/collections/${id}/members`,headers,payload:{mediaIds:[apple,other]}});
    expect(enqueue).toHaveBeenCalledWith(process.platform === "darwin" ? [apple] : []);
    enqueue.mockClear();
    await t.app.inject({method:"DELETE",url:`/api/collections/${id}/members`,headers,payload:{mediaIds:[apple]}});
    await t.app.inject({method:"POST",url:`/api/collections/${id}/members`,headers,payload:{folderId:folder,recursive:true}});
    if(process.platform === "darwin") expect(enqueue).toHaveBeenCalledWith([apple]);
    enqueue.mockClear();
    await t.app.inject({method:"POST",url:`/api/collections/${id}/members`,headers,payload:{folderId:folder}});
    expect(enqueue).not.toHaveBeenCalled();
  } finally { await t.close(); }
});

it("serves prepared Apple viewing copies with revocable cache headers", async () => {
  const t = await createTestApp();
  try {
    const fs=await import("node:fs"), path=await import("node:path");
    const root=seedScanRoot(t.db), folder=seedFolder(t.db,root,"/apple");
    const id=seedMedia(t.db,folder,root);
    t.db.prepare("UPDATE media SET source_kind='apple-photos' WHERE id=?").run(id);
    const file=path.join(t.ctx.paths.dataDir,"prepared.jpg");
    fs.writeFileSync(file,Buffer.from([0xff,0xd8,0xff,0xd9]));
    vi.spyOn(t.ctx.applePreparation!, "readPath").mockImplementation(mediaId=>mediaId===id?file:null);
    t.db.prepare("INSERT OR REPLACE INTO plugin_settings(id,enabled) VALUES('apple-photos',1)").run();
    for(const endpoint of ["file","preview","thumbnail"]) {
      expect((await t.app.inject({url:`/api/media/${id}/${endpoint}`})).statusCode).toBe(401);
      const result=await t.app.inject({url:`/api/media/${id}/${endpoint}`,headers:{cookie:t.cookie}});
      if(process.platform==="darwin") {
        expect(result.statusCode).toBe(200);
        expect(result.headers["cache-control"]).toBe("no-store");
        expect(result.headers["x-memorylane-source"]).toBe("derivative");
        expect(result.headers["content-type"]).toBe("image/jpeg");
      } else expect(result.statusCode).toBe(404);
    }
    t.db.prepare("UPDATE plugin_settings SET enabled=0 WHERE id='apple-photos'").run();
    expect((await t.app.inject({url:`/api/media/${id}/file`,headers:{cookie:t.cookie}})).statusCode).toBe(404);
  } finally {await t.close();}
});
