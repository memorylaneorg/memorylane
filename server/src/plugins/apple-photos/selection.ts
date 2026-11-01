import type Database from 'better-sqlite3';
import path from 'node:path';
import { classifyExtension } from '../../scanner/media-types.js';
import { getOrCreateFolder } from '../../scanner/folder-repo.js';

// Creating a catalog identity never reads or downloads the photo. Only an explicit
// favorite/collection action enqueues preparation afterward.
export function ensureAppleSelection(db: Database.Database, rootId: number, uuid: string): number {
  const asset = db.prepare(`SELECT a.*,r.path library_path FROM apple_photos_assets a JOIN scan_roots r ON r.id=a.scan_root_id
    WHERE a.scan_root_id=? AND a.uuid=? AND a.hidden=0 AND a.in_trash=0 AND r.kind='apple-photos' AND r.enabled=1`).get(rootId,uuid) as {media_id:number|null;original_filename:string;library_path:string;catalog_date:string|null;catalog_gps_lat:number|null;catalog_gps_lon:number|null}|undefined;
  if (!asset) throw Error('Apple photo unavailable');
  if (asset.media_id !== null) {
    const media=db.prepare("SELECT 1 FROM media WHERE id=? AND scan_root_id=? AND source_kind='apple-photos' AND media_type IN ('image','raw') AND status IN ('active','missing')").get(asset.media_id,rootId);
    if (!media) throw Error('Only available Apple Photos still images can be prepared');
    if (db.prepare('SELECT 1 FROM deletion_marks WHERE media_id=?').get(asset.media_id)) throw Error('Photo is marked for deletion');
    db.prepare("UPDATE media SET status='active' WHERE id=?").run(asset.media_id);
    return asset.media_id;
  }
  const extension=path.extname(asset.original_filename).slice(1).toLowerCase(), type=classifyExtension(extension);
  if (type !== 'image' && type !== 'raw') throw Error('Only Apple Photos still images can be prepared');
  return db.transaction(()=>{
    const folder=getOrCreateFolder(db,rootId,null,path.basename(asset.library_path),asset.library_path);
    const result=db.prepare(`INSERT INTO media(parent_folder_id,scan_root_id,absolute_path,filename,extension,media_type,file_size,fingerprint,thumbnail_status,status,source_kind,original_available,captured_date,gps_lat,gps_lon,fs_modified_at)
      VALUES(?,?,?,?,?,?,0,'apple-cloud','unsupported','active','apple-photos',0,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(folder.id,rootId,`apple-photos:${rootId}:${uuid}`,asset.original_filename,extension,type,asset.catalog_date,asset.catalog_gps_lat,asset.catalog_gps_lon);
    const id=Number(result.lastInsertRowid);
    db.prepare('UPDATE apple_photos_assets SET media_id=? WHERE scan_root_id=? AND uuid=?').run(id,rootId,uuid);
    return id;
  })();
}

export const APPLE_SELECTED_SQL = `media.source_kind='apple-photos' AND media.media_type IN ('image','raw') AND media.status='active'
 AND EXISTS(SELECT 1 FROM apple_photos_assets a WHERE a.media_id=media.id AND a.scan_root_id=media.scan_root_id AND a.hidden=0 AND a.in_trash=0)
 AND NOT EXISTS(SELECT 1 FROM deletion_marks d WHERE d.media_id=media.id)
 AND (EXISTS(SELECT 1 FROM media_engagement e WHERE e.media_id=media.id AND e.favorite=1)
 OR EXISTS(SELECT 1 FROM collection_media c WHERE c.media_id=media.id))`;
export function appleSelectionAllowed(db:Database.Database,id:number) {
  return !!db.prepare(`SELECT 1 FROM media WHERE id=? AND ${APPLE_SELECTED_SQL}`).get(id);
}
