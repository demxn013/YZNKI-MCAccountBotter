// yazanaki/mcbot/botmanager.js (VPS-side)
// Updated version that surfaces Microsoft device-code auth back to KenzAI
// via the onDeviceCode callback, so the Discord bot can DM users the link.

"use strict";

const mineflayer = require("mineflayer");
const fs = require("fs");
const path = require("path");

// ============================================================
// TOKEN CACHE — persists Microsoft tokens between restarts
// Stored at ./tokens/<username>.json  (lowercased)
// ============================================================
const TOKENS_DIR = path.join(__dirname, "tokens");

if (!fs.existsSync(TOKENS_DIR)) {
  fs.mkdirSync(TOKENS_DIR, { recursive: true });
}

function tokenPath(username) {
  return path.join(TOKENS_DIR, `${username.toLowerCase()}.json`);
}

function loadToken(username) {
  try {
    const p = tokenPath(username);
    if (!fs.existsSync(p)) return undefined;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
}

function saveToken(username, token) {
  try {
    fs.writeFileSync(tokenPath(username), JSON.stringify(token, null, 2), "utf8");
    console.log(`[botmanager] 💾 Token cached for ${username}`);
  } catch (err) {
    console.warn(`[botmanager] ⚠️ Could not save token for ${username}:`, err.message);
  }
}

// ============================================================
// IN-MEMORY BOT REGISTRY
// Map<discordId, { bot, minecraftUser, serverHost, serverPort, version, startedAt, status }>
// ============================================================
const activeBots = new Map();

const AUTO_RECONNECT = process.env.AUTO_RECONNECT === "true";
const RECONNECT_DELAY_MS = parseInt(process.env.RECONNECT_DELAY_MS || "5000", 10);
const MAX_BOTS = parseInt(process.env.MAX_BOTS || "0", 10); // 0 = unlimited

// ============================================================
// HELPERS
// ============================================================

/**
 * Parse a Minecraft server address into host + port.
 * Handles: "play.server.net", "play.server.net:25565", "1.2.3.4:19132"
 */
function parseServerAddress(address) {
  const str = String(address || "").trim();
  const lastColon = str.lastIndexOf(":");
  if (lastColon !== -1 && lastColon < str.length - 1) {
    const potentialPort = parseInt(str.slice(lastColon + 1), 10);
    if (!isNaN(potentialPort) && potentialPort > 0 && potentialPort <= 65535) {
      return { host: str.slice(0, lastColon), port: potentialPort };
    }
  }
  return { host: str, port: 25565 };
}

// Shared handler for Microsoft device-code events / callbacks
function handleDeviceCode(minecraftUser, onDeviceCode, deviceCodeResponse) {
  const userCode = deviceCodeResponse.user_code;
  const verificationUri = deviceCodeResponse.verification_uri || "https://www.microsoft.com/link";
  const expiresIn = deviceCodeResponse.expires_in || 900;

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`[botmanager] 🔐 Microsoft auth required for ${minecraftUser}`);
  console.log(`[botmanager] 🌐 Go to: ${verificationUri}`);
  console.log(`[botmanager] 🔑 Enter code: ${userCode}`);
  console.log(`[botmanager] ⏰ Expires in: ${Math.floor(expiresIn / 60)} minutes`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  if (typeof onDeviceCode === "function") {
    try {
      onDeviceCode(userCode, verificationUri, expiresIn);
    } catch (err) {
      console.warn(`[botmanager] ⚠️ onDeviceCode callback threw:`, err.message);
    }
  }
}

// ============================================================
// START BOT
// ============================================================

/**
 * Start a mineflayer bot for a specific empire member.
 * Uses Microsoft auth (online mode) to join online-mode servers.
 *
 * @param {string}   discordId       - Discord user ID (used as unique key)
 * @param {string}   minecraftUser   - Minecraft username from members.json
 * @param {string}   serverAddress   - Target server (host[:port])
 * @param {string}   version         - Minecraft version (e.g. "1.20.1")
 * @param {Function} [onDeviceCode]  - Optional callback(userCode, verificationUri, expiresIn)
 *                                     called when Microsoft device-code auth is needed.
 *                                     The VPS API uses this to store codes per discordId
 *                                     so the Discord bot can DM them to users.
 * @returns {{ success: boolean, reason?: string, needsAuth?: boolean }}
 */
function startBot(discordId, minecraftUser, serverAddress, version, onDeviceCode = null) {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`[botmanager] 🤖 Starting bot`);
  console.log(`  Discord ID:   ${discordId}`);
  console.log(`  MC User:      ${minecraftUser}`);
  console.log(`  Server:       ${serverAddress}`);
  console.log(`  Version:      ${version}`);
  console.log(`  Auth mode:    microsoft`);

  // Check: already has a bot running
  if (activeBots.has(discordId)) {
    const existing = activeBots.get(discordId);
    console.warn(`[botmanager] ⚠️ User already has an active bot on ${existing.serverHost}:${existing.serverPort}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    return { success: false, reason: "already_running", serverAddress: `${existing.serverHost}:${existing.serverPort}` };
  }

  // Check: max bot cap
  if (MAX_BOTS > 0 && activeBots.size >= MAX_BOTS) {
    console.warn(`[botmanager] ⚠️ Max bot limit reached (${MAX_BOTS})`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    return { success: false, reason: "max_bots_reached", max: MAX_BOTS };
  }

  const { host, port } = parseServerAddress(serverAddress);

  // Load cached token if available
  const cachedToken = loadToken(minecraftUser);
  if (cachedToken) {
    console.log(`[botmanager] 🔑 Using cached Microsoft token for ${minecraftUser}`);
  } else {
    console.log(`[botmanager] 🔑 No cached token for ${minecraftUser} — device code auth will be required`);
  }

  let bot;
  try {
    bot = mineflayer.createBot({
      host,
      port,
      username: minecraftUser,
      version: version || "1.21.11",
      // Microsoft auth — required for online-mode servers (DonutSMP etc.)
      auth: "microsoft",
      // Provide cached token folder so device-code flow can reuse tokens
      ...(cachedToken ? { profilesFolder: TOKENS_DIR } : {}),
      hideErrors: false,
      logErrors: true,
      // New: hook into prismarine-auth device-code callback so the VPS
      // API can relay the link + code back to the Discord bot.
      onMsaCode: (deviceCodeResponse) => {
        handleDeviceCode(minecraftUser, onDeviceCode, deviceCodeResponse);
      },
    });
  } catch (err) {
    console.error(`[botmanager] ❌ Failed to create bot:`, err.message);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    return { success: false, reason: "bot_creation_failed", error: err.message };
  }

  // Store in registry immediately so concurrent start calls are blocked
  const entry = {
    bot,
    discordId,
    minecraftUser,
    serverHost: host,
    serverPort: port,
    version: version || "1.21.11",
    startedAt: new Date().toISOString(),
    status: "connecting",
    spawnError: null,
  };
  activeBots.set(discordId, entry);

  // Spawn timeout — if bot doesn't fire "spawn" within 45s, mark as failed and clean up.
  const spawnTimeoutId = setTimeout(() => {
    if (!activeBots.has(discordId)) return;
    const e = activeBots.get(discordId);
    if (e.status !== "connecting") return;
    console.warn(`[botmanager] ⏰ Spawn timeout for ${minecraftUser} after 45s — cleaning up`);
    e.spawnError = "Connection timed out — the server did not respond within 45 seconds. Check the server address and version.";
    e.status = "error";
    setTimeout(() => cleanupBot(discordId, "spawn_timeout"), 30000);
  }, 45000);

  // Legacy event (some mineflayer versions fire this) — keep for logging
  bot.on("microsoft_device_code", (deviceCodeResponse) => {
    handleDeviceCode(minecraftUser, onDeviceCode, deviceCodeResponse);
  });

  // ============================================================
  // BOT EVENTS
  // ============================================================

  bot.once("spawn", () => {
    clearTimeout(spawnTimeoutId);
    console.log(`[botmanager] ✅ Bot spawned: ${minecraftUser} on ${host}:${port}`);
    if (activeBots.has(discordId)) {
      activeBots.get(discordId).status = "online";
      activeBots.get(discordId).spawnError = null;
    }

    // Save/refresh token after successful login
    try {
      const profilesFile = path.join(TOKENS_DIR, "nmp-cache.json");
      if (fs.existsSync(profilesFile)) {
        const profiles = JSON.parse(fs.readFileSync(profilesFile, "utf8"));
        const userKey = Object.keys(profiles).find(
          k => k.toLowerCase() === minecraftUser.toLowerCase()
        );
        if (userKey) {
          saveToken(minecraftUser, profiles[userKey]);
        }
      }
    } catch {
      // Non-fatal — token caching is best-effort
    }
  });

  bot.on("kicked", (reason) => {
    clearTimeout(spawnTimeoutId);
    let reasonText;

    if (typeof reason === "string") {
      // Newer servers often send a JSON string, older ones plain text
      try {
        const parsed = JSON.parse(reason);
        reasonText = parsed.text || parsed.translate || reason;
      } catch {
        reasonText = reason;
      }
    } else if (reason && typeof reason === "object") {
      // Mineflayer/node-minecraft-protocol sometimes pass a rich object
      reasonText =
        reason.text ||
        reason.translate ||
        reason.reason ||
        JSON.stringify(reason);
    } else {
      reasonText = String(reason);
    }

    console.warn(`[botmanager] 🦶 Bot kicked: ${minecraftUser} — ${reasonText}`);
    if (activeBots.has(discordId)) {
      activeBots.get(discordId).spawnError = `Kicked: ${reasonText}`;
      activeBots.get(discordId).status = "error";
    }
    setTimeout(() => cleanupBot(discordId, "kicked"), 30000);
  });

  bot.on("error", (err) => {
    clearTimeout(spawnTimeoutId);
    console.error(`[botmanager] ❌ Bot error: ${minecraftUser} — ${err.message}`);
    if (activeBots.has(discordId)) {
      activeBots.get(discordId).spawnError = err.message;
      activeBots.get(discordId).status = "error";
    }
    // If it's an auth error, remove the cached token so next attempt re-auths
    if (
      err.message?.toLowerCase().includes("microsoft") ||
      err.message?.toLowerCase().includes("auth") ||
      err.message?.toLowerCase().includes("token") ||
      err.message?.toLowerCase().includes("session")
    ) {
      console.warn(`[botmanager] 🔑 Auth error detected — clearing cached token for ${minecraftUser}`);
      try { fs.unlinkSync(tokenPath(minecraftUser)); } catch {}
    }
    setTimeout(() => cleanupBot(discordId, "error"), 30000);
  });

  bot.on("end", (reason) => {
    clearTimeout(spawnTimeoutId);
    console.log(`[botmanager] 🔌 Bot disconnected: ${minecraftUser} — reason: ${reason}`);

    if (AUTO_RECONNECT && activeBots.has(discordId)) {
      console.log(`[botmanager] 🔄 Auto-reconnect in ${RECONNECT_DELAY_MS}ms for ${minecraftUser}...`);
      activeBots.get(discordId).status = "reconnecting";
      setTimeout(() => {
        if (activeBots.has(discordId) && activeBots.get(discordId).status === "reconnecting") {
          cleanupBot(discordId, "reconnect_cycle");
          const result = startBot(discordId, minecraftUser, `${host}:${port}`, version, onDeviceCode);
          if (!result.success) {
            console.error(`[botmanager] ❌ Auto-reconnect failed for ${minecraftUser}: ${result.reason}`);
          }
        }
      }, RECONNECT_DELAY_MS);
    } else {
      cleanupBot(discordId, "end");
    }
  });

  console.log(`[botmanager] ✅ Bot started successfully: ${minecraftUser} → ${host}:${port}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  return { success: true };
}

// ============================================================
// STOP BOT
// ============================================================

/**
 * Stop a specific user's bot.
 * @param {string} discordId
 * @returns {{ success: boolean, reason?: string }}
 */
function stopBot(discordId) {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`[botmanager] 🛑 Stopping bot for discordId: ${discordId}`);

  const entry = activeBots.get(discordId);
  if (!entry) {
    console.warn(`[botmanager] ⚠️ No bot running for ${discordId}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    return { success: false, reason: "no_bot_running" };
  }

  cleanupBot(discordId, "manual_stop");
  console.log(`[botmanager] ✅ Bot stopped for ${entry.minecraftUser}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  return { success: true };
}

// ============================================================
// STOP ALL BOTS
// ============================================================

/**
 * Stop all running bots.
 * @returns {{ success: boolean, stopped: number }}
 */
function stopAllBots() {
  const count = activeBots.size;
  console.log(`[botmanager] 🚨 Stopping all ${count} bot(s)`);
  for (const discordId of [...activeBots.keys()]) {
    cleanupBot(discordId, "stopall");
  }
  return { success: true, stopped: count };
}

// ============================================================
// CLEANUP (internal)
// ============================================================

function cleanupBot(discordId, reason) {
  const entry = activeBots.get(discordId);
  if (!entry) return;

  activeBots.delete(discordId);

  try {
    entry.bot.quit();
  } catch (_) {}

  try {
    entry.bot.end();
  } catch (_) {}

  console.log(`[botmanager] 🧹 Cleaned up bot for ${entry.minecraftUser} (reason: ${reason})`);
}

// ============================================================
// STATUS / LIST
// ============================================================

/**
 * Get status of a specific user's bot.
 * @param {string} discordId
 * @returns {{ found: boolean, bot?: object }}
 */
function getBotStatus(discordId) {
  const entry = activeBots.get(discordId);
  if (!entry) return { found: false };

  return {
    found: true,
    bot: {
      discordId: entry.discordId,
      minecraftUser: entry.minecraftUser,
      serverHost: entry.serverHost,
      serverPort: entry.serverPort,
      version: entry.version,
      startedAt: entry.startedAt,
      status: entry.status,
      spawnError: entry.spawnError || null,
      uptimeSeconds: Math.floor((Date.now() - new Date(entry.startedAt).getTime()) / 1000),
    },
  };
}

/**
 * List all active bots.
 * @returns {Array<object>}
 */
function listAllBots() {
  return [...activeBots.values()].map((entry) => ({
    discordId: entry.discordId,
    minecraftUser: entry.minecraftUser,
    serverHost: entry.serverHost,
    serverPort: entry.serverPort,
    version: entry.version,
    startedAt: entry.startedAt,
    status: entry.status,
    uptimeSeconds: Math.floor((Date.now() - new Date(entry.startedAt).getTime()) / 1000),
  }));
}

/**
 * Get total number of active bots.
 * @returns {number}
 */
function getBotCount() {
  return activeBots.size;
}

module.exports = {
  startBot,
  stopBot,
  stopAllBots,
  getBotStatus,
  listAllBots,
  getBotCount,
};

