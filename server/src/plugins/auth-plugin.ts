import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import type { AppContext } from "../context.js";
import { SESSION_COOKIE_NAME, SESSION_TTL_SECONDS } from "../auth/sessions.js";

declare module "fastify" {
  interface FastifyRequest {
    userId: number | null;
  }
  interface FastifyInstance {
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    setSessionCookie: (reply: FastifyReply, sessionId: string) => void;
    clearSessionCookie: (reply: FastifyReply) => void;
  }
}

export async function registerAuthPlugin(app: FastifyInstance, ctx: AppContext): Promise<void> {
  await app.register(cookie);

  app.decorateRequest("userId", null);

  app.addHook("onRequest", async (request) => {
    const sessionId = request.cookies[SESSION_COOKIE_NAME];
    if (!sessionId) {
      request.userId = null;
      return;
    }
    request.userId = ctx.sessions.touch(sessionId);
  });

  app.decorate("requireAuth", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.userId) {
      reply.code(401).send({ error: "Not authenticated" });
    }
  });

  app.decorate("setSessionCookie", (reply: FastifyReply, sessionId: string) => {
    reply.setCookie(SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      sameSite: "lax",
      // MemoryLane never serves HTTPS (self-signed certs aren't worth the
      // setup friction for a self-hosted LAN app), so a Secure cookie would
      // just never be sent back by the browser on any non-localhost origin -
      // silently breaking login for every LAN client, not adding real
      // protection. Revisit if/when real TLS termination is supported.
      secure: false,
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    });
  });

  app.decorate("clearSessionCookie", (reply: FastifyReply) => {
    reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
  });
}
