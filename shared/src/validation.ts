import { z } from "zod";

// Password policy kept simple for a single-admin, self-hosted v1.
export const passwordSchema = z.string().min(8).max(200);
export const usernameSchema = z.string().min(3).max(64).regex(/^[a-zA-Z0-9_.-]+$/);

export const setupRequestSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
});

export const loginRequestSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1).max(200),
});

export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
});

export const createScanRootRequestSchema = z.object({
  path: z.string().min(1).max(4096),
  kind: z.enum(["folder", "apple-photos"]).optional().default("folder"),
});

export const updateScanRootRequestSchema = z.object({
  enabled: z.boolean().optional(),
});

export const moveScanRootRequestSchema = z.object({
  direction: z.enum(["up", "down"]),
});

export const reorderScanRootsRequestSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).refine((ids) => new Set(ids).size === ids.length),
});

export const updateSettingsRequestSchema = z.object({
  archiveTitle: z.string().trim().min(1).max(100).optional(),
  bindAddress: z.string().min(1).max(64).optional(),
  museumServiceEnabled: z.boolean().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  scanIntervalDays: z.number().int().min(1).max(365).nullable().optional(),
  scanScheduleEnabled: z.boolean().optional(),
  stackGapSeconds: z.number().min(0.1).max(60).optional(),
  stackMaxHamming: z.number().int().min(0).max(64).optional(),
  stackMinCosine: z.number().min(0.5).max(1).optional(),
  stackSeriesGapSeconds: z.number().min(0).max(3600).optional(),
  aiEnabled: z.boolean().optional(),
  personsEnabled: z.boolean().optional(),
  faceAssignThreshold: z.number().min(0.3).max(0.9).optional(),
  faceMinClusterSize: z.number().int().min(2).max(20).optional(),
  faceLinkThreshold: z.number().min(0.3).max(0.9).optional(),
  faceModel: z.enum(["yunet-sface", "buffalo_l"]).optional(),
});

export const paginationQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

// z.coerce.boolean() is unsuitable for query strings: Boolean("false") is
// `true` in JS, so "recursive=false" would coerce to true. Parse the literal
// string instead.
const booleanQueryParam = z
  .enum(["true", "false"])
  .optional()
  .transform((v) => v === "true");

// "photo" covers both regular images and RAW - matches the same grouping
// used elsewhere (e.g. ELIGIBLE_MEDIA_FILTER on the server).
export const mediaTypeFilterSchema = z.enum(["all", "photo", "video"]).optional().default("all");
export type MediaTypeFilter = z.infer<typeof mediaTypeFilterSchema>;

export const folderMediaQuerySchema = paginationQuerySchema.extend({
  // When true, includes media from all descendant subfolders, not just this one.
  recursive: booleanQueryParam,
  type: mediaTypeFilterSchema,
  // Folder grids collapse stacks to their cover by default; the stack panel
  // and anything that needs every frame passes expandStacks=true.
  expandStacks: booleanQueryParam,
});

export const favoritesQuerySchema = paginationQuerySchema.extend({
  type: mediaTypeFilterSchema,
});

export const searchQuerySchema = z.object({
  q: z.string().min(1).max(200),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  // "text" = FTS over names/camera/lens; "semantic" = CLIP text->image kNN
  // (needs the AI sidecar, returns media only).
  mode: z.enum(["text", "semantic"]).default("text"),
});
export type SearchMode = z.infer<typeof searchQuerySchema>["mode"];

export const similarQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(48),
});

export const randomMediaQuerySchema = z.object({
  count: z.coerce.number().int().min(1).max(100).default(100),
});

export const runScanRequestSchema = z.object({
  scanRootId: z.number().int().positive().optional(),
});

export const updateFavoriteRequestSchema = z.object({
  favorite: z.boolean(),
});

// "standard" targets a small file (default - see the Settings video
// modernization panel); "high" trades size for extra quality margin on a
// specific clip worth it. Both preserve source resolution/frame rate.
export const videoTranscodeQualitySchema = z.enum(["standard", "high"]);
export type VideoTranscodeQuality = z.infer<typeof videoTranscodeQualitySchema>;

// `all` targets every eligible item in the scan root server-side (everything
// still needing a transcode / already verified, respectively) - not just
// whatever page of the candidate list happens to be loaded client-side, so
// "Transcode All" and "Archive All Verified" work the same whether there are
// 5 candidates or 5,000. `mediaIds` is for the per-row single-item actions.
export const startTranscodeRequestSchema = z
  .object({
    mediaIds: z.array(z.number().int().positive()).min(1).max(500).optional(),
    all: z.boolean().optional(),
    quality: videoTranscodeQualitySchema,
  })
  .refine((v) => v.all || (v.mediaIds && v.mediaIds.length > 0), { message: "mediaIds or all is required" });

export const archiveTranscodedRequestSchema = z
  .object({
    mediaIds: z.array(z.number().int().positive()).min(1).max(500).optional(),
    all: z.boolean().optional(),
  })
  .refine((v) => v.all || (v.mediaIds && v.mediaIds.length > 0), { message: "mediaIds or all is required" });

export const transcodeCandidatesQuerySchema = paginationQuerySchema;

export const retryAnalysisRequestSchema = z.object({
  analyzer: z.string().min(1).max(64).optional(),
});

// EXIF report filters - shared by GET /api/media, /api/reports/facets and
// /api/reports/export.csv so a facet click, the grid, and the CSV all agree.
export const exifFilterQuerySchema = z.object({
  lens: z.string().min(1).max(200).optional(),
  camera: z.string().min(1).max(200).optional(),
  make: z.string().min(1).max(200).optional(),
  apertureMin: z.coerce.number().positive().optional(),
  apertureMax: z.coerce.number().positive().optional(),
  isoMin: z.coerce.number().int().min(0).optional(),
  isoMax: z.coerce.number().int().min(0).optional(),
  focalMin: z.coerce.number().min(0).optional(),
  focalMax: z.coerce.number().min(0).optional(),
  year: z.coerce.number().int().min(1800).max(2200).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type ExifFilterQuery = z.infer<typeof exifFilterQuerySchema>;

// "1,2,3" -> [1, 2, 3]
const idListQueryParam = z
  .string()
  .regex(/^\d+(,\d+)*$/)
  .transform((s) => s.split(",").map(Number))
  .optional();

export const mediaListQuerySchema = paginationQuerySchema.merge(exifFilterQuerySchema).extend({
  type: mediaTypeFilterSchema,
  scanRootId: z.coerce.number().int().positive().optional(),
  // Photos containing any of these persons (People pages).
  personIds: idListQueryParam,
});

export const REPORT_FACET_FIELDS = ["lens", "camera", "make", "aperture", "iso", "focal", "year"] as const;
export type ReportFacetField = (typeof REPORT_FACET_FIELDS)[number];

export const reportFacetsQuerySchema = exifFilterQuerySchema.extend({
  type: mediaTypeFilterSchema,
  scanRootId: z.coerce.number().int().positive().optional(),
});

const mediaIdList = z.array(z.number().int().positive()).max(500);
export const createStackRequestSchema = z.object({ mediaIds: mediaIdList.min(2) });
export const setStackCoverRequestSchema = z.object({ mediaId: z.number().int().positive() });
export const splitStackRequestSchema = z.object({ mediaIds: mediaIdList.min(2) });
export const mergeStacksRequestSchema = z.object({ stackId: z.number().int().positive() });
export const recomputeStacksRequestSchema = z.object({ folderId: z.number().int().positive().optional() });

export const renamePersonRequestSchema = z.object({ name: z.string().trim().min(1).max(80).nullable() });
export const hidePersonRequestSchema = z.object({ hidden: z.boolean() });
export const mergePersonsRequestSchema = z.object({ personId: z.number().int().positive() });
export const assignFaceRequestSchema = z.object({ personId: z.number().int().positive().nullable() });
export const rejectFaceRequestSchema = z.object({ personId: z.number().int().positive() });
export const personFacesQuerySchema = paginationQuerySchema;
export const personsListQuerySchema = z.object({ includeHidden: booleanQueryParam });

export const moveDataDirRequestSchema = z.object({ path: z.string().min(1).max(4096) });

export const markForDeletionRequestSchema = z.object({
  mediaIds: z.array(z.number().int().positive()).min(1).max(200),
});
