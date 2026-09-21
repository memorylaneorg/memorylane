import type { FastifyInstance } from "fastify";
import { runScanRequestSchema } from "@memorylane/shared";
import type { AppContext } from "../context.js";

export async function registerScanRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { scanner, db } = ctx;

  app.post("/api/scans/run", { preHandler: app.requireAuth }, async (request, reply) => {
    const parsed = runScanRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid input" });
    }
    const { scanRootId } = parsed.data;

    if (scanRootId !== undefined) {
      const root = db.prepare("SELECT enabled FROM scan_roots WHERE id = ?").get(scanRootId) as
        | { enabled: number }
        | undefined;
      if (!root) return reply.code(404).send({ error: "Scan root not found" });
      if (!root.enabled) return reply.code(400).send({ error: "Scan root is disabled" });
    }

    if (scanner.isRunning()) {
      return reply.code(409).send({ error: "A scan is already running" });
    }

    // Fire-and-forget: the scan can take a long time over large libraries, so
    // the client polls /api/scans/status rather than holding the connection open.
    scanner.runScan("manual", scanRootId).catch((err) => {
      app.log.error({ err, scanRootId }, "Manual scan failed to start or run");
    });
    return reply.code(202).send({ ok: true });
  });

  app.get("/api/scans/status", { preHandler: app.requireAuth }, async (_request, reply) => {
    return reply.send(scanner.getStatus());
  });

  app.get("/api/scans/history", { preHandler: app.requireAuth }, async (_request, reply) => {
    return reply.send(scanner.getHistory());
  });
}
