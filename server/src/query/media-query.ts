import type { MediaTypeFilter, ExifFilterQuery } from "@memorylane/shared";

// A Live Photo's paired video row must never appear as its own grid item -
// it's reachable only via the still photo's livePhotoVideoId.
export const EXCLUDE_LIVE_PHOTO_VIDEOS =
  "media.id NOT IN (SELECT live_photo_video_id FROM media WHERE live_photo_video_id IS NOT NULL)";

// A RAW paired with a same-name JPEG must never appear as its own grid item -
// it's reachable only via the image's rawPairId.
export const EXCLUDE_PAIRED_RAW = "media.id NOT IN (SELECT raw_pair_id FROM media WHERE raw_pair_id IS NOT NULL)";

// Hides every stack member except the cover - the folder grid shows one
// tile per burst. Off for search/favorites/reports, which are about frames.
export const COLLAPSE_STACKS =
  "(media.id NOT IN (SELECT media_id FROM stack_members) OR media.id IN (SELECT cover_media_id FROM stacks))";
export const UNMARKED_MEDIA_SQL = "media.id NOT IN (SELECT media_id FROM deletion_marks)";

// Source visibility is a runtime plugin decision, not a property of the cached
// media row. Keep the clause reusable by listings and non-listing queries.
export const APPLE_PLUGIN_ENABLED_SQL = process.platform === "darwin"
  ? "EXISTS (SELECT 1 FROM plugin_settings ps WHERE ps.id = 'apple-photos' AND ps.enabled = 1)"
  : "0=1";
export const ACTIVE_SOURCE_SQL = process.platform === "darwin"
  ? `(media.source_kind IS NULL OR media.source_kind != 'apple-photos' OR ${APPLE_PLUGIN_ENABLED_SQL})`
  : "(media.source_kind IS NULL OR media.source_kind != 'apple-photos')";

// "photo" groups RAW with regular images - both are non-video stills from
// the user's point of view.
export function mediaTypeFilterClause(type: MediaTypeFilter): string {
  if (type === "photo") return "media.media_type IN ('image', 'raw')";
  if (type === "video") return "media.media_type = 'video'";
  return "1=1";
}

export type MediaScope =
  | { kind: "folder"; folderId: number; recursive: boolean }
  | { kind: "scanRoot"; scanRootId: number }
  | { kind: "ids"; ids: number[] };

export interface MediaQueryParams {
  scope?: MediaScope;
  type?: MediaTypeFilter;
  // Default false: companions (Live Photo videos, paired RAWs) are hidden.
  includeCompanions?: boolean;
  // Cleanup explicitly includes marked rows; ordinary listings hide them.
  includeMarked?: boolean;
  thumbnailDone?: boolean;
  collapseStacks?: boolean;
  // Joins media_engagement as `me` (so callers may ORDER BY me.favorited_at).
  favoritesOnly?: boolean;
  exif?: ExifFilterQuery;
  // Join media_exif as `mx` even with no EXIF filter (reports need the columns).
  requireExifJoin?: boolean;
  // Photos with at least one face assigned to any of these persons.
  personIds?: number[];
  tagId?: number;
}

export interface BuiltMediaQuery {
  cte: string;
  joins: string;
  where: string;
  bindings: unknown[];
}

export const MEDIA_DEFAULT_ORDER = "media.captured_date IS NULL, media.captured_date, media.filename";

const DESCENDANT_FOLDERS_CTE = `WITH RECURSIVE descendant_folders(id) AS (
  SELECT id FROM folders WHERE id = ? AND status = 'active'
  UNION ALL
  SELECT f.id FROM folders f JOIN descendant_folders d ON f.parent_id = d.id WHERE f.status = 'active'
)`;

const EXIF_KEYS: (keyof ExifFilterQuery)[] = [
  "lens", "camera", "make", "apertureMin", "apertureMax", "isoMin", "isoMax", "focalMin", "focalMax", "year", "from", "to",
];

export function hasExifFilter(exif: ExifFilterQuery | undefined): boolean {
  return !!exif && EXIF_KEYS.some((k) => exif[k] !== undefined);
}

// The one place media-listing WHERE clauses are assembled. Every clause is
// qualified with `media.` so joins (media_engagement, media_exif) never make
// a column ambiguous. Bindings are emitted in SQL order: CTE first, then WHERE.
export function buildMediaQuery(p: MediaQueryParams): BuiltMediaQuery {
  const cteBindings: unknown[] = [];
  const bindings: unknown[] = [];
  const where: string[] = [p.includeMarked
    ? "(media.status = 'active' OR media.id IN (SELECT media_id FROM deletion_marks))"
    : "media.status = 'active'", ACTIVE_SOURCE_SQL];
  const joins: string[] = [];
  let cte = "";

  const scope = p.scope;
  if (scope?.kind === "folder") {
    if (scope.recursive) {
      cte = DESCENDANT_FOLDERS_CTE;
      cteBindings.push(scope.folderId);
      where.push("media.parent_folder_id IN (SELECT id FROM descendant_folders)");
    } else {
      where.push("media.parent_folder_id = ?");
      bindings.push(scope.folderId);
    }
  } else if (scope?.kind === "scanRoot") {
    where.push("media.scan_root_id = ?");
    bindings.push(scope.scanRootId);
  } else if (scope?.kind === "ids") {
    if (scope.ids.length === 0) where.push("0=1");
    else {
      where.push(`media.id IN (${scope.ids.map(() => "?").join(",")})`);
      bindings.push(...scope.ids);
    }
  }

  if (!p.includeCompanions) where.push(EXCLUDE_LIVE_PHOTO_VIDEOS, EXCLUDE_PAIRED_RAW);
  if (!p.includeMarked) where.push(UNMARKED_MEDIA_SQL);
  if (p.type && p.type !== "all") where.push(mediaTypeFilterClause(p.type));
  if (p.thumbnailDone) where.push("media.thumbnail_status = 'done'");
  if (p.collapseStacks) where.push(COLLAPSE_STACKS);
  if (p.personIds && p.personIds.length > 0) {
    where.push(`media.id IN (SELECT f.media_id FROM faces f WHERE f.person_id IN (${p.personIds.map(() => "?").join(",")}))`);
    bindings.push(...p.personIds);
  }
  if (p.tagId !== undefined) {
    where.push("EXISTS (SELECT 1 FROM media_tags mt WHERE mt.media_id = media.id AND mt.tag_id = ?)");
    bindings.push(p.tagId);
  }

  if (p.favoritesOnly) {
    joins.push("JOIN media_engagement me ON me.media_id = media.id");
    where.push("me.favorite = 1");
  }

  const exif = p.exif;
  if (p.requireExifJoin || hasExifFilter(exif)) {
    joins.push("JOIN media_exif mx ON mx.media_id = media.id");
  }
  if (exif) {
    const eq = (col: string, v: string | undefined) => {
      if (v !== undefined) {
        where.push(`${col} = ?`);
        bindings.push(v);
      }
    };
    const ge = (col: string, v: number | undefined) => {
      if (v !== undefined) {
        where.push(`${col} >= ?`);
        bindings.push(v);
      }
    };
    const le = (col: string, v: number | undefined) => {
      if (v !== undefined) {
        where.push(`${col} <= ?`);
        bindings.push(v);
      }
    };
    eq("mx.lens_id", exif.lens);
    eq("mx.camera_model", exif.camera);
    eq("mx.camera_make", exif.make);
    ge("mx.aperture", exif.apertureMin);
    le("mx.aperture", exif.apertureMax);
    ge("mx.iso", exif.isoMin);
    le("mx.iso", exif.isoMax);
    ge("mx.focal_length", exif.focalMin);
    le("mx.focal_length", exif.focalMax);
    if (exif.year !== undefined) {
      where.push("substr(mx.captured_at_precise, 1, 4) = ?");
      bindings.push(String(exif.year));
    }
    if (exif.from !== undefined) {
      where.push("mx.captured_at_precise >= ?");
      bindings.push(`${exif.from}T00:00:00.000`);
    }
    if (exif.to !== undefined) {
      where.push("mx.captured_at_precise <= ?");
      bindings.push(`${exif.to}T23:59:59.999`);
    }
  }

  return { cte, joins: joins.join(" "), where: where.join(" AND "), bindings: [...cteBindings, ...bindings] };
}

export function mediaSelectSql(q: BuiltMediaQuery, orderBy: string = MEDIA_DEFAULT_ORDER): string {
  return `${q.cte} SELECT media.* FROM media ${q.joins} WHERE ${q.where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
}

export function mediaCountSql(q: BuiltMediaQuery): string {
  return `${q.cte} SELECT COUNT(*) as c FROM media ${q.joins} WHERE ${q.where}`;
}
