import { z } from "zod";

export const CAPABILITY_API_VERSION = 1 as const;

export const CapabilityIdSchema = z.enum([
  "media.metadata", "media.raw-preview", "video.probe", "video.poster", "video.transcode",
  "ai.image-embedding", "ai.text-embedding", "people.faces", "vector.store", "scan.external-source",
]);
export type CapabilityId = z.infer<typeof CapabilityIdSchema>;

const mediaId = z.number().int().positive();
const opaqueSource = z.string().min(16).max(512);
const artifact = z.object({ token: z.string().min(16).max(512), mediaType: z.string().min(1).max(100), bytes: z.number().int().nonnegative() }).strict();
const vector = z.array(z.number().finite()).min(1).max(65_536);

export const MetadataRequestSchema = z.object({ apiVersion: z.literal(CAPABILITY_API_VERSION), mediaId, sourceToken: opaqueSource }).strict();
export const MetadataResultSchema = z.object({
  capturedDate: z.string().datetime().nullable(), width: z.number().int().positive().nullable(), height: z.number().int().positive().nullable(),
  orientation: z.number().int().nullable(), cameraMake: z.string().nullable(), cameraModel: z.string().nullable(), lensModel: z.string().nullable(),
  focalLength: z.number().finite().nullable(), aperture: z.number().finite().nullable(), shutterSpeed: z.string().nullable(), iso: z.number().finite().nullable(),
  rating: z.number().finite().nullable(), gpsLat: z.number().min(-90).max(90).nullable(), gpsLon: z.number().min(-180).max(180).nullable(),
  durationSeconds: z.number().nonnegative().nullable(), codec: z.string().nullable(), audioCodec: z.string().nullable(), contentIdentifier: z.string().nullable(),
  toolVersion: z.string().min(1).max(200), raw: z.record(z.unknown()).optional(),
}).strict();

export const RawPreviewRequestSchema = MetadataRequestSchema;
export const RawPreviewResultSchema = z.object({ preview: artifact.nullable() }).strict();
export const VideoProbeRequestSchema = MetadataRequestSchema;
export const VideoProbeResultSchema = z.object({ width: z.number().int().positive().nullable(), height: z.number().int().positive().nullable(), durationSeconds: z.number().nonnegative().nullable(), codec: z.string().nullable(), audioCodec: z.string().nullable() }).strict();
export const VideoPosterRequestSchema = MetadataRequestSchema.extend({ atSeconds: z.number().nonnegative().optional() }).strict();
export const VideoPosterResultSchema = z.object({ poster: artifact.nullable() }).strict();
export const VideoTranscodeRequestSchema = MetadataRequestSchema.extend({ quality: z.enum(["standard", "high"]), destinationToken: opaqueSource }).strict();
export const VideoTranscodeResultSchema = z.object({ output: artifact, probe: VideoProbeResultSchema }).strict();

export const ImageEmbeddingRequestSchema = z.object({ apiVersion: z.literal(CAPABILITY_API_VERSION), items: z.array(z.object({ mediaId, imageToken: opaqueSource }).strict()).min(1).max(64), model: z.string().min(1).max(200) }).strict();
export const EmbeddingResultSchema = z.object({ model: z.string().min(1).max(200), dimensions: z.number().int().positive(), vectors: z.array(vector).max(64) }).strict();
export const TextEmbeddingRequestSchema = z.object({ apiVersion: z.literal(CAPABILITY_API_VERSION), texts: z.array(z.string().max(20_000)).min(1).max(64), model: z.string().min(1).max(200) }).strict();
export const FaceDetectionRequestSchema = ImageEmbeddingRequestSchema.extend({ model: z.string().min(1).max(200) }).strict();
export const FaceDetectionResultSchema = z.object({ model: z.string(), dimensions: z.number().int().positive(), images: z.array(z.array(z.object({ bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]), landmarks: z.array(z.tuple([z.number(), z.number()])), score: z.number().min(0).max(1), embedding: vector }).strict())).max(64) }).strict();

export const VectorOperationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("upsert"), space: z.string().min(1).max(300), rows: z.array(z.object({ id: z.number().int().positive(), vector }).strict()).min(1).max(1_000) }).strict(),
  z.object({ operation: z.literal("delete"), space: z.string().min(1).max(300), ids: z.array(z.number().int().positive()).min(1).max(1_000) }).strict(),
  z.object({ operation: z.literal("search"), space: z.string().min(1).max(300), vector, limit: z.number().int().min(1).max(1_000), excludeIds: z.array(z.number().int().positive()).max(10_000).default([]) }).strict(),
  z.object({ operation: z.literal("count"), space: z.string().min(1).max(300) }).strict(),
  z.object({ operation: z.literal("rebuild"), space: z.string().min(1).max(300) }).strict(),
]);

export const ExternalScanRequestSchema = z.object({ apiVersion: z.literal(CAPABILITY_API_VERSION), sourceId: z.string().min(1).max(300), cursor: z.string().max(4_096).nullable(), limit: z.number().int().min(1).max(1_000) }).strict();
export const ExternalScanResultSchema = z.object({ items: z.array(z.object({ externalId: z.string().min(1).max(1_000), filename: z.string().min(1).max(1_000), mediaType: z.enum(["image", "raw", "video"]), capturedDate: z.string().datetime().nullable(), sourceToken: opaqueSource }).strict()).max(1_000), nextCursor: z.string().max(4_096).nullable() }).strict();

export const CAPABILITY_CONTRACTS = {
  "media.metadata": { request: MetadataRequestSchema, response: MetadataResultSchema },
  "media.raw-preview": { request: RawPreviewRequestSchema, response: RawPreviewResultSchema },
  "video.probe": { request: VideoProbeRequestSchema, response: VideoProbeResultSchema },
  "video.poster": { request: VideoPosterRequestSchema, response: VideoPosterResultSchema },
  "video.transcode": { request: VideoTranscodeRequestSchema, response: VideoTranscodeResultSchema },
  "ai.image-embedding": { request: ImageEmbeddingRequestSchema, response: EmbeddingResultSchema },
  "ai.text-embedding": { request: TextEmbeddingRequestSchema, response: EmbeddingResultSchema },
  "people.faces": { request: FaceDetectionRequestSchema, response: FaceDetectionResultSchema },
  "vector.store": { request: VectorOperationSchema, response: z.unknown() },
  "scan.external-source": { request: ExternalScanRequestSchema, response: ExternalScanResultSchema },
} as const;
