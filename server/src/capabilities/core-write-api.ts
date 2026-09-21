import type Database from "better-sqlite3";
import { z } from "zod";
import { MetadataResultSchema, type CapabilityId } from "@memorylane/plugin-sdk";
import { EmbeddingRepo } from "../vectors/embedding-repo.js";
import { FaceRepo } from "../persons/face-repo.js";

const MAX_BATCH = 1_000;
const metadataWrite = z.object({ mediaId: z.number().int().positive(), metadata: MetadataResultSchema }).strict();
const embeddingWrite = z.object({ model: z.string().min(1).max(200), dimensions: z.number().int().positive(), items: z.array(z.object({ mediaId: z.number().int().positive(), vector: z.array(z.number().finite()).min(1).max(65_536) }).strict()).min(1).max(MAX_BATCH) }).strict();
const faceWrite = z.object({ mediaId: z.number().int().positive(), model: z.string().min(1).max(200), faces: z.array(z.object({ bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]), landmarks: z.array(z.tuple([z.number(), z.number()])), score: z.number().min(0).max(1), embedding: z.array(z.number().finite()).min(1).max(65_536) }).strict()).max(MAX_BATCH) }).strict();

export type CapabilityOwnership = ReadonlyMap<string, ReadonlySet<CapabilityId>>;

export class CorePluginWriteApi {
  constructor(private db: Database.Database, private ownership: CapabilityOwnership) {}

  writeMetadata(pluginId: string, input: unknown): void {
    this.require(pluginId, "media.metadata");
    const { mediaId, metadata: m } = metadataWrite.parse(input);
    this.requireMedia([mediaId]);
    this.db.prepare(`UPDATE media SET captured_date=?, width=?, height=?, orientation=?, camera_make=?, camera_model=?, lens_model=?, focal_length=?, aperture=?, shutter_speed=?, iso=?, rating=?, gps_lat=?, gps_lon=?, duration_seconds=?, codec=?, audio_codec=?, content_identifier=? WHERE id=?`)
      .run(m.capturedDate, m.width, m.height, m.orientation, m.cameraMake, m.cameraModel, m.lensModel, m.focalLength, m.aperture, m.shutterSpeed, m.iso, m.rating, m.gpsLat, m.gpsLon, m.durationSeconds, m.codec, m.audioCodec, m.contentIdentifier, mediaId);
  }

  writeEmbeddings(pluginId: string, input: unknown): void {
    this.require(pluginId, "ai.image-embedding");
    const parsed = embeddingWrite.parse(input);
    if (parsed.items.some((item) => item.vector.length !== parsed.dimensions)) throw new Error("Embedding dimension mismatch");
    this.requireMedia(parsed.items.map((item) => item.mediaId));
    new EmbeddingRepo(this.db).upsertMany(parsed.model, parsed.items.map((item) => ({ mediaId: item.mediaId, vector: Float32Array.from(item.vector) })));
  }

  writeFaces(pluginId: string, input: unknown): number[] {
    this.require(pluginId, "people.faces");
    const parsed = faceWrite.parse(input);
    this.requireMedia([parsed.mediaId]);
    const dimensions = parsed.faces[0]?.embedding.length;
    if (dimensions && parsed.faces.some((face) => face.embedding.length !== dimensions)) throw new Error("Face embedding dimension mismatch");
    return new FaceRepo(this.db).replaceForMedia(parsed.mediaId, parsed.model, parsed.faces.map((face) => ({ bbox: face.bbox, landmarks: face.landmarks, detScore: face.score, embedding: Float32Array.from(face.embedding) }))).ids;
  }

  private require(pluginId: string, capability: CapabilityId): void {
    if (!this.ownership.get(pluginId)?.has(capability)) throw new Error(`Plugin ${pluginId} does not own ${capability}`);
  }

  private requireMedia(ids: number[]): void {
    const unique = [...new Set(ids)];
    if (unique.length === 0 || unique.length > MAX_BATCH) throw new Error("Invalid media batch size");
    const placeholders = unique.map(() => "?").join(",");
    const count = (this.db.prepare(`SELECT COUNT(*) AS n FROM media WHERE status='active' AND id IN (${placeholders})`).get(...unique) as { n: number }).n;
    if (count !== unique.length) throw new Error("One or more media IDs are missing or inactive");
  }
}
