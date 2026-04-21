// yazanaki/mcbot/botmanager.js (VPS-side)
// Manages mineflayer bots with Microsoft auth, device-code relay,
// link verification, version auto-detection, and auth error dedup.

"use strict";

const mineflayer = require("mineflayer");
const fs = require("fs");
const path = require("path");

// ============================================================
// TOKEN CACHE — persists Microsoft tokens between restarts
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

function loadToken(username) {
  const dir = accountTokenDir(username);
  if (!fs.existsSync(dir)) return undefined;

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
// ============================================================
const activeBots = new Map();

// ============================================================
// RECENTLY ENDED BOTS
// ============================================================
const recentlyEndedBots = [];

function recordEndedBot(entry, endReason) {
  if (endReason === "manual_stop" || endReason === "stopall" || endReason === "stop_user_all") return;

  recentlyEndedBots.push({
    botId:          entry.botId,
    discordId:      entry.discordId,
    minecraftUser:  entry.minecraftUser,
    serverHost:     entry.serverHost,
    serverPort:     entry.serverPort,
    version:        entry.version,
    endReason,
    spawnError:     entry.spawnError || null,
    lastKickReason: entry.lastKickReason || null,
    errorCategory:  entry.errorCategory || null,
    endedAt:        new Date().toISOString(),
  });
}

function getAndClearRecentlyEnded() {
  const snapshot = [...recentlyEndedBots];
  recentlyEndedBots.length = 0;
  return snapshot;
}

// ============================================================
// AUTH ERROR DEDUP GUARD
// ============================================================
const handledAuthErrors = new Set();
const AUTH_ERROR_DEDUP_TTL_MS = 10 * 60 * 1000;

const AUTO_RECONNECT = process.env.AUTO_RECONNECT === "true";
const RECONNECT_DELAY_MS = parseInt(process.env.RECONNECT_DELAY_MS || "5000", 10);
const MAX_BOTS = parseInt(process.env.MAX_BOTS || "0", 10);

// ============================================================
// DONUTSMP SETTINGS
// ============================================================
const DONUTSMP_HOST_PATTERNS = ["donutsmp.net", "donutsmp"];
const DONUTSMP_MAX_VERIFICATION_RETRIES = 10;
const DONUTSMP_VERIFICATION_RECONNECT_DELAY_MS = 5000;
const DONUTSMP_STRICT_VERSION = "1.21.11";

// How long after login to suppress packets.
// Increased from 15s → 30s: DonutSMP's chunk loading + sequence
// checker needs more time to settle before we send anything.
const DONUTSMP_POST_LOGIN_QUIET_MS = 30000;

// Additional delay after quiet window before re-enabling physics.
// Gives mineflayer's internal state time to sync before it starts
// emitting position packets, avoiding a burst right at quiet-end.
const DONUTSMP_PHYSICS_RESUME_DELAY_MS = 3000;
const DONUTSMP_POST_UNMUTE_GRACE_MS = 2000;

// Packets suppressed during the quiet window (dropped entirely).
const DONUTSMP_QUIET_SUPPRESS = new Set([
  "position",      // player movement
  "look",          // head rotation
  "position_look", // combined move+look
  "flying",        // on-ground packet
  "settings",      // client settings — can trigger sequence tracking on DonutSMP
]);

const DONUTSMP_DEBUG_LEVEL = String(process.env.DONUTSMP_DEBUG || "minimal").toLowerCase();
const DONUTSMP_LOG_PACKET_LIMIT = Math.max(5, parseInt(process.env.DONUTSMP_LOG_PACKET_LIMIT || "60", 10));

function donutDebugEnabled(level) {
  if (DONUTSMP_DEBUG_LEVEL === "forensic") return true;
  if (DONUTSMP_DEBUG_LEVEL === "detailed") return level !== "forensic";
  return level === "minimal";
}

function jitterMs(baseMs, pct = 0.15) {
  const span = Math.floor(baseMs * pct);
  return baseMs + Math.floor((Math.random() * ((span * 2) + 1)) - span);
}

function nowDelta(connectedSince) {
  if (!connectedSince) return "t+?.???s";
  return `t+${((Date.now() - connectedSince) / 1000).toFixed(3)}s`;
}

function isDonutSmpHost(host) {
  if (!host) return false;
  const lower = host.toLowerCase();
  const matched = DONUTSMP_HOST_PATTERNS.some(p => lower.includes(p));
  if (matched && donutDebugEnabled("detailed")) {
    console.log(`[botmanager] 🧭 Donut host matched: input=${host} normalized=${lower}`);
  }
  return matched;
}

function isDonutSmpVerificationKick(reasonText) {
  if (!reasonText) return false;
  const t = reasonText.toLowerCase();
  return (
    t.includes("unauthorized login") ||
    t.includes("blocked it") ||
    t.includes("confirm it via the button") ||
    t.includes("possible unauthorized")
  );
}

function isDonutSmpVerificationDisconnect(reason, connectedSince) {
  if (!reason) return false;
  const r = typeof reason === "string" ? reason.toLowerCase() : JSON.stringify(reason).toLowerCase();
  if (!r.includes("socketclosed")) return false;
  if (connectedSince === null) return true;
  const secondsOnline = Math.floor((Date.now() - connectedSince) / 1000);
  return secondsOnline < 30;
}

// ============================================================
// VERSION CACHE
// ============================================================
const VERSION_CACHE_PATH = path.join(__dirname, "version-cache.json");
const versionCache = new Map();

const SUPPORTED_VERSIONS = new Set([
  "1.21.11", "1.21.4", "1.21.3", "1.21.2", "1.21.1", "1.21",
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
// HUNGER MANAGEMENT
// ============================================================
const BOT_FOOD_ITEMS = new Set([
  "cooked_beef", "cooked_porkchop", "cooked_chicken", "cooked_mutton",
  "cooked_rabbit", "cooked_cod", "cooked_salmon",
  "beef", "porkchop", "chicken", "mutton", "rabbit", "cod", "salmon",
  "bread", "cookie", "pumpkin_pie",
  "apple", "golden_apple", "enchanted_golden_apple",
  "carrot", "golden_carrot", "melon_slice",
  "baked_potato", "potato", "beetroot",
  "sweet_berries", "glow_berries",
  "tropical_fish", "dried_kelp",
  "honey_bottle",
  "mushroom_stew", "beetroot_soup", "rabbit_stew",
  "chorus_fruit",
]);

// ============================================================
// VERSION AUTO-DETECTION HELPERS
// ============================================================
function getAutoCandidatesForHost(hostLower) {
  return [
    "1.21.11", "1.21.4", "1.21.1", "1.21",
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
    "ENOTFOUND", "EAI_AGAIN", "EAI_NONAME",
    "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH",
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
  } = deviceCodeResponse;

  const effectiveExpiresIn = expiresIn || 900;

  const entry = botId
    ? activeBots.get(botId)
    : [...activeBots.values()].find(
        (e) => e.minecraftUser === minecraftUser && e.status === "connecting",
      );

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
function makeBotId(discordId, minecraftUser) {
  return `${discordId}:${minecraftUser.toLowerCase()}`;
}

// ============================================================
// CLIENT SETTINGS SENDER (non-DonutSMP only)
// ============================================================
function sendClientSettings(bot, username, context) {
  const ctx = context || "unknown";
  if (bot && bot.__donutStrictMode) {
    console.warn(`[botmanager] 🚫 [${username}] Blocked client settings in Donut strict mode (context: ${ctx})`);
    return;
  }
  console.log(`[botmanager] 📋 [${username}] Attempting to send client settings (context: ${ctx})`);
  try {
    bot._client.write("settings", {
      locale: "en_US",
      viewDistance: 8,
      chatFlags: 0,
      chatColors: true,
      skinParts: 127,
      mainHand: 1,
      enableTextFiltering: false,
      enableServerListing: true,
    });
    console.log(`[botmanager] 📋 [${username}] Client settings sent successfully (context: ${ctx})`);
  } catch (err) {
    console.warn(`[botmanager] ⚠️ [${username}] Could not send client settings:`, err.message);
  }
}

// ============================================================
// DONUTSMP QUIET WINDOW
//
// ROOT CAUSE: DonutSMP runs a strict packet sequence checker.
// The quiet window suppresses all packets that affect DonutSMP's
// sequence counters during and after chunk loading.
//
// KEY CHANGES vs previous version:
//   - Quiet window extended to 30s (was 15s) — chunk loading needs
//     more time to fully settle before any packets are safe to send.
//   - "settings" added to suppress list — client settings can
//     trigger a sequence check on DonutSMP's plugin layer.
//   - Physics re-enable is deferred by DONUTSMP_PHYSICS_RESUME_DELAY_MS
//     (3s) after the quiet window ends, preventing an immediate burst
//     of position packets at the moment the proxy is removed.
//   - No client settings are sent on DonutSMP at all (ever) — the
//     server does not require them and they risk triggering the checker.
//   - DonutSmpProfile.tick() respects entry.donutSmpReadyAt before
//     sending any look packets, controlled via a timestamp set here.
// ============================================================
function installDonutSmpQuietProxy(bot, entry, botId, minecraftUser) {
  const quietStart = Date.now();
  const quietEnd = quietStart + DONUTSMP_POST_LOGIN_QUIET_MS;
  const postUnmuteGraceEnd = quietEnd + DONUTSMP_POST_UNMUTE_GRACE_MS;
  const resumeDelayMs = jitterMs(DONUTSMP_PHYSICS_RESUME_DELAY_MS);
  const resumeAt = postUnmuteGraceEnd + resumeDelayMs;

  entry.donutSmpQuietUntil = quietEnd;
  entry.donutSmpPostUnmuteGraceUntil = postUnmuteGraceEnd;
  // Mark when it's truly safe for the profile tick to send look packets.
  // This is quiet window + post-unmute grace + jittered physics resume + buffer.
  entry.donutSmpReadyAt = resumeAt + 2000;

  // Disable mineflayer physics to stop position/look spam at the source.
  if (bot.physicsEnabled !== undefined) {
    bot.physicsEnabled = false;
    console.log(`[botmanager] 🟠 [${minecraftUser}] Physics disabled`);
  }

  const origWrite = bot._client.write.bind(bot._client);
  let eventSeq = 0;
  let postUnmuteLogged = 0;
  const suppressedCounts = Object.create(null);
  const passedCounts = Object.create(null);
  const passthroughSampleKeys = new Set([
    "position", "position_look", "look", "flying", "use_item", "held_item_slot", "settings", "pong",
  ]);

  bot._client.write = function donutSmpQuietProxy(name, params) {
    const now = Date.now();
    if (now < quietEnd && DONUTSMP_QUIET_SUPPRESS.has(name)) {
      suppressedCounts[name] = (suppressedCounts[name] || 0) + 1;
      if (donutDebugEnabled("forensic")) {
        console.log(
          `[botmanager] 🔬 [${minecraftUser}] #${++eventSeq} ${nowDelta(entry.connectedSince)} suppress(${name}) ` +
          `count=${suppressedCounts[name]}`
        );
      }
      // Drop silently — no queue, no flush.
      return;
    }
    if (now < postUnmuteGraceEnd && DONUTSMP_QUIET_SUPPRESS.has(name)) {
      suppressedCounts[name] = (suppressedCounts[name] || 0) + 1;
      if (donutDebugEnabled("detailed")) {
        console.log(
          `[botmanager] 🔬 [${minecraftUser}] #${++eventSeq} ${nowDelta(entry.connectedSince)} grace-block(${name}) ` +
          `count=${suppressedCounts[name]}`
        );
      }
      // Drop silently — no queue, no flush.
      return;
    }
    passedCounts[name] = (passedCounts[name] || 0) + 1;
    if (
      donutDebugEnabled("forensic") &&
      postUnmuteLogged < DONUTSMP_LOG_PACKET_LIMIT &&
      passthroughSampleKeys.has(name)
    ) {
      postUnmuteLogged++;
      const payload = params && typeof params === "object"
        ? `keys=[${Object.keys(params).slice(0, 6).join(",")}]`
        : "keys=[]";
      console.log(
        `[botmanager] 🔬 [${minecraftUser}] #${++eventSeq} ${nowDelta(entry.connectedSince)} pass(${name}) ${payload}`
      );
    }
    return origWrite(name, params);
  };

  console.log(
    `[botmanager] 🟠 [${minecraftUser}] DonutSMP quiet proxy active — ` +
    `suppressing [${[...DONUTSMP_QUIET_SUPPRESS].join(", ")}] for ${DONUTSMP_POST_LOGIN_QUIET_MS / 1000}s`
  );
  if (donutDebugEnabled("detailed")) {
    console.log(
      `[botmanager] 🔬 [${minecraftUser}] quietStart=${quietStart} quietEnd=${quietEnd} ` +
      `graceEnd=${postUnmuteGraceEnd} physicsResumeAt~${resumeAt} readyAt=${entry.donutSmpReadyAt}`
    );
  }

  const quietTimer = setTimeout(() => {
    // Guard: bot may have disconnected during the quiet window.
    if (!activeBots.has(botId)) return;
    if (entry.bot !== bot) return;

    // Restore original write — packets can now flow normally.
    bot._client.write = origWrite;
    entry.donutSmpQuietUntil = 0;

    console.log(`[botmanager] 🟠 [${minecraftUser}] DonutSMP quiet proxy removed — entering post-unmute grace ${DONUTSMP_POST_UNMUTE_GRACE_MS / 1000}s`);

    // Stagger physics re-enable: give the server a moment after we start
    // accepting packets before mineflayer's tick loop floods position updates.
    setTimeout(() => {
      if (!activeBots.has(botId)) return;
      if (entry.bot !== bot) return;

      if (bot.physicsEnabled !== undefined) {
        bot.physicsEnabled = true;
        console.log(`[botmanager] 🟠 [${minecraftUser}] Physics re-enabled (delay ${resumeDelayMs}ms)`);
      }

      console.log(`[botmanager] 🟠 [${minecraftUser}] DonutSMP fully settled — normal operation resumed`);
      if (donutDebugEnabled("forensic")) {
        console.log(
          `[botmanager] 🔬 [${minecraftUser}] suppressSummary=${JSON.stringify(suppressedCounts)} ` +
          `passSummary=${JSON.stringify(passedCounts)}`
        );
      }
      // NOTE: We intentionally do NOT send client settings on DonutSMP.
      // The server does not require them and sending them risks triggering
      // DonutSMP's sequence checker post-quiet-window.
    }, DONUTSMP_POST_UNMUTE_GRACE_MS + resumeDelayMs);

  }, DONUTSMP_POST_LOGIN_QUIET_MS);

  if (quietTimer.unref) quietTimer.unref();
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
  const requestedVersion = (version || "auto").trim();
  const autoMode = requestedVersion.toLowerCase() === "auto";
  const autoCandidates = autoMode ? getAutoCandidatesForHost(hostLower) : [];
  const cached = autoMode ? versionCache.get(hostLower) : null;
  let effectiveVersion = autoMode
    ? (cached || autoCandidates[0] || "1.21.11")
    : requestedVersion;

  let autoVersionIndex = autoMode
    ? Math.max(0, autoCandidates.indexOf(effectiveVersion))
    : -1;

  const tokenDir = ensureAccountDir(minecraftUser);
  const isDonutSmp = isDonutSmpHost(hostLower);
  if (isDonutSmp && effectiveVersion !== DONUTSMP_STRICT_VERSION) {
    console.warn(`[botmanager] 🛡️ DonutSMP strict version override: ${effectiveVersion} -> ${DONUTSMP_STRICT_VERSION}`);
    effectiveVersion = DONUTSMP_STRICT_VERSION;
  }

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
    isDonutSmp,
    donutSmpVerificationRetries: 0,
    connectedSince: null,
    donutSmpQuietUntil: 0,
    donutSmpPostUnmuteGraceUntil: 0,
    // Timestamp after which DonutSmpProfile.tick() may send look packets.
    // Set by installDonutSmpQuietProxy; 0 = not yet connected.
    donutSmpReadyAt: 0,
  };

  activeBots.set(botId, entry);

  let isEating = false;
  let eatCooldownUntil = 0;

  const initialSpawnTimeoutMs = isDonutSmp ? 90000 : 30000;

  entry.spawnTimeoutId = setTimeout(() => {
    if (!activeBots.has(botId)) return;
    const e = activeBots.get(botId);
    if (e.status !== "connecting" && e.status !== "reconnecting") return;
    if (e.deviceCodeEmitted) return;
    console.warn(`[botmanager] ⏰ Spawn timeout for ${minecraftUser} after ${Math.round(initialSpawnTimeoutMs / 1000)}s (${e.donutSmpVerificationRetries} retries attempted) — giving up`);
    e.spawnError = isDonutSmp
      ? "DonutSMP security check timed out — the verification was not completed in time. Please confirm the login via the DonutSMP Discord bot DM, then try /mcbot start again."
      : "Bot failed to connect within 30 seconds. The server may be offline or unreachable.";
    e.status = "error";
    if (isDonutSmp) e.errorCategory = "donutsmp_verification";
    cleanupBot(botId, "spawn_timeout");
  }, initialSpawnTimeoutMs);

  function spawnBot(versionToTry) {
    entry.version = versionToTry;
    entry.connectedSince = null;
    entry.donutSmpQuietUntil = 0;
    entry.donutSmpReadyAt = 0;

    if (entry.donutSmpVerificationRetries > 0) {
      console.log(
        `[botmanager] 🟠 DonutSMP retry attempt ${entry.donutSmpVerificationRetries}/${DONUTSMP_MAX_VERIFICATION_RETRIES} ` +
        `for ${minecraftUser} — connecting to ${host}:${port}...`
      );
    }

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
        checkTimeoutInterval: 30 * 1000,
      });
      bot.__donutStrictMode = isDonutSmp;
    } catch (err) {
      console.error(`[botmanager] ❌ mineflayer.createBot threw for ${minecraftUser}:`, err.message);
      entry.status = "error";
      entry.spawnError = `Failed to create bot: ${err.message}`;
      cleanupBot(botId, "create_error");
      return;
    }

    entry.bot = bot;
    let kickHandled = false;
    let eventOrder = 0;
    const logEventOrder = (eventName, extra = "") => {
      if (!isDonutSmp || !donutDebugEnabled("detailed")) return;
      console.log(`[botmanager] 🔬 [${minecraftUser}] event#${++eventOrder} ${eventName} ${nowDelta(entry.connectedSince)} status=${entry.status}${extra ? ` ${extra}` : ""}`);
    };

    // ── Hunger ───────────────────────────────────────────────────────────────
    async function tryEat() {
      if (isEating || Date.now() < eatCooldownUntil) return;
      if (!activeBots.has(botId)) return;
      // Don't eat during DonutSMP quiet window or before ready
      if (isDonutSmp && Date.now() < entry.donutSmpReadyAt) {
        if (donutDebugEnabled("forensic")) {
          console.log(`[botmanager] 🔬 [${minecraftUser}] eat blocked before readyAt=${entry.donutSmpReadyAt}`);
        }
        return;
      }
      if (bot.food >= 18) return;

      const foodItem = bot.inventory.items().find(
        (item) => item && BOT_FOOD_ITEMS.has(item.name)
      );
      if (!foodItem) return;

      isEating = true;
      try {
        await bot.equip(foodItem, "hand");
        await bot.consume();
        eatCooldownUntil = Date.now() + 1500;
        console.log(`[botmanager] 🍖 ${minecraftUser} ate ${foodItem.name} (food: ${bot.food}/20)`);
      } catch {
        // Ignore eating errors
      } finally {
        isEating = false;
      }
    }

    bot.on("health", () => {
      if (bot.food < 18) {
        tryEat().catch(() => {});
      }
    });

    // ── Login ─────────────────────────────────────────────────────────────────
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
      e.connectedSince = Date.now();
      logEventOrder("login", `version=${versionToTry}`);

      if (autoMode) {
        versionCache.set(hostLower, versionToTry);
        saveVersionCache();
      }

      saveToken(minecraftUser);

      if (isDonutSmp) {
        // Install the quiet proxy — suppresses all sequence-sensitive packets
        // during chunk loading. Physics re-enable is staggered after proxy removal.
        installDonutSmpQuietProxy(bot, e, botId, minecraftUser);

        console.log(
          `[botmanager] 🟠 DonutSMP login detected — monitoring for verification screen disconnect ` +
          `(retry ${e.donutSmpVerificationRetries}/${DONUTSMP_MAX_VERIFICATION_RETRIES})`
        );
      } else {
        // Non-DonutSMP: send client settings 1s after login.
        setTimeout(() => {
          if (!activeBots.has(botId)) return;
          if (entry.bot !== bot) return;
          sendClientSettings(bot, minecraftUser, "post-login");
        }, 1000);
      }

      if (typeof onLinkVerified === "function") {
        try { onLinkVerified(discordId, minecraftUser); } catch (_) {}
      }
    });

    // ── Spawn ─────────────────────────────────────────────────────────────────
    bot.once("spawn", () => {
      if (!activeBots.has(botId)) return;
      logEventOrder("spawn");
      if (isDonutSmp) {
        console.log(`[botmanager] 🟠 DonutSMP spawn fired for ${minecraftUser} — quiet proxy active`);
      }
    });

    // ── Kicked ───────────────────────────────────────────────────────────────
    bot.on("kicked", (reason) => {
      if (!activeBots.has(botId)) return;
      const reasonText = typeof reason === "string" ? reason : JSON.stringify(reason);
      logEventOrder("kicked", `reason=${reasonText}`);
      console.warn(`[botmanager] 🦵 Bot kicked (${minecraftUser}): ${reasonText}`);

      const e = activeBots.get(botId);

      if (entry.bot !== bot) return;

      if (e.status === "reconnecting" && !e.isDonutSmp) {
        console.log(`[botmanager] 🟠 Ignoring kicked event for ${minecraftUser} — retry already scheduled`);
        return;
      }

      if (e.isDonutSmp && isDonutSmpVerificationKick(reasonText)) {
        console.log(`[botmanager] 🟠 DonutSMP verification kick for ${minecraftUser} — waiting for end event to schedule retry`);
        kickHandled = true;
        return;
      }

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

    // ── Error ─────────────────────────────────────────────────────────────────
    bot.on("error", (err) => {
      if (!activeBots.has(botId)) return;
      const e = activeBots.get(botId);
      const errCode = err.code;
      const errMessage = err.message || "";
      logEventOrder("error", `code=${errCode || "none"}`);

      console.error(`[botmanager] ❌ Bot error (${minecraftUser}):`, errMessage);

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

    // ── End ───────────────────────────────────────────────────────────────────
    bot.on("end", (reason) => {
      if (!activeBots.has(botId)) return;
      const e = activeBots.get(botId);

      if (entry.bot !== bot) return;

      logEventOrder("end", `reason=${reason}`);
      if (e.status !== "online" && e.status !== "connecting" && e.status !== "reconnecting") return;
      if (e.status === "reconnecting" && !e.isDonutSmp) return;

      console.log(`[botmanager] 🔌 Bot disconnected (${minecraftUser}): ${reason}`);

      const isVerificationEvent =
        (e.isDonutSmp && isDonutSmpVerificationDisconnect(reason, e.connectedSince)) ||
        kickHandled;
      kickHandled = false;

      if (isVerificationEvent && e.isDonutSmp) {
        if (e.donutSmpVerificationRetries < DONUTSMP_MAX_VERIFICATION_RETRIES) {
          e.donutSmpVerificationRetries++;
          const phaseLabel = isDonutSmpVerificationDisconnect(reason, e.connectedSince)
            ? (e.connectedSince === null ? "pre-login socketClosed" : "post-login socketClosed")
            : "verification kick";
          console.log(
            `[botmanager] 🟠 DonutSMP ${phaseLabel} for ${minecraftUser} ` +
            `(attempt ${e.donutSmpVerificationRetries}/${DONUTSMP_MAX_VERIFICATION_RETRIES}) — reconnecting in ${DONUTSMP_VERIFICATION_RECONNECT_DELAY_MS}ms`
          );
          e.status = "reconnecting";
          e.spawnError = null;
          setTimeout(() => {
            if (!activeBots.has(botId)) return;
            try { bot.end(); } catch (_) {}
            spawnBot(e.version);
          }, DONUTSMP_VERIFICATION_RECONNECT_DELAY_MS);
          return;
        } else {
          console.warn(`[botmanager] 🟠 DonutSMP verification retries exhausted for ${minecraftUser} — reporting error to user`);
          e.status = "error";
          e.spawnError =
            "DonutSMP is requiring account verification before allowing you to join. " +
            "Please log into DonutSMP manually once to complete the verification process, " +
            "then try /mcbot start again.";
          e.errorCategory = "donutsmp_verification";
          cleanupBot(botId, "donutsmp_verification_failed");
          return;
        }
      }

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
  recordEndedBot(entry, reason);

  try { entry.bot.quit(); } catch (_) {}
  try { entry.bot.end(); } catch (_) {}

  console.log(`[botmanager] 🧹 Cleaned up bot for ${entry.minecraftUser} (reason: ${reason})`);
}

// ============================================================
// STATUS / LIST
// ============================================================
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
      errorCategory: entry.errorCategory || null,
      uptimeSeconds: Math.floor((Date.now() - new Date(entry.startedAt).getTime()) / 1000),
      donutSmpVerificationRetries: entry.isDonutSmp ? entry.donutSmpVerificationRetries : undefined,
    },
  };
}

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
        errorCategory: entry.errorCategory || null,
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
  getAndClearRecentlyEnded,
};