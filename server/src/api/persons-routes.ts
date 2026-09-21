import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  renamePersonRequestSchema,
  hidePersonRequestSchema,
  mergePersonsRequestSchema,
  assignFaceRequestSchema,
  rejectFaceRequestSchema,
  personFacesQuerySchema,
  personsListQuerySchema,
  type PersonDetailDto,
} from "@memorylane/shared";
import type { AppContext } from "../context.js";
import { PersonError } from "../persons/person-service.js";
import { SettingsRepo } from "../db/settings-repo.js";
import { faceCropPath } from "../config/paths.js";
import { renderAnalysisJpeg } from "../media/analysis-input.js";
import { streamFile } from "./file-streaming.js";
import type { MediaRow } from "./mappers.js";
import { isMediaSourceVisible } from "../plugins/registry.js";

const PEOPLE_OFF = "People is turned off - enable it under Settings › People";
const CROP_SIZE = 160;
const CROP_PADDING = 0.3;

async function withPersonErrors<T>(reply: FastifyReply, fn: () => T | Promise<T>): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PersonError) return reply.code(err.status).send({ error: err.message });
    throw err;
  }
}

export async function registerPersonRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { persons } = ctx;
  const settings = new SettingsRepo(ctx.db);
  const idParam = (request: { params: unknown }, key = "id") => Number((request.params as Record<string, string>)[key]);

  // Every people/face endpoint is gated on the opt-in - nothing leaks while off.
  const requirePeople = async (_request: unknown, reply: FastifyReply) => {
    if (!settings.getAll().personsEnabled) return reply.code(404).send({ error: PEOPLE_OFF });
  };
  const guards = { preHandler: [app.requireAuth, requirePeople] };

  app.get("/api/persons", guards, async (request, reply) => {
    const parsed = personsListQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid query" });
    return reply.send(persons.listPersons(parsed.data.includeHidden));
  });

  app.get("/api/persons/:id", guards, async (request, reply) => {
    const person = persons.getPerson(idParam(request));
    if (!person) return reply.code(404).send({ error: "Person not found" });
    const dto: PersonDetailDto = { person, faces: persons.listFaces(person.id, 60, 0) };
    return reply.send(dto);
  });

  app.get("/api/persons/:id/faces", guards, async (request, reply) => {
    const parsed = personFacesQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid query" });
    if (!persons.getPerson(idParam(request))) return reply.code(404).send({ error: "Person not found" });
    return reply.send(persons.listFaces(idParam(request), parsed.data.limit, parsed.data.offset));
  });

  app.patch("/api/persons/:id", guards, async (request, reply) => {
    const body = request.body as Record<string, unknown> | undefined;
    const rename = renamePersonRequestSchema.safeParse(body);
    const hide = hidePersonRequestSchema.safeParse(body);
    if (!rename.success && !hide.success) return reply.code(400).send({ error: "Invalid input" });
    return withPersonErrors(reply, () => {
      const id = idParam(request);
      let person = persons.getPerson(id);
      if (!person) throw new PersonError(404, "Person not found");
      if (rename.success) person = persons.rename(id, rename.data.name);
      if (hide.success) person = persons.setHidden(id, hide.data.hidden);
      return reply.send(person);
    });
  });

  app.post("/api/persons/:id/merge", guards, async (request, reply) => {
    const parsed = mergePersonsRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    return withPersonErrors(reply, () => reply.send(persons.merge(idParam(request), parsed.data.personId)));
  });

  app.delete("/api/persons/:id", guards, async (request, reply) => {
    return withPersonErrors(reply, () => {
      persons.dismiss(idParam(request));
      return reply.code(204).send();
    });
  });

  app.post("/api/persons/discover", guards, async (_request, reply) => {
    return reply.send(await persons.discover());
  });

  app.post("/api/persons/regroup", guards, async (_request, reply) => {
    return reply.send(await persons.regroup());
  });

  app.delete("/api/persons/data", { preHandler: app.requireAuth }, async (_request, reply) => {
    await persons.deleteAllFaceData();
    return reply.code(204).send();
  });

  app.get("/api/media/:id/faces", guards, async (request, reply) => {
    if (!isMediaSourceVisible(ctx.db, idParam(request))) return reply.code(404).send({ error: "Media not found" });
    return reply.send(persons.facesForMedia(idParam(request)));
  });

  app.post("/api/faces/:id/assign", guards, async (request, reply) => {
    const parsed = assignFaceRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    if (!persons.getFace(idParam(request))) return reply.code(404).send({ error: "Face not found" });
    return withPersonErrors(reply, () => reply.send(persons.assignFace(idParam(request), parsed.data.personId)));
  });

  app.post("/api/faces/:id/reject", guards, async (request, reply) => {
    const parsed = rejectFaceRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    if (!persons.getFace(idParam(request))) return reply.code(404).send({ error: "Face not found" });
    return withPersonErrors(reply, () => reply.send(persons.rejectFace(idParam(request), parsed.data.personId)));
  });

  // Square crop around the face with padding, rendered from the same 1600px
  // image the detector saw, cached on disk like thumbnails.
  app.get("/api/faces/:id/crop", guards, async (request, reply) => {
    const face = persons.getFace(idParam(request));
    if (!face) return reply.code(404).send({ error: "Face not found" });
    const cropPath = faceCropPath(ctx.paths.facesDir, face.id);
    if (!fs.existsSync(cropPath)) {
      const media = ctx.db.prepare("SELECT * FROM media WHERE id = ?").get(face.media_id) as MediaRow | undefined;
      if (!media) return reply.code(404).send({ error: "Media not found" });
      const source = await renderAnalysisJpeg(ctx.paths, {
        id: media.id, parent_folder_id: media.parent_folder_id, absolute_path: media.absolute_path, media_type: media.media_type as "image" | "raw" | "video",
      });
      if (!source) return reply.code(404).send({ error: "Source image not available" });
      const meta = await sharp(source).metadata();
      const W = meta.width ?? 0, H = meta.height ?? 0;
      const side = Math.max(face.bbox_w * W, face.bbox_h * H) * (1 + 2 * CROP_PADDING);
      const cx = (face.bbox_x + face.bbox_w / 2) * W, cy = (face.bbox_y + face.bbox_h / 2) * H;
      const left = Math.max(0, Math.round(cx - side / 2)), top = Math.max(0, Math.round(cy - side / 2));
      const width = Math.min(W - left, Math.round(side)), height = Math.min(H - top, Math.round(side));
      fs.mkdirSync(path.dirname(cropPath), { recursive: true });
      await sharp(source).extract({ left, top, width, height }).resize(CROP_SIZE, CROP_SIZE, { fit: "cover" }).jpeg({ quality: 85 }).toFile(cropPath);
    }
    reply.header("Cache-Control", "private, no-store");
    return streamFile(request, reply, cropPath, "image/jpeg");
  });
}
