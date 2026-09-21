import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { LocationItemDto } from "@memorylane/shared";
import type { AppContext } from "../context.js";
import { LocationRepo, type LocationPoint } from "../locations/location-repo.js";
import { cellKey, groupCells } from "../locations/location-grid.js";
import { decorateMedia } from "./decorate-media.js";
import { toMediaDto, type MediaRow } from "./mappers.js";

const year = z.coerce.number().int().min(0).max(9999);
const filtersSchema = z.object({
  source: z.enum(["all", "filesystem", "apple"]).default("all"),
  fromYear: year.optional(),
  toYear: year.optional(),
}).refine((value) => value.fromYear === undefined || value.toYear === undefined || value.fromYear <= value.toYear);
const cellsSchema = z.object({
  source: z.enum(["all", "filesystem", "apple"]).default("all"),
  fromYear: year.optional(),
  toYear: year.optional(),
  west: z.coerce.number().finite().min(-180).max(180),
  east: z.coerce.number().finite().min(-180).max(180),
  south: z.coerce.number().finite().min(-90).max(90),
  north: z.coerce.number().finite().min(-90).max(90),
  zoom: z.coerce.number().int().min(0).max(10),
}).refine((value) => value.south <= value.north
  && (value.fromYear === undefined || value.toYear === undefined || value.fromYear <= value.toYear));
const itemsSchema = z.object({
  source: z.enum(["all", "filesystem", "apple"]).default("all"),
  fromYear: year.optional(),
  toYear: year.optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(100),
  west: z.coerce.number().finite().min(-180).max(180).optional(),
  east: z.coerce.number().finite().min(-180).max(180).optional(),
  south: z.coerce.number().finite().min(-90).max(90).optional(),
  north: z.coerce.number().finite().min(-90).max(90).optional(),
}).refine((value) => {
  if (value.fromYear !== undefined && value.toYear !== undefined && value.fromYear > value.toYear) return false;
  const bounds = [value.west, value.east, value.south, value.north];
  if (bounds.some((part) => part !== undefined) && bounds.some((part) => part === undefined)) return false;
  return value.south === undefined || value.north === undefined || value.south <= value.north;
});

function parseKey(raw: string): { key: string; zoom: number } | null {
  const parts = raw.split(":").map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isSafeInteger(part))) return null;
  const [zoom, x, y] = parts;
  const n = 32 * 2 ** zoom;
  if (zoom < 0 || zoom > 10 || x < 0 || x >= n || y < 0 || y >= n) return null;
  return { key: `${zoom}:${x}:${y}`, zoom };
}

export async function registerLocationRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const repo = new LocationRepo(ctx.db);

  app.get("/api/locations/summary", { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = filtersSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid location filters" });
    return reply.send(repo.summary(parsed.data));
  });

  app.get("/api/locations/cells", { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = cellsSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid map viewport" });
    const { source, fromYear, toYear, west, east, south, north, zoom } = parsed.data;
    const items = groupCells(repo.points({ source, fromYear, toYear }, { west, east, south, north }), zoom);
    return reply.send({ total: items.reduce((sum, item) => sum + item.count, 0), items });
  });

  app.get("/api/locations/cells/:key/items", { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = itemsSchema.safeParse(request.query);
    const cell = parseKey((request.params as { key: string }).key);
    if (!parsed.success || !cell) return reply.code(400).send({ error: "Invalid map selection" });
    const { source, fromYear, toYear, offset, limit, west, east, south, north } = parsed.data;
    const bounds = west === undefined || east === undefined || south === undefined || north === undefined
      ? undefined : { west, east, south, north };
    const page: LocationPoint[] = [];
    let total = 0;
    let mediaTotal = 0;
    for (const point of repo.points({ source, fromYear, toYear }, bounds)) {
      if (cellKey(point.lat, point.lon, cell.zoom) !== cell.key) continue;
      if (total >= offset && page.length < limit) page.push(point);
      total++;
      if (point.mediaId !== null) mediaTotal++;
    }
    const mediaIds = page.flatMap((point) => point.mediaId === null ? [] : [point.mediaId]);
    const mediaById = new Map<number, ReturnType<typeof toMediaDto>>();
    if (mediaIds.length > 0) {
      const sql = `SELECT media.* FROM media WHERE media.id IN (${mediaIds.map(() => "?").join(",")})`;
      const rows = ctx.db.prepare(sql).all(...mediaIds) as MediaRow[];
      for (const media of decorateMedia(ctx, rows.map(toMediaDto))) mediaById.set(media.id, media);
    }
    const items = page.flatMap<LocationItemDto>((point): LocationItemDto[] => {
      const media = point.mediaId === null ? null : mediaById.get(point.mediaId);
      if (media) return [{ kind: "media" as const, media, lat: point.lat, lon: point.lon, date: point.date }];
      if (point.source === "apple" && point.rootId !== null && point.uuid !== null) {
        return [{ kind: "apple-catalog" as const, rootId: point.rootId, uuid: point.uuid,
          filename: point.filename, lat: point.lat, lon: point.lon, date: point.date }];
      }
      return [];
    });
    return reply.send({ total, mediaTotal, offset, limit, items });
  });
}
