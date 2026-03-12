// yazanaki/mcbot/server.js (VPS-side)
// Express API server — receives bot commands from KenzAI Discord Bot.
// This is a direct, drop-in copy of your YZNKI-MCAccountBotter server.js,
// unchanged except for path comments so you can copy it back easily.

"use strict";

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
// Body: { discordId, minecraftUser, serverAddress, version }
//
// If Microsoft auth is needed (no cached token), the device code
// is stored in pendingDeviceCodes. The Discord bot should poll
// GET /devicecode/:discordId after receiving a 200 here to check
// if auth is required, then DM the user the verification link.
// ============================================================

app.post("/start", (req, res) => {
  const { discordId, minecraftUser, serverAddress, version } = req.body;

  console.log(`[server] 📥 POST /start — discordId=${discordId} mc=${minecraftUser} server=${serverAddress} v=${version}`);

  // Validate required fields
  if (!discordId || typeof discordId !== "string") {
    return res.status(400).json({ ok: false, error: "Missing or invalid discordId" });
  }
  if (!minecraftUser || typeof minecraftUser !== "string") {
    return res.status(400).json({ ok: false, error: "Missing or invalid minecraftUser" });
  }
  if (!serverAddress || typeof serverAddress !== "string") {
    return res.status(400).json({ ok: false, error: "Missing or invalid serverAddress" });
  }

  // Device code callback — stores the code so Discord bot can poll for it
  const onDeviceCode = (userCode, verificationUri, expiresIn) => {
    const expiresAt = Date.now() + (expiresIn * 1000);
    pendingDeviceCodes.set(discordId.trim(), { userCode, verificationUri, expiresAt });
    console.log(`[server] 🔐 Device code stored for ${discordId}: ${userCode} @ ${verificationUri}`);
  };

  const result = startBot(
    discordId.trim(),
    minecraftUser.trim(),
    serverAddress.trim(),
    (version || "1.20.1").trim(),
    onDeviceCode
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

  const entry = pendingDeviceCodes.get(discordId.trim());

  if (!entry) {
    return res.status(404).json({ ok: false, pending: false });
  }

  // Clean up expired codes
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

