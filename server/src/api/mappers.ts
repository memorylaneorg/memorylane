import type {
  FolderDto,
  MediaDto,
  MediaType,
  ThumbnailStatus,
  MediaStatus,
  TranscodeJobDto,
  TranscodeJobStatus,
  VideoTranscodeQuality,
} from "@memorylane/shared";

// Listing fragments live with the query builder now - re-exported here so
// existing importers (engagement-repo, video-compatibility) keep working.
export { EXCLUDE_LIVE_PHOTO_VIDEOS, EXCLUDE_PAIRED_RAW, mediaTypeFilterClause } from "../query/media-query.js";

export interface FolderRow {
  id: number;
  scan_root_id: number;
  parent_id: number | null;
  name: string;
  absolute_path: string;
  created_at: string;
  updated_at: string;
}

export interface FolderCounts {
  mediaCount: number;
  childFolderCount: number;
  thumbnailMediaId: number | null;
  thumbnailVersion: number;
  recursiveMediaCount: number;
  recursiveSizeBytes: number;
}

export function toFolderDto(row: FolderRow, counts: FolderCounts): FolderDto {
  return {
    id: row.id,
    scanRootId: row.scan_root_id,
    parentId: row.parent_id,
    name: row.name,
    absolutePath: row.absolute_path,
    mediaCount: counts.mediaCount,
    childFolderCount: counts.childFolderCount,
    thumbnailMediaId: counts.thumbnailMediaId,
    thumbnailVersion: counts.thumbnailVersion,
    recursiveMediaCount: counts.recursiveMediaCount,
    recursiveSizeBytes: counts.recursiveSizeBytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface MediaRow {
  id: number;
  parent_folder_id: number;
  scan_root_id: number;
  absolute_path: string;
  filename: string;
  extension: string;
  media_type: string;
  file_size: number;
  fs_created_at: string | null;
  fs_modified_at: string;
  captured_date: string | null;
  width: number | null;
  height: number | null;
  orientation: number | null;
  thumbnail_status: string;
  thumbnail_version: number;
  status: string;
  camera_make: string | null;
  camera_model: string | null;
  lens_model: string | null;
  focal_length: number | null;
  aperture: number | null;
  shutter_speed: string | null;
  iso: number | null;
  rating: number | null;
  gps_lat: number | null;
  gps_lon: number | null;
  duration_seconds: number | null;
  codec: string | null;
  audio_codec: string | null;
  live_photo_video_id: number | null;
  raw_pair_id: number | null;
  source_kind: "apple-photos" | null;
  original_available: number;
}

export function toMediaDto(row: MediaRow): MediaDto {
  return {
    id: row.id,
    parentFolderId: row.parent_folder_id,
    scanRootId: row.scan_root_id,
    filename: row.filename,
    absolutePath: row.absolute_path,
    extension: row.extension,
    mediaType: row.media_type as MediaType,
    fileSize: row.file_size,
    fsCreatedAt: row.fs_created_at,
    fsModifiedAt: row.fs_modified_at,
    capturedDate: row.captured_date,
    width: row.width,
    height: row.height,
    orientation: row.orientation,
    thumbnailStatus: row.thumbnail_status as ThumbnailStatus,
    thumbnailVersion: row.thumbnail_version,
    status: row.status as MediaStatus,
    cameraMake: row.camera_make,
    cameraModel: row.camera_model,
    lensModel: row.lens_model,
    focalLength: row.focal_length,
    aperture: row.aperture,
    shutterSpeed: row.shutter_speed,
    iso: row.iso,
    rating: row.rating,
    gpsLat: row.gps_lat,
    gpsLon: row.gps_lon,
    durationSeconds: row.duration_seconds,
    codec: row.codec,
    audioCodec: row.audio_codec,
    livePhotoVideoId: row.live_photo_video_id,
    rawPairId: row.raw_pair_id,
    sourceKind: row.source_kind,
    originalAvailable: row.original_available === 1,
    // Populated by EngagementRepo.attachFavorites() at the route level - see
    // db/engagement-repo.ts. Defaults false here since not every call site
    // needs it (or has fetched it yet).
    favorite: false,
    // Populated by decorateMedia() (api/decorate-media.ts) alongside favorites.
    stack: null,
  };
}

export interface TranscodeJobRow {
  id: number;
  media_id: number;
  status: string;
  quality: string;
  error: string | null;
  original_duration_seconds: number | null;
  output_duration_seconds: number | null;
  original_size_bytes: number | null;
  output_size_bytes: number | null;
  verified: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export function toTranscodeJobDto(row: TranscodeJobRow): TranscodeJobDto {
  return {
    mediaId: row.media_id,
    status: row.status as TranscodeJobStatus,
    quality: row.quality as VideoTranscodeQuality,
    error: row.error,
    originalDurationSeconds: row.original_duration_seconds,
    outputDurationSeconds: row.output_duration_seconds,
    originalSizeBytes: row.original_size_bytes,
    outputSizeBytes: row.output_size_bytes,
    verified: row.verified === 1,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}
