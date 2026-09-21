import type { FastifyInstance } from "fastify";
import { retryAnalysisRequestSchema } from "@memorylane/shared";
import type { AppContext } from "../context.js";

export async function registerAnalysisRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/api/analysis/status", { preHandler: app.requireAuth }, async (_request, reply) => {
    return reply.send(ctx.analysisWorker.getStatus());
  });

  // Re-queues failed/unsupported rows (all analyzers, or one) - the only
  // way a row that hit MAX_ATTEMPTS runs again.
  app.post("/api/analysis/retry", { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = retryAnalysisRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "Invalid input" });
    return reply.send({ requeued: ctx.analysisWorker.retryFailed(parsed.data.analyzer) });
  });
}
