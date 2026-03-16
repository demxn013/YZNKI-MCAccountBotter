// yazanaki/mcbot/server.js (VPS-side)
// Express API server — receives bot commands from KenzAI Discord Bot.

"use strict";

// ============================================================
// SUPPRESS PARTIAL-PACKET NOISE FROM node-minecraft-protocol
// These "Chunk size is X but only Y was read" messages are benign
// internal warnings from the packet decoder — mineflayer handles
// them automatically. They only clutter logs.
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
  startBot,
  stopBot,
  stopAllBots,
  getBotStatus,
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
// Stores device codes emitted during Microsoft auth so the
// Discord bot can poll for them and DM the user.
// Map<discordId, { userCode, verificationUri, expiresAt }>
// ============================================================
const pendingDeviceCodes = new Map();

// ============================================================
// PENDING LINK VERIFICATION (for /link command via VPS auth)
// When a bot started with forLinkVerification spawns, we store
// the verified MC username here. Map<discordId, { mcUsername, createdAt }>
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
//
// If Microsoft auth is needed (no cached token), the device code
// is stored in pendingDeviceCodes. The Discord bot should poll
// GET /devicecode/:discordId after receiving a 200 here to check
// if auth is required, then DM the user the verification link.
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

  // Clear any stale device code from a previous run so the new code isn't silently ignored.
  if (pendingDeviceCodes.has(discordId.trim())) {
    console.log(`[server] 🧹 Clearing stale device code for ${discordId} before new start`);
    pendingDeviceCodes.delete(discordId.trim());
  }

  // Device code callback — stores the code so Discord bot can poll for it.
  // We only keep the first code per discordId; regenerated codes after expiry are ignored
  // so the user isn't silently rotated onto a new code they never see.
  const onDeviceCode = (userCode, verificationUri, expiresIn) => {
    const key = discordId.trim();
    if (pendingDeviceCodes.has(key)) {
      console.log(`[server] 🔐 Ignoring regenerated device code for ${discordId} (one active already).`);
      return;
    }
    const ENFORCED_DEVICE_CODE_TTL_SEC = 5 * 60;
    const effectiveExpiresIn = Math.min(
      typeof expiresIn === "number" ? expiresIn : ENFORCED_DEVICE_CODE_TTL_SEC,
      ENFORCED_DEVICE_CODE_TTL_SEC
    );
    const expiresAt = Date.now() + (effectiveExpiresIn * 1000);
    pendingDeviceCodes.set(key, { userCode, verificationUri, expiresAt });
    console.log(`[server] 🔐 Device code stored for ${discordId}: ${userCode} @ ${verificationUri}`);
  };

  // When forLinkVerification: on login the botmanager will call this, then stop the bot.
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
// GET /devicecode/:discordId
//
// Returns the Microsoft device code if one is pending for this user.
// The Discord bot polls this after /start to check if auth is needed.
// Returns 404 if no code is pending (either not needed or already done).
// ============================================================

app.get("/devicecode/:discordId", (req, res) => {
  const { discordId } = req.params;

  console.log(`[server] 📥 GET /devicecode/${discordId}`);

  const entry = pendingDeviceCodes.get(discordId.trim());

  if (!entry) {
    return res.status(404).json({ ok: false, pending: false });
  }

  if (Date.now() > entry.expiresAt) {
    pendingDeviceCodes.delete(discordId.trim());
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
// ROUTE: Clear Device Code (after user has completed auth)
// DELETE /devicecode/:discordId
// ============================================================

app.delete("/devicecode/:discordId", (req, res) => {
  const { discordId } = req.params;
  pendingDeviceCodes.delete(discordId.trim());
  return res.status(200).json({ ok: true });
});

// ============================================================
// ROUTE: Get link verification result (for /link via VPS auth)
// GET /link/verified/:discordId
// Returns { ok: true, mcUsername } once the link-verification bot
// has spawned; removes the entry. 404 if none or expired.
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
// Body: { discordId }
// ============================================================

app.post("/stop", (req, res) => {
  const { discordId } = req.body;

  console.log(`[server] 📥 POST /stop — discordId=${discordId}`);

  if (!discordId || typeof discordId !== "string") {
    return res.status(400).json({ ok: false, error: "Missing or invalid discordId" });
  }

  // Clear any pending device code so a fresh /start always gets a clean slate
  pendingDeviceCodes.delete(discordId.trim());

  const result = stopBot(discordId.trim());

  if (!result.success) {
    return res.status(404).json({ ok: false, ...result });
  }

  return res.status(200).json({ ok: true, message: "Bot stopped", ...result });
});

// ============================================================
// ROUTE: Get Bot Status
// GET /status/:discordId
// ============================================================

app.get("/status/:discordId", (req, res) => {
  const { discordId } = req.params;

  console.log(`[server] 📥 GET /status/${discordId}`);

  const status = getBotStatus(discordId.trim());

  if (!status.found) {
    return res.status(404).json({ ok: false, reason: "no_bot_running", discordId });
  }

  return res.status(200).json({ ok: true, bot: status.bot });
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
  // Clear all pending device codes too
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

// Graceful shutdown — stop all bots cleanly
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