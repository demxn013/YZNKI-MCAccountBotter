/* AFK Core main entrypoint
 * Lightweight HTTP API around minecraft-protocol sessions.
 */

"use strict";

const path = require("path");
const Fastify = require("fastify");

const { SessionManager } = require("./session/SessionManager");
const { FileTokenAuthProvider } = require("./auth/FileTokenAuthProvider");
const { DefaultProfile } = require("./profile/DefaultProfile");
const { DonutSmpProfile } = require("./profile/DonutSmpProfile");
const { FreshSmpProfile } = require("./profile/FreshSmpProfile");
const { HypixelProfile } = require("./profile/HypixelProfile");
const { buildMetricsSnapshot } = require("./metrics/metrics");

const fastify = Fastify({
  logger: true,
});

// Where to look for existing Microsoft auth cache / tokens.
const DEFAULT_TOKENS_DIR = path.join(__dirname, "..", "..", "tokens");

const authProvider = new FileTokenAuthProvider({
  tokensDir: process.env.TOKENS_DIR || DEFAULT_TOKENS_DIR,
});

const profiles = {
  default: new DefaultProfile(),
  donutsmp: new DonutSmpProfile(),
  freshsmp: new FreshSmpProfile(),
  hypixel: new HypixelProfile(),
};

const sessionManager = new SessionManager({ authProvider, profiles });

// Simple body validation helper
function requireFields(obj, fields) {
  const missing = [];
  for (const field of fields) {
    if (obj[field] === undefined || obj[field] === null || obj[field] === "") {
      missing.push(field);
    }
  }
  return missing;
}

// POST /session/start
fastify.post("/session/start", async (request, reply) => {
  const body = request.body || {};
  const required = ["sessionId", "minecraftUser", "serverHost"];
  const missing = requireFields(body, required);

  if (missing.length > 0) {
    return reply.code(400).send({
      success: false,
      reason: "validation_error",
      missing,
    });
  }

  const profileKey = body.profile || "default";
  const profile = profiles[profileKey];
  if (!profile) {
    return reply.code(400).send({
      success: false,
      reason: "unknown_profile",
      profile: profileKey,
    });
  }

  const result = await sessionManager.startSession({
    sessionId: String(body.sessionId),
    minecraftUser: String(body.minecraftUser),
    serverHost: String(body.serverHost),
    serverPort: body.serverPort ? Number(body.serverPort) : 25565,
    version: body.version ? String(body.version) : "1.20.1",
    profile,
    authHandle:
      body.authHandle || {
        type: "minecraftUser",
        value: String(body.minecraftUser),
      },
  });

  if (!result.success) {
    const statusCode =
      result.reason === "session_exists"
        ? 409
        : result.reason === "capacity_reached"
        ? 503
        : 400;

    return reply.code(statusCode).send(result);
  }

  return reply.send({
    success: true,
    sessionId: body.sessionId,
    status: result.status,
    profile: profile.id,
  });
});

// POST /session/stop
fastify.post("/session/stop", async (request, reply) => {
  const body = request.body || {};
  const required = ["sessionId"];
  const missing = requireFields(body, required);

  if (missing.length > 0) {
    return reply.code(400).send({
      success: false,
      reason: "validation_error",
      missing,
    });
  }

  const result = sessionManager.stopSession(String(body.sessionId));
  if (!result.success) {
    return reply.code(404).send(result);
  }

  return reply.send(result);
});

// GET /session/:id/status
fastify.get("/session/:id/status", async (request, reply) => {
  const { id } = request.params;
  const status = sessionManager.getStatus(String(id));
  if (!status) {
    return reply.code(404).send({
      success: false,
      reason: "not_found",
      sessionId: id,
    });
  }

  return reply.send(status);
});

// GET /session
fastify.get("/session", async (_request, reply) => {
  const list = sessionManager.list();
  return reply.send({
    success: true,
    count: list.length,
    sessions: list,
  });
});

// Simple JSON metrics endpoint
fastify.get("/metrics", async (_request, reply) => {
  return reply.send(buildMetricsSnapshot());
});

const PORT = Number(process.env.AFK_CORE_PORT || 4001);
const HOST = process.env.AFK_CORE_HOST || "127.0.0.1";

fastify
  .listen({ port: PORT, host: HOST })
  .then(() => {
    fastify.log.info(
      { port: PORT, host: HOST },
      "AFK core service listening",
    );
  })
  .catch((err) => {
    fastify.log.error(err, "Failed to start AFK core service");
    process.exit(1);
  });

