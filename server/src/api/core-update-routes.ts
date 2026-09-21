import type { FastifyInstance } from "fastify";
import type { CoreUpdateDto } from "@memorylane/shared";
import { APP_VERSION } from "../version.js";

const unavailable = (): CoreUpdateDto => ({
  state: "unavailable", currentVersion: APP_VERSION, availableVersion: null, message: null,
});

async function trayRequest(path: string, method = "GET"): Promise<CoreUpdateDto> {
  const base = process.env.MEMORYLANE_DESKTOP_CONTROL_URL;
  const token = process.env.MEMORYLANE_DESKTOP_TOKEN;
  if (!base || !token) return unavailable();
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "x-memorylane-desktop-token": token },
    signal: AbortSignal.timeout(35_000),
  });
  if (!response.ok) throw new Error(`Desktop updater returned ${response.status}`);
  const raw = await response.json() as Partial<CoreUpdateDto>;
  const states = new Set(["unavailable", "idle", "checking", "current", "downloading", "ready", "error"]);
  if (!raw.state || !states.has(raw.state) || typeof raw.currentVersion !== "string") throw new Error("Desktop updater returned an invalid status");
  return {
    state: raw.state as CoreUpdateDto["state"],
    currentVersion: raw.currentVersion,
    availableVersion: typeof raw.availableVersion === "string" ? raw.availableVersion : null,
    message: typeof raw.message === "string" ? raw.message : null,
  };
}

export async function registerCoreUpdateRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/core-update", { preHandler: app.requireAuth }, async (_request, reply) => {
    try { return reply.send(await trayRequest("/status")); }
    catch { return reply.code(503).send({ error: "Desktop updater is unavailable" }); }
  });
  app.post("/api/core-update/check", { preHandler: app.requireAuth }, async (_request, reply) => {
    try { return reply.code(202).send(await trayRequest("/check", "POST")); }
    catch { return reply.code(503).send({ error: "Could not start the core update check" }); }
  });
  app.post("/api/core-update/install", { preHandler: app.requireAuth }, async (_request, reply) => {
    try { return reply.code(202).send(await trayRequest("/install", "POST")); }
    catch { return reply.code(409).send({ error: "The core update is not ready to install" }); }
  });
}
