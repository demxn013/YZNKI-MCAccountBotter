// yazanaki/mcbot/server.js
// Express API server — receives bot commands from KenzAI Discord Bot.
// Secured with a shared secret API key in the Authorization header.
//
// SECURITY NOTE:
//   This server uses plain HTTP over a raw IP. The API key in the
//   Authorization header keeps out random users, but traffic is unencrypted.
//   For hardened security, restrict this port to KenzAI's bot server IP
//   using a firewall rule (e.g. ufw allow from <KENZAI_IP> to any port <PORT>)

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

  const result = startBot(
    discordId.trim(),
    minecraftUser.trim(),
    serverAddress.trim(),
    (version || "1.20.1").trim()
  );

  if (!result.success) {
    const statusCode = result.reason === "already_running" ? 409 : 500;
    return res.status(statusCode).json({ ok: false, ...result });
  }

  return res.status(200).json({ ok: true, message: "Bot started", discordId, minecraftUser });
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

  if (!status) {
    return res.status(404).json({ ok: false, error: "No active bot for this user", discordId });
  }

  return res.status(200).json({ ok: true, bot: status });
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