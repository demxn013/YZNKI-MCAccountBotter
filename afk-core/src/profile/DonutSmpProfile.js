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
 *   minecraft-protocol already handles keep_alive echoing internally and
 *   does so correctly. Adding a second explicit echo here causes DonutSMP's
 *   Paper anti-cheat to see a DUPLICATE keep_alive response, which is what
 *   actually triggers the "Invalid sequence" kick. Do NOT re-echo keep_alive.
 *
 * NOTE on look packet yaw:
 *   minecraft-protocol's "look" packet expects yaw in DEGREES (0–360), not
 *   radians. Sending radian values (−π to π) produced malformed yaw angles
 *   which anti-cheat flagged as impossible movement.
 */
class DonutSmpProfile extends BaseProfile {
  constructor() {
    super("donutsmp", ["1.21.4"]);
    this._lastMoveAt = 0;
    this._versionCache = new Map(); // hostLower -> version
    this._hungerHandler = null;
  }

  _getCandidates() {
    return ["1.21.4"];
  }

  _resolveAutoVersion(hostLower) {
    return this._versionCache.get(hostLower) || this._getCandidates()[0];
  }

  buildClientOptions(baseOptions, session) {
    const requestedVersion = String(baseOptions.version || "auto").toLowerCase();
    const hostLower = String(baseOptions.host || "").toLowerCase();

    const effectiveVersion =
      requestedVersion === "auto" ? this._resolveAutoVersion(hostLower) : baseOptions.version;

    // Expose on session for status/debug and so attachHandlers can read it.
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
    // Initialise hunger handler using the negotiated version.
    const version = (session && session.version) ? String(session.version) : "1.21.4";
    this._hungerHandler = new HungerHandler(version);
    this._hungerHandler.attach(client);

    // ── keep_alive ──────────────────────────────────────────────────────────
    // minecraft-protocol handles keep_alive responses automatically and
    // correctly. We intentionally do NOT add another echo here — sending a
    // second response causes Paper's strict sequence checker to see an
    // unexpected duplicate and kick with "Invalid sequence".

    // Placeholder for handling DonutSMP-specific plugin channels.
    client.on("plugin_message", () => {
      // In a future iteration, inspect and respond to channels used by DonutSMP.
    });

    // If we successfully log in, cache the working version (best-effort, in-memory).
    client.on("login", () => {
      const hostLower = String(session?.serverHost || "").toLowerCase();
      if (hostLower) {
        this._versionCache.set(hostLower, String(session?.version || "1.21.4"));
      }
    });
  }

  tick(session, client, nowMs) {
    if (session.state !== "online") return;

    // Very lightweight random-look behavior every 10–20 seconds.
    // Yaw must be in DEGREES (0–360). minecraft-protocol's "look" packet
    // field is degrees, not radians. Sending radian values (~−3.14 to 3.14)
    // was producing near-zero or negative angles that anti-cheat flagged.
    if (!this._lastMoveAt || nowMs - this._lastMoveAt > 10000) {
      this._lastMoveAt = nowMs;
      try {
        // Random yaw: 0–360 degrees. Small pitch variation: ±10 degrees.
        const yaw   = Math.random() * 360;
        const pitch = (Math.random() * 20) - 10;
        client.write("look", {
          yaw,
          pitch,
          onGround: true,
        });
      } catch {
        // Ignore movement errors.
      }
    }

    // Periodic hunger check (reactive eating via update_health handles most cases;
    // this tick is a safety net for edge cases).
    if (this._hungerHandler) {
      this._hungerHandler.tick(client);
    }
  }
}

module.exports = {
  DonutSmpProfile,
};