// yazanaki/mcbot/botmanager.js (VPS-side)
// Manages mineflayer bots with Microsoft auth, device-code relay,
// link verification, version auto-detection, and auth error dedup.

"use strict";

const mineflayer = require("mineflayer");
const fs = require("fs");
const path = require("path");

// ============================================================
// TOKEN CACHE — persists Microsoft tokens between restarts
// Stored at ./tokens/<username>.json  (lowercased marker file)
// prismarine-auth manages its own hash-prefixed cache files
// alongside our marker — both are checked and cleared together.
// ============================================================
const TOKENS_DIR = path.join(__dirname, "tokens");

if (!fs.existsSync(TOKENS_DIR)) {
  fs.mkdirSync(TOKENS_DIR, { recursive: true });
}

function tokenPath(username) {
  return path.join(TOKENS_DIR, `${username.toLowerCase()}.json`);
}

/**
 * Check whether a valid per-user Microsoft auth marker exists for this username.
 *
 * IMPORTANT: Only our own per-user marker file (an object with { cachedAt, username })
 * is treated as a confirmed cache hit for THIS account. We intentionally do NOT fall
 * back to "any prismarine-auth hash files exist" anymore, because those hash-prefixed
 * files (<hash>_live-cache.json etc.) cannot be mapped to a specific username. If a
 * different account authenticated previously, its hash files would still be present
 * and would cause invalid_grant errors when reused for a new account's device-code flow.
 *
 * Returns the marker object (truthy) if our own marker file exists and is valid,
 * or undefined if no confirmed cache exists for this account.
 */
function loadToken(username) {
  try {
    const p = tokenPath(username);
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      // Must be a real object marker written by saveToken()
      if (data && typeof data === "object" && data.username) {
        return data;
      }
    }
  } catch {
    // fall through — treat as no cache
  }
  return undefined;
}

/**
 * Write a marker file for this username so subsequent loadToken() calls
 * correctly detect that auth is cached for this specific account.
 *
 * NOTE: prismarine-auth manages its own cache files internally. We do NOT
 * try to copy or parse nmp-cache.json here — that file is not written by
 * prismarine-auth. The marker is purely for our own loadToken() check.
 */
function saveToken(username) {
  try {
    const marker = { cachedAt: new Date().toISOString(), username: username.toLowerCase() };
    fs.writeFileSync(tokenPath(username), JSON.stringify(marker, null, 2), "utf8");
    console.log(`[botmanager] 💾 Token marker saved for ${username}`);
  } catch (err) {
    console.warn(`[botmanager] ⚠️ Could not save token marker for ${username}:`, err.message);
  }
}

/**
 * Clear ALL Microsoft auth state for a user:
 *   1. Our custom ./tokens/<username>.json
 *   2. All prismarine-auth hash-prefixed cache files in TOKENS_DIR
 *      (e.g. ab58c3_live-cache.json, ab58c3_xbl-cache.json, ab58c3_mca-cache.json)
 *
 * prismarine-auth does NOT use nmp-cache.json — it uses files named
 * <hash>_<type>-cache.json where <hash> is derived from the username/clientId.
 * Since link verification bots run one at a time, it's safe to wipe all of them.
 */
function clearAuthCache(username) {
  // 1. Custom per-user marker file
  try {
    const p = tokenPath(username);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log(`[botmanager] 🧹 Deleted token marker for ${username}`);
    }
  } catch (err) {
    console.warn(`[botmanager] ⚠️ Could not delete token marker for ${username}:`, err.message);
  }

  // 2. All prismarine-auth hash-prefixed cache files
  //    Pattern: <hash>_live-cache.json, <hash>_xbl-cache.json, <hash>_mca-cache.json
  try {
    const files = fs.readdirSync(TOKENS_DIR);
    const cachePattern = /^[a-f0-9]+_(live|xbl|mca|msa|bedrock)-cache\.json$/i;
    let deleted = 0;
    for (const file of files) {
      if (cachePattern.test(file)) {
        try {
          fs.unlinkSync(path.join(TOKENS_DIR, file));
          deleted++;
          console.log(`[botmanager] 🧹 Deleted prismarine-auth cache: ${file}`);
        } catch (e) {
          console.warn(`[botmanager] ⚠️ Could not delete ${file}:`, e.message);
        }
      }
    }
    if (deleted === 0) {
      console.log(`[botmanager] 🧹 No prismarine-auth cache files found for ${username}`);
    }
  } catch (err) {
    console.warn(`[botmanager] ⚠️ Could not scan tokens dir for ${username}:`, err.message);
  }
}

// ============================================================
// IN-MEMORY BOT REGISTRY
// Map<discordId, { bot, minecraftUser, serverHost, serverPort, version, startedAt, status, ... }>
// ============================================================
const activeBots = new Map();

// ============================================================
// AUTH ERROR DEDUP GUARD
//
// Problem: prismarine-auth has an internal retry loop. When a device code
// expires or is rejected, it fires bot.on("error") many times in a row
// (once per retry) with the same invalid_grant message. Our authErrorHandled
// flag was stored on the activeBots entry — but cleanupBot() removes that
// entry, so every subsequent retry found entry=undefined, the guard was
// false, and it re-ran clearAuthCache + cleanupBot 15+ times.
//
// Fix: track handled discordIds in a module-level Set that survives cleanup.
// Entries auto-expire after AUTH_ERROR_DEDUP_TTL_MS so that a fresh /start
// can always proceed. We also explicitly clear the id at the top of startBot.
// ============================================================
const handledAuthErrors = new Set();
const AUTH_ERROR_DEDUP_TTL_MS = 10 * 60 * 1000; // 10 minutes

const AUTO_RECONNECT = process.env.AUTO_RECONNECT === "true";
const RECONNECT_DELAY_MS = parseInt(process.env.RECONNECT_DELAY_MS || "5000", 10);
const MAX_BOTS = parseInt(process.env.MAX_BOTS || "0", 10); // 0 = unlimited

// ============================================================
// VERSION CACHE (best-effort)
// Keeps track of which protocol version worked per host.
// ============================================================
const VERSION_CACHE_PATH = path.join(__dirname, "version-cache.json");
/** @type {Map<string, string>} */
const versionCache = new Map();

// Versions mineflayer currently supports (newest first).
// Used to filter out poisoned version-cache entries (e.g. 1.21.8).
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
      if (typeof host === "string" && typeof ver === "string") {
        // Skip any cached version that mineflayer doesn't support — it would cause createBot to throw.
        if (SUPPORTED_VERSIONS.has(ver)) {
          versionCache.set(host.toLowerCase(), ver);
        } else {
          console.warn(`[botmanager] ⚠️ Skipping unsupported cached version "${ver}" for ${host}`);
        }
      }
    }
  } catch {
    // ignore
  }
}

function saveVersionCache() {
  try {
    const obj = Object.fromEntries(versionCache.entries());
    fs.writeFileSync(VERSION_CACHE_PATH, JSON.stringify(obj, null, 2), "utf8");
  } catch {
    // ignore
  }
}

loadVersionCache();

function getAutoCandidatesForHost(hostLower) {
  if (hostLower === "donutsmp.net" || hostLower.endsWith(".donutsmp.net")) {
    // DonutSMP is on 1.21.8 (unsupported); try highest supported version first.
    return ["1.21.4", "1.20.4", "1.20.1", "1.19.4"];
  }
  if (hostLower === "hypixel.net" || hostLower.endsWith(".hypixel.net")) {
    return ["1.21.4", "1.20.4", "1.20.1", "1.8.9"];
  }
  // Generic fallback: prefer newer stable versions.
  return ["1.21.4", "1.20.4", "1.20.1"];
}

function shouldRotateVersionForReason(text) {
  const lower = String(text || "").toLowerCase();
  return (
    lower.includes("chunk size is") ||
    lower.includes("partial packet") ||
    lower.includes("invalid sequence")
  );
}

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

/**
 * Shared handler for Microsoft device-code events / callbacks.
 * Ensures each bot instance only emits ONE device code to the VPS / Discord layer.
 */
function handleDeviceCode(minecraftUser, onDeviceCode, deviceCodeResponse) {
  const userCode = deviceCodeResponse.user_code;
  const verificationUri = deviceCodeResponse.verification_uri || "https://www.microsoft.com/link";
  const expiresIn = deviceCodeResponse.expires_in || 900;
  // Enforce a shorter UX window so users don't get stuck with stale/used codes.
  const ENFORCED_DEVICE_CODE_TTL_SEC = 5 * 60;
  const effectiveExpiresIn = Math.min(expiresIn, ENFORCED_DEVICE_CODE_TTL_SEC);

  // Find the active entry for this minecraftUser to guard against double-emission.
  const entry = [...activeBots.values()].find(
    (e) => e.minecraftUser === minecraftUser && e.status === "connecting",
  );

  if (entry) {
    if (entry.deviceCodeEmitted) {
      console.log(`[botmanager] 🔐 Ignoring regenerated device code for ${minecraftUser} (one already emitted for this bot).`);
      return;
    }
    entry.deviceCodeEmitted = true;
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

/**
 * Start a mineflayer bot for a specific empire member.
 * Uses Microsoft auth (online mode) to join online-mode servers.
 *
 * @param {string}   discordId        - Discord user ID (used as unique key)
 * @param {string}   minecraftUser    - Minecraft username from members.json
 * @param {string}   serverAddress    - Target server (host[:port])
 * @param {string}   version          - Minecraft version (e.g. "1.20.1") or "auto"
 * @param {Function} [onDeviceCode]   - Optional callback(userCode, verificationUri, expiresIn)
 *                                      called when Microsoft device-code auth is needed.
 * @param {Function} [onLinkVerified] - Optional callback(discordId, verifiedMcUsername)
 *                                      called when bot logs in; used for /link verification.
 * @returns {{ success: boolean, reason?: string }}
 */
function startBot(discordId, minecraftUser, serverAddress, version, onDeviceCode = null, onLinkVerified = null) {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`[botmanager] 🤖 Starting bot`);
  console.log(`  Discord ID:   ${discordId}`);
  console.log(`  MC User:      ${minecraftUser}`);
  console.log(`  Server:       ${serverAddress}`);
  console.log(`  Version:      ${version}`);
  console.log(`  Auth mode:    microsoft`);

  // Clear any stale auth-error dedup guard from a previous failed attempt.
  handledAuthErrors.delete(discordId);

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
  const hostLower = String(host || "").toLowerCase();
  const requestedVersion = (version || "1.21.4").trim();
  const autoMode = requestedVersion.toLowerCase() === "auto";
  const autoCandidates = autoMode ? getAutoCandidatesForHost(hostLower) : [];
  const cached = autoMode ? versionCache.get(hostLower) : null;
  let effectiveVersion = autoMode ? (cached || autoCandidates[0] || "1.20.4") : requestedVersion;

  const linkOnly = typeof onLinkVerified === "function";

  // ── MICROSOFT AUTH CACHE CHECK ────────────────────────────
  // Only treat a confirmed per-user marker object as a valid cache hit.
  //
  // We deliberately do NOT fall back to "prismarine-auth hash files exist" here.
  // Those <hash>_*-cache.json files cannot be mapped to a specific username.
  // If Account A authenticated previously, its hash files remain on disk. When
  // Account B (an alt) tries to auth, prismarine-auth finds those stale files,
  // attempts to reuse the already-consumed device_code, and spins in an
  // invalid_grant retry loop — which also causes the spawn timeout to fire at
  // 45s instead of 5 minutes (because needsInteractiveAuth was wrongly false).
  //
  // Fix: loadToken() now only returns truthy for a real object marker written
  // by saveToken() for THIS account. If no marker exists we proactively wipe
  // all prismarine-auth hash files BEFORE creating the bot, so the auth flow
  // always starts clean.
  // ─────────────────────────────────────────────────────────
  const cachedToken = loadToken(minecraftUser);
  const needsInteractiveAuth = typeof cachedToken !== "object" || cachedToken === null;

  if (!needsInteractiveAuth) {
    console.log(`[botmanager] 🔑 Using cached Microsoft token for ${minecraftUser}`);
  } else {
    console.log(`[botmanager] 🔑 No valid token cache for ${minecraftUser} — device code auth will be required`);
    // Proactively wipe any stale prismarine-auth hash-cache files that may belong
    // to a different account. Leaving them causes invalid_grant on the new flow.
    clearAuthCache(minecraftUser);
    console.log(`[botmanager] 🧹 Pre-cleared stale auth cache before fresh auth for ${minecraftUser}`);
  }

  let bot;
  try {
    bot = mineflayer.createBot({
      host,
      port,
      username: minecraftUser,
      version: effectiveVersion,
      auth: "microsoft",
      // Provide token folder so device-code flow can save/reuse tokens
      profilesFolder: TOKENS_DIR,
      hideErrors: false,
      logErrors: true,
      // Hook into prismarine-auth device-code callback so the VPS API
      // can relay the link + code back to the Discord bot.
      onMsaCode: (deviceCodeResponse) => {
        handleDeviceCode(minecraftUser, onDeviceCode, deviceCodeResponse);
      },
    });
  } catch (err) {
    console.error(`[botmanager] ❌ Failed to create bot:`, err.message);

    // If the version is unsupported (e.g. server reports 1.21.8 but mineflayer tops at 1.21.4),
    // evict the bad version from our cache so the next auto-mode attempt uses the next candidate.
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

  // Store in registry immediately so concurrent start calls are blocked.
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
    linkVerifiedSent: false,
    deviceCodeEmitted: false,
    deviceCodeExpired: false,
    // Track pre-spawn socketClosed reconnect attempts to avoid infinite loop
    // when the server keeps rejecting the connection (e.g. version mismatch).
    socketClosedReconnects: 0,
    everSpawned: false,
  };
  activeBots.set(discordId, entry);

  // Spawn timeout — if bot doesn't fire "spawn" within the window, mark as failed.
  // For Microsoft device-code auth (or link-only verification), allow time for the user to sign in.
  const spawnTimeoutMs = (linkOnly || needsInteractiveAuth) ? 5 * 60 * 1000 : 45 * 1000;
  const spawnTimeoutId = setTimeout(() => {
    if (!activeBots.has(discordId)) return;
    const e = activeBots.get(discordId);
    if (e.status !== "connecting") return;

    const seconds = Math.floor(spawnTimeoutMs / 1000);
    console.warn(`[botmanager] ⏰ Spawn timeout for ${minecraftUser} after ${seconds}s — cleaning up`);

    // If we already showed a device code but never reached login, treat as auth timeout.
    if (e.deviceCodeEmitted && !e.linkVerifiedSent) {
      e.spawnError =
        "Authentication failed, timed out — the Microsoft device code was not redeemed in time. " +
        "Ask the user to run the command again to get a new code.";
    } else {
      e.spawnError =
        `Connection timed out — the server did not respond within ${seconds} seconds. ` +
        "Check the server address and version.";
    }

    e.status = "error";
    setTimeout(() => cleanupBot(discordId, "spawn_timeout"), 30000);
  }, spawnTimeoutMs);

  // Legacy event (some mineflayer versions fire this) — keep for logging
  bot.on("microsoft_device_code", (deviceCodeResponse) => {
    handleDeviceCode(minecraftUser, onDeviceCode, deviceCodeResponse);
  });

  // ============================================================
  // BOT EVENTS
  // ============================================================

  // For link verification we consider auth complete as soon as the client logs in.
  // Some servers (limbo/proxy) can authenticate but delay the "spawn" event.
  bot.once("login", () => {
    const e = activeBots.get(discordId);
    if (!e) return;
    if (!e.linkOnly || !e.onLinkVerified || e.linkVerifiedSent) return;
    e.linkVerifiedSent = true;
    e.status = "online";
    e.spawnError = null;
    clearTimeout(spawnTimeoutId);

    const verifiedName = bot.username || minecraftUser;
    try {
      e.onLinkVerified(discordId, verifiedName);
    } catch (err) {
      console.warn(`[botmanager] ⚠️ onLinkVerified threw:`, err.message);
    }
    setTimeout(() => cleanupBot(discordId, "link_verified_login"), 500);
  });

  bot.once("spawn", () => {
    clearTimeout(spawnTimeoutId);
    console.log(`[botmanager] ✅ Bot spawned: ${minecraftUser} on ${host}:${port}`);
    const currentEntry = activeBots.get(discordId);
    if (currentEntry) {
      currentEntry.status = "online";
      currentEntry.spawnError = null;
      currentEntry.everSpawned = true;
      currentEntry.socketClosedReconnects = 0; // reset counter after a successful spawn
    }

    // Cache the working version for this host (auto-mode only).
    if (autoMode) {
      versionCache.set(hostLower, effectiveVersion);
      saveVersionCache();
    }

    // Write our marker file so future loadToken() calls correctly detect
    // that prismarine-auth has cached credentials for this specific account.
    saveToken(minecraftUser);
  });

  bot.on("kicked", (reason) => {
    clearTimeout(spawnTimeoutId);
    let reasonText;

    if (typeof reason === "string") {
      try {
        const parsed = JSON.parse(reason);
        reasonText = parsed.text || parsed.translate || reason;
      } catch {
        reasonText = reason;
      }
    } else if (reason && typeof reason === "object") {
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

    // Auto version rotation for protocol/decoder desync
    if (autoMode && shouldRotateVersionForReason(reasonText)) {
      const e = activeBots.get(discordId);
      const nextIndex = (e?.autoCandidateIndex ?? -1) + 1;
      const nextVersion = e?.autoCandidates?.[nextIndex];
      if (nextVersion) {
        console.warn(
          `[botmanager] 🔁 Auto-version retry for ${minecraftUser}: ${effectiveVersion} → ${nextVersion} (reason: ${reasonText})`,
        );
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
    clearTimeout(spawnTimeoutId);

    // ── AUTH ERROR DEDUP GUARD ────────────────────────────────
    // prismarine-auth has an internal retry loop. When a device code
    // expires or is rejected, it fires bot.on("error") many times in a row
    // (once per retry) with the same invalid_grant message. Our authErrorHandled
    // flag was stored on the activeBots entry — but cleanupBot() removes that
    // entry, so every subsequent retry found entry=undefined, the guard was
    // false, and it re-ran clearAuthCache + cleanupBot 15+ times.
    //
    // This module-level Set survives cleanupBot(), so we catch all retries.
    if (handledAuthErrors.has(discordId)) {
      // Swallow silently — already handled this auth failure.
      return;
    }
    // ─────────────────────────────────────────────────────────

    console.error(`[botmanager] ❌ Bot error: ${minecraftUser} — ${err.message}`);
    const currentEntry = activeBots.get(discordId);
    if (currentEntry) {
      currentEntry.spawnError = err.message;
      currentEntry.status = "error";
    }

    // Auto version rotation for protocol/decoder desync
    if (autoMode && shouldRotateVersionForReason(err.message) && !(currentEntry && currentEntry.deviceCodeEmitted)) {
      const e = activeBots.get(discordId);
      const nextIndex = (e?.autoCandidateIndex ?? -1) + 1;
      const nextVersion = e?.autoCandidates?.[nextIndex];
      if (nextVersion) {
        console.warn(
          `[botmanager] 🔁 Auto-version retry for ${minecraftUser}: ${effectiveVersion} → ${nextVersion} (error: ${err.message})`,
        );
        setTimeout(() => {
          cleanupBot(discordId, "auto_version_retry_error");
          versionCache.set(hostLower, nextVersion);
          saveVersionCache();
          startBot(discordId, minecraftUser, `${host}:${port}`, "auto", onDeviceCode);
        }, 1500);
        return;
      }
    }

    // If it's ANY auth-related error (including invalid_grant), clear the FULL auth cache
    // so the next attempt does a fresh device-code flow instead of looping on a dead token.
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
      // Mark as handled in the module-level Set BEFORE cleanup so that any
      // synchronous or near-synchronous re-fires from prismarine-auth's retry
      // loop are immediately dropped. Auto-expire after TTL so re-starts work.
      handledAuthErrors.add(discordId);
      setTimeout(() => handledAuthErrors.delete(discordId), AUTH_ERROR_DEDUP_TTL_MS);

      console.warn(`[botmanager] 🔑 Auth error detected — clearing ALL cached auth for ${minecraftUser}`);
      clearAuthCache(minecraftUser);

      const e = activeBots.get(discordId);
      if (e) {
        e.deviceCodeExpired = true;
        e.spawnError =
          "Authentication failed — Microsoft sign-in did not complete or was rejected. " +
          "Ask the user to run the command again to get a new device code.";
      }

      // Stop immediately to avoid repeatedly reusing a redeemed/invalid device_code.
      cleanupBot(discordId, "auth_error");
      return;
    }

    setTimeout(() => cleanupBot(discordId, "error"), 30000);
  });

  bot.on("end", (reason) => {
    clearTimeout(spawnTimeoutId);
    console.log(`[botmanager] 🔌 Bot disconnected: ${minecraftUser} — reason: ${reason}`);

    if (AUTO_RECONNECT && activeBots.has(discordId)) {
      const e = activeBots.get(discordId);

      // If the bot never successfully spawned and keeps getting socketClosed,
      // it means the server is rejecting us (version mismatch, rate limit, etc.).
      // After 3 pre-spawn failures, give up and mark as error.
      const MAX_PRESPAWN_RECONNECTS = 3;
      if (!e.everSpawned && reason === "socketClosed") {
        e.socketClosedReconnects = (e.socketClosedReconnects || 0) + 1;
        if (e.socketClosedReconnects >= MAX_PRESPAWN_RECONNECTS) {
          console.warn(
            `[botmanager] ⛔ ${minecraftUser} hit ${MAX_PRESPAWN_RECONNECTS} socketClosed failures before spawning — giving up. ` +
            `Server may be running an unsupported version or is rejecting the client.`
          );
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
 * Get the count of active bots.
 * @returns {number}
 */
function getBotCount() {
  return activeBots.size;
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

module.exports = {
  startBot,
  stopBot,
  stopAllBots,
  getBotStatus,
  listAllBots,
  getBotCount,
}; 