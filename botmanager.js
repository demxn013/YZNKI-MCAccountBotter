// yazanaki/mcbot/botmanager.js (VPS-side)
// Manages mineflayer bots with Microsoft auth, device-code relay,
// link verification, version auto-detection, and auth error dedup.

"use strict";

const mineflayer = require("mineflayer");
const fs = require("fs");
const path = require("path");

// ============================================================
// TOKEN CACHE — persists Microsoft tokens between restarts
//
// Each Minecraft account gets its OWN subdirectory:
//   ./tokens/<username>/
//
// prismarine-auth writes its hash-prefixed cache files
// (e.g. ab58c3_live-cache.json) into that subdirectory via
// the `profilesFolder` option passed to mineflayer.createBot().
//
// This isolation means cache files from account A can never
// bleed into account B, preventing invalid_grant errors.
// ============================================================
const TOKENS_ROOT = path.join(__dirname, "tokens");

if (!fs.existsSync(TOKENS_ROOT)) {
  fs.mkdirSync(TOKENS_ROOT, { recursive: true });
}

function accountTokenDir(username) {
  return path.join(TOKENS_ROOT, username.toLowerCase());
}

function markerPath(username) {
  return path.join(accountTokenDir(username), "_marker.json");
}

function ensureAccountDir(username) {
  const dir = accountTokenDir(username);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Check whether valid Microsoft auth cache exists for this account.
 * Checks the account's own isolated directory only.
 */
function loadToken(username) {
  const dir = accountTokenDir(username);
  if (!fs.existsSync(dir)) return undefined;

  // 1. Check our own marker file
  try {
    const mp = markerPath(username);
    if (fs.existsSync(mp)) {
      const data = JSON.parse(fs.readFileSync(mp, "utf8"));
      if (data && typeof data === "object" && data.username) {
        return data;
      }
    }
  } catch {
    // fall through
  }

  // 2. Check for prismarine-auth hash-prefixed cache files.
  //    Safe to trust here because the directory is account-specific.
  try {
    const files = fs.readdirSync(dir);
    const prismarinePattern = /^[a-f0-9]+_(live|xbl|mca|msa|bedrock)-cache\.json$/i;
    if (files.some(f => prismarinePattern.test(f))) {
      return true;
    }
  } catch {
    // ignore
  }

  return undefined;
}

function saveToken(username) {
  try {
    ensureAccountDir(username);
    const marker = { cachedAt: new Date().toISOString(), username: username.toLowerCase() };
    fs.writeFileSync(markerPath(username), JSON.stringify(marker, null, 2), "utf8");
    console.log(`[botmanager] 💾 Token marker saved for ${username}`);
  } catch (err) {
    console.warn(`[botmanager] ⚠️ Could not save token marker for ${username}:`, err.message);
  }
}

/**
 * Clear ALL Microsoft auth state for a specific account.
 * Only touches that account's own subdirectory.
 */
function clearAuthCache(username) {
  const dir = accountTokenDir(username);
  if (!fs.existsSync(dir)) {
    console.log(`[botmanager] 🧹 No token directory found for ${username} — nothing to clear`);
    return;
  }

  try {
    const files = fs.readdirSync(dir);
    let deleted = 0;
    for (const file of files) {
      try {
        fs.unlinkSync(path.join(dir, file));
        deleted++;
        console.log(`[botmanager] 🧹 Deleted auth cache file: ${username}/${file}`);
      } catch (e) {
        console.warn(`[botmanager] ⚠️ Could not delete ${username}/${file}:`, e.message);
      }
    }
    if (deleted === 0) {
      console.log(`[botmanager] 🧹 No auth cache files found for ${username}`);
    }
  } catch (err) {
    console.warn(`[botmanager] ⚠️ Could not scan token directory for ${username}:`, err.message);
  }
}

// ============================================================
// IN-MEMORY BOT REGISTRY
//
// Key: botId = `${discordId}:${minecraftUser.toLowerCase()}`
// This allows multiple bots per Discord user (one per MC account).
// ============================================================
const activeBots = new Map();

// ============================================================
// AUTH ERROR DEDUP GUARD
// Keyed by botId so each account has its own dedup state.
// ============================================================
const handledAuthErrors = new Set();
const AUTH_ERROR_DEDUP_TTL_MS = 10 * 60 * 1000; // 10 minutes

const AUTO_RECONNECT = process.env.AUTO_RECONNECT === "true";
const RECONNECT_DELAY_MS = parseInt(process.env.RECONNECT_DELAY_MS || "5000", 10);
const MAX_BOTS = parseInt(process.env.MAX_BOTS || "0", 10); // 0 = unlimited

// ============================================================
// VERSION CACHE
// ============================================================
const VERSION_CACHE_PATH = path.join(__dirname, "version-cache.json");
const versionCache = new Map();

const SUPPORTED_VERSIONS = new Set([
  "1.21.4", "1.21.3", "1.21.2", "1.21.1", "1.21",
  "1.20.6", "1.20.5", "1.20.4", "1.20.3", "1.20.2", "1.20.1", "1.20",
  "1.19.4", "1.19.3", "1.19.2", "1.19.1", "1.19",
  "1.18.2", "1.18.1", "1.18",
  "1.17.1", "1.17",
  "1.16.5", "1.16.4", "1.16.3", "1.16.2", "1.16.1", "1.16",
  "1.15.2", "1.15.1", "1.15",
  "1.14.4", "1.14.3", "1.14.2", "1.14.1", "1.14",
  "1.13.2", "1.13.1", "1.13",
  "1.12.2", "1.12.1", "1.12",
  "1.11.2", "1.11.1", "1.11",
  "1.10", "1.9.4", "1.9", "1.8.9", "1.8.8", "1.8",
]);

function loadVersionCache() {
  try {
    if (!fs.existsSync(VERSION_CACHE_PATH)) return;
    const raw = fs.readFileSync(VERSION_CACHE_PATH, "utf8");
    const json = JSON.parse(raw);
    for (const [host, ver] of Object.entries(json || {})) {
      if (typeof host === "string" && typeof ver === "string" && SUPPORTED_VERSIONS.has(ver)) {
        versionCache.set(host.toLowerCase(), ver);
      }
    }
  } catch {
    // ignore
  }
}

function saveVersionCache() {
  try {
    fs.writeFileSync(VERSION_CACHE_PATH, JSON.stringify(Object.fromEntries(versionCache), null, 2), "utf8");
  } catch {
    // ignore
  }
}

loadVersionCache();

// ============================================================
// HUNGER MANAGEMENT — food items the bot is allowed to eat.
// Dangerous items (pufferfish, spider_eye, rotten_flesh,
// poisonous_potato) are intentionally excluded.
// ============================================================
const BOT_FOOD_ITEMS = new Set([
  // Cooked meats (preferred — high saturation)
  "cooked_beef", "cooked_porkchop", "cooked_chicken", "cooked_mutton",
  "cooked_rabbit", "cooked_cod", "cooked_salmon",
  // Raw meats
  "beef", "porkchop", "chicken", "mutton", "rabbit", "cod", "salmon",
  // Bread & baked goods
  "bread", "cookie", "pumpkin_pie",
  // Fruits & vegetables
  "apple", "golden_apple", "enchanted_golden_apple",
  "carrot", "golden_carrot", "melon_slice",
  "baked_potato", "potato", "beetroot",
  "sweet_berries", "glow_berries",
  // Fish & seafood
  "tropical_fish", "dried_kelp",
  // Misc
  "honey_bottle",
  // Stews (non-stackable but valid)
  "mushroom_stew", "beetroot_soup", "rabbit_stew",
  // Chorus fruit (teleports, but still fills hunger)
  "chorus_fruit",
]);

// ============================================================
// VERSION AUTO-DETECTION HELPERS
// ============================================================

function getAutoCandidatesForHost(hostLower) {
  return [
    "1.21.4", "1.21.1", "1.21",
    "1.20.6", "1.20.4", "1.20.1",
    "1.19.4", "1.19.2",
    "1.18.2", "1.17.1", "1.16.5",
  ];
}

function shouldRotateVersionForReason(reasonText) {
  const t = (reasonText || "").toLowerCase();
  return (
    t.includes("outdated") ||
    t.includes("not supported") ||
    t.includes("unsupported version") ||
    t.includes("please update") ||
    t.includes("wrong version")
  );
}

// ============================================================
// SERVER ADDRESS PARSER
// ============================================================

function parseServerAddress(serverAddress) {
  const str = String(serverAddress || "").trim();
  const lastColon = str.lastIndexOf(":");
  if (lastColon === -1) {
    return { host: str, port: 25565 };
  }
  const possiblePort = parseInt(str.slice(lastColon + 1), 10);
  if (!isNaN(possiblePort) && possiblePort > 0 && possiblePort <= 65535) {
    return { host: str.slice(0, lastColon), port: possiblePort };
  }
  return { host: str, port: 25565 };
}

// ============================================================
// FATAL ERROR DETECTION
// ============================================================

function isFatalNetworkError(errCode, errMessage) {
  const FATAL_CODES = new Set([
    "ENOTFOUND",
    "EAI_AGAIN",
    "EAI_NONAME",
    "ECONNREFUSED",
    "ENETUNREACH",
    "EHOSTUNREACH",
  ]);

  if (errCode && FATAL_CODES.has(errCode)) return true;

  const msg = (errMessage || "").toLowerCase();
  if (msg.includes("enotfound") || msg.includes("getaddrinfo")) return true;

  return false;
}

function getFatalErrorMessage(errCode, errMessage) {
  if (errCode === "ENOTFOUND" || (errMessage || "").toLowerCase().includes("getaddrinfo")) {
    return (
      `The server address could not be resolved (DNS lookup failed for the hostname). ` +
      `Check that the server address is spelled correctly and is currently online. ` +
      `Use /mcbot stop and try again with a valid address.`
    );
  }
  if (errCode === "ECONNREFUSED") {
    return (
      `The server refused the connection (port is closed or server is offline). ` +
      `Check that the server is running and the port is correct.`
    );
  }
  if (errCode === "ENETUNREACH" || errCode === "EHOSTUNREACH") {
    return (
      `The server is unreachable from this VPS. ` +
      `The server may be offline or blocking connections from this IP.`
    );
  }
  return `Network error: ${errMessage || errCode}. The server may be offline or unreachable.`;
}

// ============================================================
// DEVICE CODE HANDLER
// ============================================================

function handleDeviceCode(minecraftUser, onDeviceCode, deviceCodeResponse, botId) {
  const {
    user_code: userCode,
    verification_uri: verificationUri,
    expires_in: expiresIn,
    interval,
  } = deviceCodeResponse;

  const effectiveExpiresIn = expiresIn || 900;

  const entry = botId
    ? activeBots.get(botId)
    : [...activeBots.values()].find(
        (e) => e.minecraftUser === minecraftUser && e.status === "connecting",
      );

  // ── Guard: kill immediately if a second code fires ─────────
  if (entry && entry.deviceCodeEmitted) {
    console.warn(`[botmanager] 🛑 Second device code fired for ${minecraftUser} — killing bot. User must run /mcbot start again.`);

    clearAuthCache(minecraftUser);

    if (entry.spawnTimeoutId) {
      clearTimeout(entry.spawnTimeoutId);
      entry.spawnTimeoutId = null;
    }
    entry.status = "error";
    entry.spawnError =
      "Microsoft authentication failed — the sign-in session could not be completed. " +
      "Please run /mcbot start again to receive a fresh login code.";

    if (botId) {
      setTimeout(() => cleanupBot(botId, "auth_second_code"), 0);
    }
    return;
  }

  // ── First code — mark as emitted and extend spawn timeout ──
  if (entry) {
    entry.deviceCodeEmitted = true;

    if (entry.spawnTimeoutId) {
      clearTimeout(entry.spawnTimeoutId);
    }
    entry.spawnTimeoutId = setTimeout(() => {
      if (!activeBots.has(botId)) return;
      const e = activeBots.get(botId);
      if (e.status !== "connecting") return;
      console.warn(`[botmanager] ⏰ Spawn timeout for ${minecraftUser} after 300s (auth) — cleaning up`);
      e.spawnError =
        "Authentication timed out — the Microsoft device code was not redeemed in time. " +
        "Run /mcbot start again to get a new code.";
      e.status = "error";
      setTimeout(() => cleanupBot(botId, "spawn_timeout"), 30000);
    }, 5 * 60 * 1000);
  }

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`[botmanager] 🔐 Microsoft auth required for ${minecraftUser}`);
  console.log(`[botmanager] 🌐 Go to: ${verificationUri}`);
  console.log(`[botmanager] 🔑 Enter code: ${userCode}`);
  console.log(`[botmanager] ⏰ Expires in: ${Math.floor(effectiveExpiresIn / 60)} minutes`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  if (typeof onDeviceCode === "function") {
    try {
      onDeviceCode(userCode, verificationUri, effectiveExpiresIn);
    } catch (err) {
      console.warn(`[botmanager] ⚠️ onDeviceCode callback threw:`, err.message);
    }
  }
}

// ============================================================
// BOT ID HELPER
// ============================================================

/**
 * Compute the canonical bot key for the activeBots map.
 * Format: `${discordId}:${minecraftUser.toLowerCase()}`
 */
function makeBotId(discordId, minecraftUser) {
  return `${discordId}:${minecraftUser.toLowerCase()}`;
}

// ============================================================
// START BOT
// ============================================================

function startBot(discordId, minecraftUser, serverAddress, version, onDeviceCode = null, onLinkVerified = null) {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`[botmanager] 🤖 Starting bot`);
  console.log(`  Discord ID:   ${discordId}`);
  console.log(`  MC User:      ${minecraftUser}`);
  console.log(`  Server:       ${serverAddress}`);
  console.log(`  Version:      ${version}`);
  console.log(`  Auth mode:    microsoft`);

  const botId = makeBotId(discordId, minecraftUser);

  handledAuthErrors.delete(botId);

  if (activeBots.has(botId)) {
    const existing = activeBots.get(botId);
    console.warn(`[botmanager] ⚠️ Bot for ${minecraftUser} already active on ${existing.serverHost}:${existing.serverPort}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    return { success: false, reason: "already_running", serverAddress: `${existing.serverHost}:${existing.serverPort}` };
  }

  if (MAX_BOTS > 0 && activeBots.size >= MAX_BOTS) {
    console.warn(`[botmanager] ⚠️ Max bot limit reached (${MAX_BOTS})`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    return { success: false, reason: "max_bots_reached", max: MAX_BOTS };
  }

  const { host, port } = parseServerAddress(serverAddress);
  const hostLower = String(host || "").toLowerCase();
  const requestedVersion = (version || "1.21.4").trim();
  const autoMode = requestedVersion.toLowerCase() === "auto";
  const autoCandidates = autoMode ? getAutoCandidatesForHost(hostLower) : [];
  const cached = autoMode ? versionCache.get(hostLower) : null;
  let effectiveVersion = autoMode
    ? (cached || autoCandidates[0] || "1.21.4")
    : requestedVersion;

  let autoVersionIndex = autoMode
    ? Math.max(0, autoCandidates.indexOf(effectiveVersion))
    : -1;

  const tokenDir = ensureAccountDir(minecraftUser);

  const entry = {
    botId,
    discordId,
    minecraftUser,
    serverHost: host,
    serverPort: port,
    version: effectiveVersion,
    startedAt: new Date().toISOString(),
    status: "connecting",
    spawnError: null,
    spawnTimeoutId: null,
    deviceCodeEmitted: false,
    bot: null,
  };

  activeBots.set(botId, entry);

  // ── Hunger state — persists across reconnects for this bot session ──
  let isEating = false;
  let eatCooldownUntil = 0;

  // ── Initial spawn timeout (30s before auth code) ──────────
  entry.spawnTimeoutId = setTimeout(() => {
    if (!activeBots.has(botId)) return;
    const e = activeBots.get(botId);
    if (e.status !== "connecting") return;
    if (e.deviceCodeEmitted) return; // auth timeout handled separately
    console.warn(`[botmanager] ⏰ Spawn timeout for ${minecraftUser} after 30s — cleaning up`);
    e.spawnError = "Bot failed to connect within 30 seconds. The server may be offline or unreachable.";
    e.status = "error";
    setTimeout(() => cleanupBot(botId, "spawn_timeout"), 30000);
  }, 30000);

  function spawnBot(versionToTry) {
    entry.version = versionToTry;

    let bot;
    try {
      bot = mineflayer.createBot({
        host,
        port,
        username: minecraftUser,
        version: versionToTry,
        auth: "microsoft",
        profilesFolder: tokenDir,
        onMsaCode: (data) => handleDeviceCode(minecraftUser, onDeviceCode, data, botId),
      });
    } catch (err) {
      console.error(`[botmanager] ❌ mineflayer.createBot threw for ${minecraftUser}:`, err.message);
      entry.status = "error";
      entry.spawnError = `Failed to create bot: ${err.message}`;
      cleanupBot(botId, "create_error");
      return;
    }

    entry.bot = bot;

    // ── Hunger / Eating behavior ────────────────────────────────
    // mineflayer fires 'health' whenever bot.food or bot.health changes.
    // bot.food is 0-20; 18 = 1 full bar lost (each bar = 2 points).
    // We eat from the nearest food item in inventory, skipping dangerous foods.

    /**
     * Attempt to eat food. Returns silently if ineligible.
     * Uses mineflayer's high-level equip + consume API which handles
     * the right-click timing and eat animation automatically.
     */
    async function tryEat() {
      if (isEating || Date.now() < eatCooldownUntil) return;
      if (!activeBots.has(botId)) return;
      if (bot.food >= 18) return; // Not hungry enough yet

      // Find the first food item in inventory (hotbar preferred since
      // mineflayer's inventory.items() returns hotbar slots first).
      const foodItem = bot.inventory.items().find(
        (item) => item && BOT_FOOD_ITEMS.has(item.name)
      );
      if (!foodItem) return;

      isEating = true;
      try {
        // Equip food to main hand, then consume (right-click + wait for eat animation).
        await bot.equip(foodItem, "hand");
        await bot.consume();
        eatCooldownUntil = Date.now() + 1500; // 1.5s cooldown between meals
        console.log(
          `[botmanager] 🍖 ${minecraftUser} ate ${foodItem.name} ` +
          `(food: ${bot.food}/20)`
        );
      } catch {
        // Ignore eating errors — item may have moved or bot may be in wrong state.
      } finally {
        isEating = false;
      }
    }

    // React to any food level change from the server.
    bot.on("health", () => {
      if (bot.food < 18) {
        tryEat().catch(() => {});
      }
    });

    // ── Standard bot events ─────────────────────────────────────

    bot.once("login", () => {
      if (!activeBots.has(botId)) return;
      console.log(`[botmanager] ✅ Bot logged in: ${minecraftUser} on ${host}:${port} (${versionToTry})`);
      const e = activeBots.get(botId);
      if (e.spawnTimeoutId) {
        clearTimeout(e.spawnTimeoutId);
        e.spawnTimeoutId = null;
      }
      e.status = "online";
      e.version = versionToTry;

      if (autoMode) {
        versionCache.set(hostLower, versionToTry);
        saveVersionCache();
      }

      saveToken(minecraftUser);

      if (typeof onLinkVerified === "function") {
        try { onLinkVerified(discordId, minecraftUser); } catch (_) {}
      }
    });

    bot.on("kicked", (reason) => {
      if (!activeBots.has(botId)) return;
      const reasonText = typeof reason === "string" ? reason : JSON.stringify(reason);
      console.warn(`[botmanager] 🦵 Bot kicked (${minecraftUser}): ${reasonText}`);

      if (autoMode && shouldRotateVersionForReason(reasonText)) {
        autoVersionIndex++;
        if (autoVersionIndex < autoCandidates.length) {
          const nextVersion = autoCandidates[autoVersionIndex];
          console.log(`[botmanager] 🔄 Auto-version rotate: trying ${nextVersion} for ${minecraftUser}`);
          try { bot.end(); } catch (_) {}
          spawnBot(nextVersion);
          return;
        }
      }

      const e = activeBots.get(botId);
      e.status = "error";
      e.spawnError = `Kicked: ${reasonText}`;

      if (AUTO_RECONNECT) {
        console.log(`[botmanager] 🔄 Reconnecting ${minecraftUser} in ${RECONNECT_DELAY_MS}ms...`);
        e.status = "reconnecting";
        setTimeout(() => {
          if (!activeBots.has(botId)) return;
          try { bot.end(); } catch (_) {}
          spawnBot(e.version);
        }, RECONNECT_DELAY_MS);
      } else {
        cleanupBot(botId, "kicked");
      }
    });

    bot.on("error", (err) => {
      if (!activeBots.has(botId)) return;
      const e = activeBots.get(botId);

      const errCode = err.code;
      const errMessage = err.message || "";

      console.error(`[botmanager] ❌ Bot error (${minecraftUser}):`, errMessage);

      // ── Auth error dedup ───────────────────────────────────
      const isAuthError =
        errMessage.includes("invalid_grant") ||
        errMessage.includes("AADSTS") ||
        errMessage.includes("authentication") ||
        errMessage.toLowerCase().includes("token");

      if (isAuthError) {
        if (handledAuthErrors.has(botId)) {
          console.warn(`[botmanager] 🔇 Suppressing duplicate auth error for ${minecraftUser}`);
          return;
        }
        handledAuthErrors.add(botId);
        setTimeout(() => handledAuthErrors.delete(botId), AUTH_ERROR_DEDUP_TTL_MS);

        clearAuthCache(minecraftUser);
        e.status = "error";
        e.spawnError = "Microsoft authentication failed. Run /mcbot start again to sign in.";
        e.errorCategory = "auth_error";
        cleanupBot(botId, "auth_error");
        return;
      }

      if (isFatalNetworkError(errCode, errMessage)) {
        e.status = "error";
        e.spawnError = getFatalErrorMessage(errCode, errMessage);
        cleanupBot(botId, "fatal_network_error");
        return;
      }

      e.status = "error";
      e.spawnError = errMessage;

      if (AUTO_RECONNECT) {
        console.log(`[botmanager] 🔄 Reconnecting ${minecraftUser} in ${RECONNECT_DELAY_MS}ms (error)...`);
        e.status = "reconnecting";
        setTimeout(() => {
          if (!activeBots.has(botId)) return;
          try { bot.end(); } catch (_) {}
          spawnBot(e.version);
        }, RECONNECT_DELAY_MS);
      } else {
        cleanupBot(botId, "error");
      }
    });

    bot.on("end", (reason) => {
      if (!activeBots.has(botId)) return;
      const e = activeBots.get(botId);
      if (e.status === "online" || e.status === "connecting") {
        console.log(`[botmanager] 🔌 Bot disconnected (${minecraftUser}): ${reason}`);
        e.status = "error";
        e.spawnError = `Disconnected: ${reason}`;

        if (AUTO_RECONNECT) {
          e.status = "reconnecting";
          setTimeout(() => {
            if (!activeBots.has(botId)) return;
            spawnBot(e.version);
          }, RECONNECT_DELAY_MS);
        } else {
          cleanupBot(botId, "end");
        }
      }
    });
  }

  spawnBot(effectiveVersion);

  console.log(`[botmanager] 🚀 Bot spawned for ${minecraftUser} (botId: ${botId})`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  return { success: true, botId };
}

// ============================================================
// STOP / CLEANUP
// ============================================================

/**
 * Stop a specific bot by discordId + minecraftUser.
 */
function stopBot(discordId, minecraftUser) {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`[botmanager] 🛑 Stopping bot — discordId: ${discordId}, mc: ${minecraftUser}`);

  const botId = makeBotId(discordId, minecraftUser);
  const entry = activeBots.get(botId);
  if (!entry) {
    console.warn(`[botmanager] ⚠️ No bot running for ${botId}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    return { success: false, reason: "no_bot_running" };
  }

  cleanupBot(botId, "manual_stop");
  console.log(`[botmanager] ✅ Bot stopped for ${minecraftUser}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  return { success: true };
}

/**
 * Stop ALL bots for a given discordId (convenience).
 */
function stopBotsForUser(discordId) {
  console.log(`[botmanager] 🛑 Stopping all bots for discordId: ${discordId}`);
  const prefix = `${discordId}:`;
  let count = 0;
  for (const botId of [...activeBots.keys()]) {
    if (botId.startsWith(prefix)) {
      cleanupBot(botId, "stop_user_all");
      count++;
    }
  }
  return { success: true, stopped: count };
}

function stopAllBots() {
  const count = activeBots.size;
  console.log(`[botmanager] 🚨 Stopping all ${count} bot(s)`);
  for (const botId of [...activeBots.keys()]) {
    cleanupBot(botId, "stopall");
  }
  return { success: true, stopped: count };
}

function cleanupBot(botId, reason) {
  const entry = activeBots.get(botId);
  if (!entry) return;

  if (entry.spawnTimeoutId) {
    clearTimeout(entry.spawnTimeoutId);
    entry.spawnTimeoutId = null;
  }

  activeBots.delete(botId);

  try { entry.bot.quit(); } catch (_) {}
  try { entry.bot.end(); } catch (_) {}

  console.log(`[botmanager] 🧹 Cleaned up bot for ${entry.minecraftUser} (reason: ${reason})`);
}

// ============================================================
// STATUS / LIST
// ============================================================

/**
 * Get status for a specific (discordId, minecraftUser) bot.
 */
function getBotStatus(discordId, minecraftUser) {
  const botId = makeBotId(discordId, minecraftUser);
  const entry = activeBots.get(botId);
  if (!entry) return { found: false };

  return {
    found: true,
    bot: {
      botId: entry.botId,
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
 * Get statuses for ALL bots belonging to a discordId.
 */
function getBotsForUser(discordId) {
  const prefix = `${discordId}:`;
  const bots = [];
  for (const [botId, entry] of activeBots.entries()) {
    if (botId.startsWith(prefix)) {
      bots.push({
        botId: entry.botId,
        discordId: entry.discordId,
        minecraftUser: entry.minecraftUser,
        serverHost: entry.serverHost,
        serverPort: entry.serverPort,
        version: entry.version,
        startedAt: entry.startedAt,
        status: entry.status,
        spawnError: entry.spawnError || null,
        uptimeSeconds: Math.floor((Date.now() - new Date(entry.startedAt).getTime()) / 1000),
      });
    }
  }
  return bots;
}

function getBotCount() {
  return activeBots.size;
}

function listAllBots() {
  return [...activeBots.values()].map((entry) => ({
    botId: entry.botId,
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

module.exports = {
  makeBotId,
  startBot,
  stopBot,
  stopBotsForUser,
  stopAllBots,
  getBotStatus,
  getBotsForUser,
  listAllBots,
  getBotCount,
};