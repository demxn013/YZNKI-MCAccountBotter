// yazanaki/mcbot/server.js (VPS-side)
// Express API server — receives bot commands from KenzAI Discord Bot.

"use strict";

// ============================================================
// SUPPRESS PARTIAL-PACKET NOISE FROM node-minecraft-protocol
// ============================================================
const _origLog = console.log.bind(console);
console.log = (...args) => {
  if (typeof args[0] === "string" && args[0].startsWith("Chunk size is")) return;
  _origLog(...args);
};
const _origWarn = console.warn.bind(console);
console.warn = (...args) => {
  if (typeof args[0] === "string" && args[0].startsWith("Chunk size is")) return;
  _origWarn(...args);
};

require("dotenv").config();

const express = require("express");
const {
  makeBotId,
  startBot,
  stopBot,
  stopBotsForUser,
  stopAllBots,
  getBotStatus,
  getBotsForUser,
  listAllBots,
  getBotCount,
} = require("./botmanager");

const app = express();
app.use(express.json());

const PORT = parseInt(process.env.PORT || "4823", 10);
const API_KEY = process.env.API_KEY;

if (!API_KEY || API_KEY.trim() === "" || API_KEY === "REPLACE_WITH_A_LONG_RANDOM_SECRET") {
  console.error("❌ FATAL: API_KEY is not set in .env. Refusing to start.");
  process.exit(1);
}

// ============================================================
// PENDING DEVICE CODES
// Map<botId, { userCode, verificationUri, expiresAt }>
//
// botId = `${discordId}:${minecraftUser.toLowerCase()}`
//
// Always stores the LATEST code — if prismarine-auth's retry loop
// generates a new code after the first one, we overwrite so the
// Discord bot picks up the fresh code on its next poll.
// ============================================================
const pendingDeviceCodes = new Map();

// ============================================================
// PENDING LINK VERIFICATION
// Map<discordId, { mcUsername, createdAt }>
// ============================================================
const pendingLinkVerified = new Map();
const LINK_VERIFIED_EXPIRY_MS = 5 * 60 * 1000;

// ============================================================
// MIDDLEWARE — API Key Auth
// ============================================================

function requireApiKey(req, res, next) {
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : null;

  if (!token || token !== API_KEY) {
    console.warn(`[server] 🚫 Unauthorized request from ${req.ip} — ${req.method} ${req.path}`);
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  next();
}

app.use(requireApiKey);

// ============================================================
// ROUTE: Health Check
// GET /ping
// ============================================================

app.get("/ping", (req, res) => {
  res.json({ ok: true, activeBots: getBotCount(), timestamp: new Date().toISOString() });
});

// ============================================================
// ROUTE: Start Bot
// POST /start
// Body: { discordId, minecraftUser, serverAddress, version, forLinkVerification? }
// ============================================================

app.post("/start", (req, res) => {
  const { discordId, minecraftUser, serverAddress, version, forLinkVerification } = req.body;

  console.log(`[server] 📥 POST /start — discordId=${discordId} mc=${minecraftUser} server=${serverAddress} v=${version} linkOnly=${!!forLinkVerification}`);

  if (!discordId || typeof discordId !== "string") {
    return res.status(400).json({ ok: false, error: "Missing or invalid discordId" });
  }
  if (!minecraftUser || typeof minecraftUser !== "string") {
    return res.status(400).json({ ok: false, error: "Missing or invalid minecraftUser" });
  }
  if (!serverAddress || typeof serverAddress !== "string") {
    return res.status(400).json({ ok: false, error: "Missing or invalid serverAddress" });
  }

  const botId = makeBotId(discordId.trim(), minecraftUser.trim());

  // Clear any stale device code from a previous run for this specific bot
  if (pendingDeviceCodes.has(botId)) {
    console.log(`[server] 🧹 Clearing stale device code for ${botId} before new start`);
    pendingDeviceCodes.delete(botId);
  }

  // Device code callback.
  //
  // IMPORTANT: We always overwrite with the latest code. prismarine-auth's
  // retry loop may generate multiple codes when a cached refresh token is
  // expired. The Discord bot needs to show the LATEST valid code — the earlier
  // codes will have been consumed/invalidated by Microsoft by the time the
  // user tries to enter them.
  const onDeviceCode = (userCode, verificationUri, expiresIn) => {
    const ENFORCED_DEVICE_CODE_TTL_SEC = 5 * 60;
    const effectiveExpiresIn = Math.min(
      typeof expiresIn === "number" ? expiresIn : ENFORCED_DEVICE_CODE_TTL_SEC,
      ENFORCED_DEVICE_CODE_TTL_SEC
    );
    const expiresAt = Date.now() + (effectiveExpiresIn * 1000);
    const existing = pendingDeviceCodes.get(botId);
    if (existing && existing.userCode !== userCode) {
      console.log(`[server] 🔄 Updated device code for ${botId}: ${existing.userCode} → ${userCode}`);
    }
    pendingDeviceCodes.set(botId, { userCode, verificationUri, expiresAt });
    console.log(`[server] 🔐 Device code stored for ${botId}: ${userCode} @ ${verificationUri}`);
  };

  const onLinkVerified = forLinkVerification
    ? (did, mcUsername) => {
        pendingLinkVerified.set(String(did).trim(), { mcUsername, createdAt: Date.now() });
        console.log(`[server] 🔗 Link verified for ${did}: MC username ${mcUsername}`);
      }
    : null;

  const result = startBot(
    discordId.trim(),
    minecraftUser.trim(),
    serverAddress.trim(),
    (version || "1.21.4").trim(),
    onDeviceCode,
    onLinkVerified
  );

  if (!result.success) {
    const statusCode = result.reason === "already_running" ? 409 : 500;
    return res.status(statusCode).json({ ok: false, ...result });
  }

  return res.status(200).json({ ok: true, message: "Bot started", discordId, minecraftUser });
});

// ============================================================
// ROUTE: Check for Pending Device Code
// GET /devicecode/:discordId/:minecraftUser
// ============================================================

app.get("/devicecode/:discordId/:minecraftUser", (req, res) => {
  const discordId = req.params.discordId.trim();
  const minecraftUser = req.params.minecraftUser.trim();

  const botId = makeBotId(discordId, minecraftUser);
  console.log(`[server] 📥 GET /devicecode/${botId}`);

  const entry = pendingDeviceCodes.get(botId);

  if (!entry) {
    return res.status(404).json({ ok: false, pending: false });
  }

  if (Date.now() > entry.expiresAt) {
    pendingDeviceCodes.delete(botId);
    return res.status(404).json({ ok: false, pending: false, reason: "expired" });
  }

  return res.status(200).json({
    ok: true,
    pending: true,
    userCode: entry.userCode,
    verificationUri: entry.verificationUri,
    expiresAt: entry.expiresAt,
  });
});

// ============================================================
// ROUTE: Clear Device Code
// DELETE /devicecode/:discordId/:minecraftUser
// ============================================================

app.delete("/devicecode/:discordId/:minecraftUser", (req, res) => {
  const discordId = req.params.discordId.trim();
  const minecraftUser = req.params.minecraftUser.trim();
  const botId = makeBotId(discordId, minecraftUser);
  pendingDeviceCodes.delete(botId);
  return res.status(200).json({ ok: true });
});

// ============================================================
// ROUTE: Get link verification result
// GET /link/verified/:discordId
// ============================================================

app.get("/link/verified/:discordId", (req, res) => {
  const discordId = req.params.discordId.trim();
  const entry = pendingLinkVerified.get(discordId);
  if (!entry) {
    return res.status(404).json({ ok: false, reason: "no_result" });
  }
  if (Date.now() - entry.createdAt > LINK_VERIFIED_EXPIRY_MS) {
    pendingLinkVerified.delete(discordId);
    return res.status(404).json({ ok: false, reason: "expired" });
  }
  pendingLinkVerified.delete(discordId);
  return res.status(200).json({ ok: true, mcUsername: entry.mcUsername });
});

// ============================================================
// ROUTE: Stop Bot
// POST /stop
// Body: { discordId, minecraftUser }
// ============================================================

app.post("/stop", (req, res) => {
  const { discordId, minecraftUser } = req.body;

  console.log(`[server] 📥 POST /stop — discordId=${discordId} mc=${minecraftUser}`);

  if (!discordId || typeof discordId !== "string") {
    return res.status(400).json({ ok: false, error: "Missing or invalid discordId" });
  }
  if (!minecraftUser || typeof minecraftUser !== "string") {
    return res.status(400).json({ ok: false, error: "Missing or invalid minecraftUser" });
  }

  const botId = makeBotId(discordId.trim(), minecraftUser.trim());
  pendingDeviceCodes.delete(botId);

  const result = stopBot(discordId.trim(), minecraftUser.trim());

  if (!result.success) {
    return res.status(404).json({ ok: false, ...result });
  }

  return res.status(200).json({ ok: true, message: "Bot stopped", ...result });
});

// ============================================================
// ROUTE: Get Bot Status (specific account)
// GET /status/:discordId/:minecraftUser
// ============================================================

app.get("/status/:discordId/:minecraftUser", (req, res) => {
  const discordId = req.params.discordId.trim();
  const minecraftUser = req.params.minecraftUser.trim();

  console.log(`[server] 📥 GET /status/${discordId}/${minecraftUser}`);

  const status = getBotStatus(discordId, minecraftUser);

  if (!status.found) {
    return res.status(404).json({ ok: false, reason: "no_bot_running", discordId, minecraftUser });
  }

  return res.status(200).json({ ok: true, bot: status.bot });
});

// ============================================================
// ROUTE: List all bots for a user
// GET /bots/:discordId
// ============================================================

app.get("/bots/:discordId", (req, res) => {
  const discordId = req.params.discordId.trim();
  console.log(`[server] 📥 GET /bots/${discordId}`);
  const bots = getBotsForUser(discordId);
  return res.status(200).json({ ok: true, count: bots.length, bots });
});

// ============================================================
// ROUTE: List All Active Bots (Admin)
// GET /list
// ============================================================

app.get("/list", (req, res) => {
  console.log(`[server] 📥 GET /list`);
  const bots = listAllBots();
  return res.status(200).json({ ok: true, count: bots.length, bots });
});

// ============================================================
// ROUTE: Stop All Bots (Admin Emergency)
// POST /stopall
// ============================================================

app.post("/stopall", (req, res) => {
  console.log(`[server] 📥 POST /stopall`);
  pendingDeviceCodes.clear();
  const result = stopAllBots();
  return res.status(200).json({ ok: true, message: "All bots stopped", ...result });
});

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`[server] ✅ Yazanaki MCBot API running on port ${PORT}`);
  console.log(`[server] 🔐 API key auth: ENABLED`);
  console.log(`[server] 🔑 Auth mode: Microsoft (online mode)`);
  console.log(`[server] 🤖 Max bots: ${process.env.MAX_BOTS || "unlimited"}`);
  console.log(`[server] 🔄 Auto-reconnect: ${process.env.AUTO_RECONNECT || "false"}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
});

process.on("SIGINT", () => {
  console.log("\n[server] 🔴 SIGINT received — stopping all bots and shutting down...");
  stopAllBots();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n[server] 🔴 SIGTERM received — stopping all bots and shutting down...");
  stopAllBots();
  process.exit(0);
});