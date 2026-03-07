// yazanaki/mcbot/botmanager.js
// Manages all mineflayer bot instances for empire members.
// Each Discord user can have at most ONE active bot at a time.

"use strict";

const mineflayer = require("mineflayer");

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
 * Handles formats: "play.server.net", "play.server.net:25565", "123.45.67.89:19132"
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

// ============================================================
// START BOT
// ============================================================

/**
 * Start a mineflayer bot for a specific empire member.
 * @param {string} discordId       - Discord user ID (used as unique key)
 * @param {string} minecraftUser   - Minecraft username from members.json
 * @param {string} serverAddress   - Target server (host[:port])
 * @param {string} version         - Minecraft version (e.g. "1.20.1")
 * @returns {{ success: boolean, reason?: string }}
 */
function startBot(discordId, minecraftUser, serverAddress, version) {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`[botmanager] 🤖 Starting bot`);
  console.log(`  Discord ID:   ${discordId}`);
  console.log(`  MC User:      ${minecraftUser}`);
  console.log(`  Server:       ${serverAddress}`);
  console.log(`  Version:      ${version}`);

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

  let bot;
  try {
    bot = mineflayer.createBot({
      host,
      port,
      username: minecraftUser,
      version: version || "1.20.1",
      // Offline/cracked mode — no auth
      auth: "offline",
      // Prevent spam logging from mineflayer internals
      hideErrors: false,
      logErrors: true,
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
    version: version || "1.20.1",
    startedAt: new Date().toISOString(),
    status: "connecting",
  };
  activeBots.set(discordId, entry);

  // ============================================================
  // BOT EVENTS
  // ============================================================

  bot.once("spawn", () => {
    console.log(`[botmanager] ✅ Bot spawned: ${minecraftUser} on ${host}:${port}`);
    if (activeBots.has(discordId)) {
      activeBots.get(discordId).status = "online";
    }
  });

  bot.on("kicked", (reason) => {
    let reasonText = reason;
    try {
      // reason may be a JSON chat component
      const parsed = JSON.parse(reason);
      reasonText = parsed.text || parsed.translate || reason;
    } catch (_) {}
    console.warn(`[botmanager] 🦶 Bot kicked: ${minecraftUser} — ${reasonText}`);
    cleanupBot(discordId, "kicked");
  });

  bot.on("error", (err) => {
    console.error(`[botmanager] ❌ Bot error: ${minecraftUser} — ${err.message}`);
    cleanupBot(discordId, "error");
  });

  bot.on("end", (reason) => {
    console.log(`[botmanager] 🔌 Bot disconnected: ${minecraftUser} — reason: ${reason}`);

    if (AUTO_RECONNECT && activeBots.has(discordId)) {
      console.log(`[botmanager] 🔄 Auto-reconnect in ${RECONNECT_DELAY_MS}ms for ${minecraftUser}...`);
      activeBots.get(discordId).status = "reconnecting";
      setTimeout(() => {
        // Only reconnect if the user hasn't manually stopped the bot
        if (activeBots.has(discordId) && activeBots.get(discordId).status === "reconnecting") {
          cleanupBot(discordId, "reconnect_cycle");
          const result = startBot(discordId, minecraftUser, `${host}:${port}`, version);
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
  console.log(`[botmanager] 🛑 Stopping bot for Discord ID: ${discordId}`);

  if (!activeBots.has(discordId)) {
    console.warn(`[botmanager] ⚠️ No active bot found for ${discordId}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    return { success: false, reason: "no_bot_running" };
  }

  const entry = activeBots.get(discordId);
  try {
    entry.bot.quit("Stopped by Yazanaki command");
  } catch (err) {
    // Bot may already be disconnected; still clean up registry
    console.warn(`[botmanager] ⚠️ Error quitting bot (may already be disconnected): ${err.message}`);
  }

  cleanupBot(discordId, "manual_stop");
  console.log(`[botmanager] ✅ Bot stopped: ${entry.minecraftUser}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  return { success: true, minecraftUser: entry.minecraftUser };
}

// ============================================================
// STOP ALL BOTS
// ============================================================

/**
 * Emergency stop — kills every active bot.
 * @returns {{ stopped: number }}
 */
function stopAllBots() {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`[botmanager] 🚨 STOP ALL — Killing ${activeBots.size} bot(s)`);

  let stopped = 0;
  for (const [discordId, entry] of activeBots.entries()) {
    try {
      entry.bot.quit("Emergency stop by admin");
    } catch (_) {}
    activeBots.delete(discordId);
    stopped++;
    console.log(`[botmanager] 🛑 Stopped: ${entry.minecraftUser} (${discordId})`);
  }

  console.log(`[botmanager] ✅ All bots stopped (${stopped} total)`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  return { stopped };
}

// ============================================================
// STATUS / LIST
// ============================================================

/**
 * Get status of a specific user's bot.
 * @param {string} discordId
 * @returns {object|null}
 */
function getBotStatus(discordId) {
  if (!activeBots.has(discordId)) return null;
  const entry = activeBots.get(discordId);
  return {
    discordId: entry.discordId,
    minecraftUser: entry.minecraftUser,
    serverHost: entry.serverHost,
    serverPort: entry.serverPort,
    version: entry.version,
    startedAt: entry.startedAt,
    status: entry.status,
    uptimeSeconds: Math.floor((Date.now() - new Date(entry.startedAt).getTime()) / 1000),
  };
}

/**
 * List all active bots (for admin use).
 * @returns {Array}
 */
function listAllBots() {
  const result = [];
  for (const discordId of activeBots.keys()) {
    result.push(getBotStatus(discordId));
  }
  return result;
}

/**
 * Total count of active bots.
 */
function getBotCount() {
  return activeBots.size;
}

// ============================================================
// INTERNAL CLEANUP
// ============================================================

/**
 * Remove a bot entry from the registry (does NOT quit the bot connection — do that first).
 * @param {string} discordId
 * @param {string} reason - for logging
 */
function cleanupBot(discordId, reason) {
  if (activeBots.has(discordId)) {
    // Remove all listeners to prevent memory leaks
    try {
      const entry = activeBots.get(discordId);
      entry.bot.removeAllListeners();
    } catch (_) {}
    activeBots.delete(discordId);
    console.log(`[botmanager] 🧹 Cleaned up bot entry for ${discordId} (reason: ${reason})`);
  }
}

module.exports = {
  startBot,
  stopBot,
  stopAllBots,
  getBotStatus,
  listAllBots,
  getBotCount,
};