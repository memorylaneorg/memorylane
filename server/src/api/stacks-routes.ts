import type { FastifyInstance, FastifyReply } from "fastify";
import {
  createStackRequestSchema,
  setStackCoverRequestSchema,
  splitStackRequestSchema,
  mergeStacksRequestSchema,
  recomputeStacksRequestSchema,
  type StackDetailDto,
} from "@memorylane/shared";
import type { AppContext } from "../context.js";
import { StackError } from "../stacks/stack-service.js";
import { toMediaDto } from "./mappers.js";
import { decorateMedia } from "./decorate-media.js";

// StackService signals validation problems with StackError(status, message);
// anything else is a real failure and falls through to the global handler.
async function withStackErrors<T>(reply: FastifyReply, fn: () => T | Promise<T>): Promise<T | FastifyReply> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StackError) return reply.code(err.status).send({ error: err.message });
    throw err;
  }
}

function idParam(request: { params: unknown }, key: string): number {
  return Number((request.params as Record<string, string>)[key]);
}

export async function registerStackRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { stacks } = ctx;

  app.get("/api/stacks/:id", { preHandler: app.requireAuth }, async (request, reply) => {
    const id = idParam(request, "id");
    const stack = stacks.getStack(id);
    if (!stack) return reply.code(404).send({ error: "Stack not found" });
    const items = decorateMedia(ctx, stacks.getMembers(id).map(toMediaDto));
    const dto: StackDetailDto = { stack, items };
    return reply.send(dto);
  });

  app.post("/api/stacks", { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = createStackRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    return withStackErrors(reply, () => reply.code(201).send(stacks.createManual(parsed.data.mediaIds)));
  });

  app.post("/api/stacks/:id/cover", { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = setStackCoverRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    return withStackErrors(reply, () => reply.send(stacks.setCover(idParam(request, "id"), parsed.data.mediaId)));
  });

  app.post("/api/stacks/:id/split", { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = splitStackRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    return withStackErrors(reply, () => reply.send(stacks.split(idParam(request, "id"), parsed.data.mediaIds)));
  });

  app.post("/api/stacks/:id/merge", { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = mergeStacksRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    return withStackErrors(reply, () => reply.send(stacks.merge(idParam(request, "id"), parsed.data.stackId)));
  });

  app.delete("/api/stacks/:id/members/:mediaId", { preHandler: app.requireAuth }, async (request, reply) => {
    return withStackErrors(reply, () =>
      reply.send({ stack: stacks.removeMember(idParam(request, "id"), idParam(request, "mediaId")) }),
    );
  });

  app.delete("/api/stacks/:id", { preHandler: app.requireAuth }, async (request, reply) => {
    return withStackErrors(reply, () => {
      stacks.deleteStack(idParam(request, "id"));
      return reply.code(204).send();
    });
  });

  // Explicit request: recompute right away (per-folder work is a few
  // milliseconds of SQL) rather than waiting for the analysis queue to
  // drain, which can be a long time during a backfill.
  app.post("/api/stacks/recompute", { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = recomputeStacksRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    if (parsed.data.folderId !== undefined) stacks.markFolderDirty(parsed.data.folderId);
    else stacks.markAllDirty();
    const folders = stacks.recomputeDirty(Number.MAX_SAFE_INTEGER);
    return reply.send({ folders });
  });
}
