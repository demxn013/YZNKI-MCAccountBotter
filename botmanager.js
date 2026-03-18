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
// ============================================================
const activeBots = new Map();

// ============================================================
// AUTH ERROR DEDUP GUARD
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
// Errors that should never trigger a reconnect loop because
// retrying will never succeed without user intervention.
// ============================================================

function isFatalNetworkError(errCode, errMessage) {
  const FATAL_CODES = new Set([
    "ENOTFOUND",   // DNS resolution failed — hostname doesn't exist
    "EAI_AGAIN",   // DNS temporarily unavailable (transient but still fatal for loop)
    "EAI_NONAME",  // DNS name does not exist
    "ECONNREFUSED",// Port is closed — server is down
    "ENETUNREACH", // No route to host
    "EHOSTUNREACH",// Host unreachable
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

function handleDeviceCode(minecraftUser, onDeviceCode, deviceCodeResponse, discordId) {
  const {
    user_code: userCode,
    verification_uri: verificationUri,
    expires_in: expiresIn,
    interval,
  } = deviceCodeResponse;

  const effectiveExpiresIn = expiresIn || 900;

  const entry = discordId
    ? activeBots.get(discordId)
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

    if (discordId) {
      setTimeout(() => cleanupBot(discordId, "auth_second_code"), 0);
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
      if (!activeBots.has(discordId)) return;
      const e = activeBots.get(discordId);
      if (e.status !== "connecting") return;
      console.warn(`[botmanager] ⏰ Spawn timeout for ${minecraftUser} after 300s (auth) — cleaning up`);
      e.spawnError =
        "Authentication timed out — the Microsoft device code was not redeemed in time. " +
        "Run /mcbot start again to get a new code.";
      e.status = "error";
      setTimeout(() => cleanupBot(discordId, "spawn_timeout"), 30000);
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

  handledAuthErrors.delete(discordId);

  if (activeBots.has(discordId)) {
    const existing = activeBots.get(discordId);
    console.warn(`[botmanager] ⚠️ User already has an active bot on ${existing.serverHost}:${existing.serverPort}`);
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
  let effectiveVersion = autoMode ? (cached || autoCandidates[0] || "1.20.4") : requestedVersion;

  const linkOnly = typeof onLinkVerified === "function";
  const profilesFolder = ensureAccountDir(minecraftUser);

  const cachedToken = loadToken(minecraftUser);
  const needsInteractiveAuth = !cachedToken;

  if (cachedToken) {
    console.log(`[botmanager] 🔑 Using cached Microsoft token for ${minecraftUser} (${profilesFolder})`);
  } else {
    console.log(`[botmanager] 🔑 No cached token for ${minecraftUser} — device code auth will be required`);
  }

  let bot;
  try {
    bot = mineflayer.createBot({
      host,
      port,
      username: minecraftUser,
      version: effectiveVersion,
      auth: "microsoft",
      profilesFolder,
      hideErrors: false,
      logErrors: true,
      onMsaCode: (deviceCodeResponse) => {
        handleDeviceCode(minecraftUser, onDeviceCode, deviceCodeResponse, discordId);
      },
    });
  } catch (err) {
    console.error(`[botmanager] ❌ Failed to create bot:`, err.message);
    const errLower = (err.message || "").toLowerCase();
    if (autoMode && (errLower.includes("not supported") || errLower.includes("unsupported version"))) {
      if (versionCache.has(hostLower)) {
        console.warn(`[botmanager] 🗑️ Evicting unsupported cached version "${versionCache.get(hostLower)}" for ${hostLower}`);
        versionCache.delete(hostLower);
        saveVersionCache();
      }
    }
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
    return { success: false, reason: "bot_creation_failed", error: err.message };
  }

  // Spawn timeout — 45s if tokens are cached (fast path), 5 min if auth needed.
  const spawnTimeoutMs = (linkOnly || needsInteractiveAuth) ? 5 * 60 * 1000 : 45 * 1000;

  const entry = {
    bot,
    discordId,
    minecraftUser,
    serverHost: host,
    serverPort: port,
    version: effectiveVersion,
    requestedVersion,
    autoMode,
    autoCandidates,
    autoCandidateIndex: autoMode ? Math.max(0, autoCandidates.indexOf(effectiveVersion)) : -1,
    startedAt: new Date().toISOString(),
    status: "connecting",
    spawnError: null,
    linkOnly,
    onLinkVerified: linkOnly ? onLinkVerified : null,
    fatalError: false, // ✅ Set to true for unrecoverable errors to block reconnect
  };

  activeBots.set(discordId, entry);

  const spawnTimeoutId = setTimeout(() => {
    if (!activeBots.has(discordId)) return;
    const e = activeBots.get(discordId);
    if (e.status !== "connecting") return;

    const seconds = Math.round(spawnTimeoutMs / 1000);
    console.warn(`[botmanager] ⏰ Spawn timeout for ${minecraftUser} after ${seconds}s — cleaning up`);

    if (needsInteractiveAuth) {
      e.spawnError =
        "Authentication timed out — the Microsoft device code was not redeemed in time. " +
        "Run /mcbot start again to get a new code.";
    } else {
      e.spawnError =
        `Connection timed out — the server did not respond within ${seconds} seconds. ` +
        "Check the server address and version.";
    }

    e.status = "error";
    setTimeout(() => cleanupBot(discordId, "spawn_timeout"), 30000);
  }, spawnTimeoutMs);

  entry.spawnTimeoutId = spawnTimeoutId;

  // Legacy event
  bot.on("microsoft_device_code", (deviceCodeResponse) => {
    handleDeviceCode(minecraftUser, onDeviceCode, deviceCodeResponse, discordId);
  });

  // ============================================================
  // BOT EVENTS
  // ============================================================

  bot.once("login", () => {
    const e = activeBots.get(discordId);
    if (!e) return;
    if (!e.linkOnly || !e.onLinkVerified || e.linkVerifiedSent) return;
    e.linkVerifiedSent = true;
    e.status = "online";
    e.spawnError = null;
    if (e.spawnTimeoutId) clearTimeout(e.spawnTimeoutId);

    const verifiedName = bot.username || minecraftUser;
    try {
      e.onLinkVerified(discordId, verifiedName);
    } catch (err) {
      console.warn(`[botmanager] ⚠️ onLinkVerified threw:`, err.message);
    }
    setTimeout(() => cleanupBot(discordId, "link_verified_login"), 500);
  });

  bot.once("spawn", () => {
    const currentEntry = activeBots.get(discordId);
    if (currentEntry && currentEntry.spawnTimeoutId) {
      clearTimeout(currentEntry.spawnTimeoutId);
    }
    console.log(`[botmanager] ✅ Bot spawned: ${minecraftUser} on ${host}:${port}`);
    if (currentEntry) {
      currentEntry.status = "online";
      currentEntry.spawnError = null;
      currentEntry.everSpawned = true;
      currentEntry.socketClosedReconnects = 0;
      currentEntry.fatalError = false;
    }

    if (autoMode) {
      versionCache.set(hostLower, effectiveVersion);
      saveVersionCache();
    }

    saveToken(minecraftUser);
  });

  bot.on("kicked", (reason) => {
    const currentEntry = activeBots.get(discordId);
    if (currentEntry && currentEntry.spawnTimeoutId) clearTimeout(currentEntry.spawnTimeoutId);

    let reasonText;
    if (typeof reason === "string") {
      try {
        const parsed = JSON.parse(reason);
        reasonText = parsed.text || parsed.translate || reason;
      } catch {
        reasonText = reason;
      }
    } else if (reason && typeof reason === "object") {
      reasonText = reason.text || reason.translate || reason.reason || JSON.stringify(reason);
    } else {
      reasonText = String(reason);
    }

    console.warn(`[botmanager] 🦶 Bot kicked: ${minecraftUser} — ${reasonText}`);
    if (activeBots.has(discordId)) {
      activeBots.get(discordId).spawnError = `Kicked: ${reasonText}`;
      activeBots.get(discordId).status = "error";
    }

    if (autoMode && shouldRotateVersionForReason(reasonText)) {
      const e = activeBots.get(discordId);
      const nextIndex = (e?.autoCandidateIndex ?? -1) + 1;
      const nextVersion = e?.autoCandidates?.[nextIndex];
      if (nextVersion) {
        console.warn(`[botmanager] 🔁 Auto-version retry: ${effectiveVersion} → ${nextVersion} (reason: ${reasonText})`);
        setTimeout(() => {
          cleanupBot(discordId, "auto_version_retry_kicked");
          versionCache.set(hostLower, nextVersion);
          saveVersionCache();
          startBot(discordId, minecraftUser, `${host}:${port}`, "auto", onDeviceCode);
        }, 1500);
        return;
      }
    }

    setTimeout(() => cleanupBot(discordId, "kicked"), 30000);
  });

  bot.on("error", (err) => {
    const currentEntry = activeBots.get(discordId);
    if (currentEntry && currentEntry.spawnTimeoutId) clearTimeout(currentEntry.spawnTimeoutId);

    if (handledAuthErrors.has(discordId)) {
      return;
    }

    console.error(`[botmanager] ❌ Bot error: ${minecraftUser} — ${err.message}`);
    if (currentEntry) {
      currentEntry.spawnError = err.message;
      currentEntry.status = "error";
    }

    // ✅ FATAL ERROR GUARD: DNS failures and unreachable hosts must not trigger
    // the reconnect loop — retrying ENOTFOUND endlessly wastes resources and
    // spams logs. Mark as fatal so bot.on("end") skips reconnect.
    if (isFatalNetworkError(err.code, err.message)) {
      console.warn(`[botmanager] 🚫 Fatal network error for ${minecraftUser} (${err.code || "unknown"}) — disabling reconnect`);
      if (currentEntry) {
        currentEntry.fatalError = true;
        currentEntry.spawnError = getFatalErrorMessage(err.code, err.message);
        currentEntry.status = "error";
      }
      setTimeout(() => cleanupBot(discordId, "fatal_network_error"), 30000);
      return;
    }

    if (autoMode && shouldRotateVersionForReason(err.message) && !(currentEntry && currentEntry.deviceCodeEmitted)) {
      const e = activeBots.get(discordId);
      const nextIndex = (e?.autoCandidateIndex ?? -1) + 1;
      const nextVersion = e?.autoCandidates?.[nextIndex];
      if (nextVersion) {
        console.warn(`[botmanager] 🔁 Auto-version retry: ${effectiveVersion} → ${nextVersion} (error: ${err.message})`);
        setTimeout(() => {
          cleanupBot(discordId, "auto_version_retry_error");
          versionCache.set(hostLower, nextVersion);
          saveVersionCache();
          startBot(discordId, minecraftUser, `${host}:${port}`, "auto", onDeviceCode);
        }, 1500);
        return;
      }
    }

    const msgLower = (err.message || "").toLowerCase();
    const isAuthError =
      msgLower.includes("invalid_grant") ||
      msgLower.includes("device_code") ||
      msgLower.includes("microsoft") ||
      msgLower.includes("auth") ||
      msgLower.includes("token") ||
      msgLower.includes("session") ||
      msgLower.includes("xbox") ||
      msgLower.includes("msa");

    if (isAuthError) {
      handledAuthErrors.add(discordId);
      setTimeout(() => handledAuthErrors.delete(discordId), AUTH_ERROR_DEDUP_TTL_MS);

      console.warn(`[botmanager] 🔑 Auth error detected — clearing cached auth for ${minecraftUser}`);
      clearAuthCache(minecraftUser);

      const e = activeBots.get(discordId);
      if (e) {
        e.deviceCodeExpired = true;
        e.spawnError =
          "Microsoft authentication failed — the sign-in session could not be completed. " +
          "Run /mcbot start again to get a fresh login code.";
      }

      cleanupBot(discordId, "auth_error");
      return;
    }

    setTimeout(() => cleanupBot(discordId, "error"), 30000);
  });

  bot.on("end", (reason) => {
    const currentEntry = activeBots.get(discordId);
    if (currentEntry && currentEntry.spawnTimeoutId) clearTimeout(currentEntry.spawnTimeoutId);

    console.log(`[botmanager] 🔌 Bot disconnected: ${minecraftUser} — reason: ${reason}`);

    // ✅ FATAL ERROR GUARD: If a fatal network error was recorded (e.g. ENOTFOUND),
    // skip reconnect entirely. The error handler already scheduled a cleanup.
    if (currentEntry && currentEntry.fatalError) {
      console.warn(`[botmanager] 🚫 Skipping reconnect for ${minecraftUser} — fatal error flagged (${reason})`);
      return;
    }

    if (AUTO_RECONNECT && activeBots.has(discordId)) {
      const e = activeBots.get(discordId);

      const MAX_PRESPAWN_RECONNECTS = 3;
      if (!e.everSpawned && reason === "socketClosed") {
        e.socketClosedReconnects = (e.socketClosedReconnects || 0) + 1;
        if (e.socketClosedReconnects >= MAX_PRESPAWN_RECONNECTS) {
          console.warn(`[botmanager] ⛔ ${minecraftUser} hit ${MAX_PRESPAWN_RECONNECTS} socketClosed failures before spawning — giving up.`);
          e.status = "error";
          e.spawnError =
            `The server closed the connection ${MAX_PRESPAWN_RECONNECTS} times before the bot could spawn. ` +
            `The server may be running a version newer than 1.21.4 (which mineflayer does not support) or may be temporarily blocking connections. ` +
            `Try again later or use a different server.`;
          setTimeout(() => cleanupBot(discordId, "socket_closed_max_retries"), 30000);
          return;
        }
        console.log(`[botmanager] 🔄 socketClosed before spawn (attempt ${e.socketClosedReconnects}/${MAX_PRESPAWN_RECONNECTS}) — retrying in ${RECONNECT_DELAY_MS}ms for ${minecraftUser}...`);
      } else {
        console.log(`[botmanager] 🔄 Auto-reconnect in ${RECONNECT_DELAY_MS}ms for ${minecraftUser}...`);
      }

      e.status = "reconnecting";
      setTimeout(() => {
        if (activeBots.has(discordId) && activeBots.get(discordId).status === "reconnecting") {
          cleanupBot(discordId, "reconnect_cycle");
          const result = startBot(discordId, minecraftUser, `${host}:${port}`, version, onDeviceCode, onLinkVerified);
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
// STOP / CLEANUP
// ============================================================

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

function stopAllBots() {
  const count = activeBots.size;
  console.log(`[botmanager] 🚨 Stopping all ${count} bot(s)`);
  for (const discordId of [...activeBots.keys()]) {
    cleanupBot(discordId, "stopall");
  }
  return { success: true, stopped: count };
}

function cleanupBot(discordId, reason) {
  const entry = activeBots.get(discordId);
  if (!entry) return;

  if (entry.spawnTimeoutId) {
    clearTimeout(entry.spawnTimeoutId);
    entry.spawnTimeoutId = null;
  }

  activeBots.delete(discordId);

  try { entry.bot.quit(); } catch (_) {}
  try { entry.bot.end(); } catch (_) {}

  console.log(`[botmanager] 🧹 Cleaned up bot for ${entry.minecraftUser} (reason: ${reason})`);
}

// ============================================================
// STATUS / LIST
// ============================================================

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

function getBotCount() {
  return activeBots.size;
}

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

module.exports = {
  startBot,
  stopBot,
  stopAllBots,
  getBotStatus,
  listAllBots,
  getBotCount,
};