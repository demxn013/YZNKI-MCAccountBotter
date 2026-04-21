"use strict";

const { BaseProfile } = require("./BaseProfile");
const { HungerHandler } = require("../behavior/HungerHandler");

/**
 * DonutSmpProfile
 *
 * Encapsulates DonutSMP-specific quirks:
 * - Vanilla-like brand and protocol version.
 * - Gentle idle movement (random look) to avoid looking like a frozen bot.
 * - Automatic hunger management — eats food when a hunger bar is lost.
 *
 * NOTE on keep_alive:
 *   minecraft-protocol handles keep_alive echo internally and correctly.
 *   A manual re-echo here would produce a DUPLICATE response, which is
 *   exactly what triggers "Invalid sequence" on Paper servers. Removed.
 *
 * NOTE on look packet yaw:
 *   minecraft-protocol's "look" packet expects yaw in DEGREES (0–360).
 *   The previous code sent radians (−π to π ≈ −3.14 to 3.14) which
 *   caused near-zero malformed yaw angles that anti-cheat flagged.
 *   Fixed to use degrees.
 *
 * NOTE on tick() look packets:
 *   tick() now checks session.donutSmpReadyAt (set by botmanager's
 *   installDonutSmpQuietProxy) before sending any look packets. This
 *   prevents the profile from sending movement before the quiet window
 *   + physics resume delay has fully elapsed.
 */
class DonutSmpProfile extends BaseProfile {
  constructor() {
    super("donutsmp", ["1.21.11"]);
    this._lastMoveAt = 0;
    this._lastYaw = Math.random() * 360;
    this._versionCache = new Map();
    this._hungerHandler = null;
    this._debugLevel = String(process.env.DONUTSMP_DEBUG || "minimal").toLowerCase();
    this._lastDebugLookAt = 0;
  }

  _getCandidates() {
    return ["1.21.11"];
  }

  _resolveAutoVersion(hostLower) {
    return this._versionCache.get(hostLower) || this._getCandidates()[0];
  }

  buildClientOptions(baseOptions, session) {
    const requestedVersion = String(baseOptions.version || "auto").toLowerCase();
    const hostLower = String(baseOptions.host || "").toLowerCase();

    const effectiveVersion =
      requestedVersion === "auto" ? this._resolveAutoVersion(hostLower) : baseOptions.version;

    if (session) {
      session.version = effectiveVersion;
    }

    return {
      ...baseOptions,
      version: effectiveVersion,
      brand: "vanilla",
      hideErrors: false,
      skipValidation: false,
    };
  }

  attachHandlers(client, session) {
    const version = (session && session.version) ? String(session.version) : "1.21.11";
    this._hungerHandler = new HungerHandler(version);
    this._hungerHandler.attach(client);

    // ── keep_alive ──────────────────────────────────────────────────────────
    // minecraft-protocol already echoes keep_alive packets correctly.
    // We deliberately do NOT add another echo — a duplicate response causes
    // Paper's strict sequence checker to kick with "Invalid sequence".

    client.on("plugin_message", (packet) => {
      if (this._debugLevel !== "forensic") return;
      const channel = packet?.channel || "unknown";
      const dataLen = packet?.data?.length != null ? packet.data.length : 0;
      console.log(`[DonutSmpProfile] 🔬 plugin_message channel=${channel} bytes=${dataLen}`);
    });

    client.on("login", () => {
      const hostLower = String(session?.serverHost || "").toLowerCase();
      if (hostLower) {
        this._versionCache.set(hostLower, String(session?.version || "1.21.11"));
      }
    });
  }

  tick(session, client, nowMs) {
    if (session.state !== "online") return;

    // Do not send any look packets until the botmanager's quiet window
    // AND physics resume delay have fully elapsed. donutSmpReadyAt is set
    // by installDonutSmpQuietProxy; 0 means not yet initialized (stay quiet).
    const readyAt = session.donutSmpReadyAt || 0;
    if (readyAt === 0 || nowMs < readyAt) return;

    // Gentle random-look every 10–20 seconds to avoid appearing frozen.
    // Yaw MUST be in degrees (0–360). The previous code used radians
    // which produced values like −3.14 to 3.14 — near-zero in degrees —
    // which anti-cheat detected as impossible/stuck movement.
    const moveInterval = 10000 + Math.floor(Math.random() * 15000);
    if (!this._lastMoveAt || nowMs - this._lastMoveAt > moveInterval) {
      this._lastMoveAt = nowMs;
      try {
        const yawDelta = (Math.random() * 24) - 12;
        const yaw = (this._lastYaw + yawDelta + 360) % 360;
        this._lastYaw = yaw;
        const pitch = (Math.random() * 20) - 10;    // ±10 degrees
        client.write("look", {
          yaw,
          pitch,
          onGround: true,
        });
        if (this._debugLevel === "forensic" && (nowMs - this._lastDebugLookAt) > 5000) {
          this._lastDebugLookAt = nowMs;
          console.log(`[DonutSmpProfile] 🔬 look sent yaw=${yaw.toFixed(2)} pitch=${pitch.toFixed(2)} readyAt=${readyAt} now=${nowMs}`);
        }
      } catch {
        // Ignore movement errors.
      }
    }

    if (this._hungerHandler) {
      this._hungerHandler.tick(client);
    }
  }
}

module.exports = {
  DonutSmpProfile,
};