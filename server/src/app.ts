import fs from "node:fs";
import Fastify, { type FastifyInstance, type FastifyError } from "fastify";
import fastifyStatic from "@fastify/static";
import type { AppContext } from "./context.js";
import { registerAuthPlugin } from "./plugins/auth-plugin.js";
import { registerAuthRoutes } from "./api/auth-routes.js";
import { registerSettingsRoutes } from "./api/settings-routes.js";
import { registerScanRootRoutes } from "./api/scan-roots-routes.js";
import { registerScanRoutes } from "./api/scans-routes.js";
import { registerFolderRoutes } from "./api/folders-routes.js";
import { registerMediaRoutes } from "./api/media-routes.js";
import { registerSearchRoutes } from "./api/search-routes.js";
import { registerMemoriesRoutes } from "./api/memories-routes.js";
import { registerHomeRoutes } from "./api/home-routes.js";
import { registerFavoritesRoutes } from "./api/favorites-routes.js";
import { registerIgnoredPathsRoutes } from "./api/ignored-paths-routes.js";
import { registerVideoTranscodeRoutes } from "./api/video-transcode-routes.js";
import { registerAnalysisRoutes } from "./api/analysis-routes.js";
import { registerReportsRoutes } from "./api/reports-routes.js";
import { registerGearRoutes } from "./api/gear-routes.js";
import { registerStackRoutes } from "./api/stacks-routes.js";
import { registerSimilarRoutes } from "./api/similar-routes.js";
import { registerPersonRoutes } from "./api/persons-routes.js";
import { registerPluginRoutes } from "./plugins/plugin-routes.js";
import { registerCleanupRoutes } from "./api/cleanup-routes.js";
import { registerTagRoutes } from "./api/tags-routes.js";
import { registerLocationRoutes } from "./api/location-routes.js";
import { registerCoreUpdateRoutes } from "./api/core-update-routes.js";

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const isProd = process.env.NODE_ENV === "production";

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      transport: isProd ? undefined : { target: "pino-pretty", options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" } },
    },
    trustProxy: false,
  });

  // Never leak stack traces / internal error details to clients (spec section 25).
  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error }, "Unhandled request error");
    const statusCode = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    reply.code(statusCode).send({ error: statusCode < 500 ? error.message : "Internal server error" });
  });

  await registerAuthPlugin(app, ctx);

  await registerAuthRoutes(app, ctx);
  await registerSettingsRoutes(app, ctx);
  await registerCoreUpdateRoutes(app);
  await registerPluginRoutes(app, ctx);
  await registerScanRootRoutes(app, ctx);
  await registerScanRoutes(app, ctx);
  await registerFolderRoutes(app, ctx);
  await registerMediaRoutes(app, ctx);
  await registerCleanupRoutes(app, ctx);
  await registerTagRoutes(app, ctx);
  await registerLocationRoutes(app, ctx);
  await registerSearchRoutes(app, ctx);
  await registerMemoriesRoutes(app, ctx);
  await registerHomeRoutes(app, ctx);
  await registerFavoritesRoutes(app, ctx);
  await registerIgnoredPathsRoutes(app, ctx);
  await registerVideoTranscodeRoutes(app, ctx);
  await registerAnalysisRoutes(app, ctx);
  await registerReportsRoutes(app, ctx);
  await registerGearRoutes(app, ctx);
  await registerStackRoutes(app, ctx);
  await registerSimilarRoutes(app, ctx);
  await registerPersonRoutes(app, ctx);

  // Serve the built client as static assets, with an SPA fallback to index.html
  // for any non-API route (client-side React Router handles the rest).
  if (fs.existsSync(ctx.paths.clientDistDir)) {
    await app.register(fastifyStatic, {
      root: ctx.paths.clientDistDir,
      index: "index.html",
    });

    app.setNotFoundHandler((request, reply) => {
      if (request.raw.url?.startsWith("/api/")) {
        return reply.code(404).send({ error: "Not found" });
      }
      return reply.sendFile("index.html", ctx.paths.clientDistDir);
    });
  } else {
    app.log.warn(
      { expected: ctx.paths.clientDistDir },
      "Client build not found - run `npm run build --workspace=client` (or use `npm run dev:client` in development)",
    );
  }

  return app;
}
