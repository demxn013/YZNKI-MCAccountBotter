"use strict";

const { BaseProfile } = require("./BaseProfile");

/**
 * DonutSmpProfile
 *
 * Encapsulates DonutSMP-specific quirks. Initial implementation focuses on:
 * - Vanilla-like brand and protocol version.
 * - Gentle idle movement to avoid looking like a frozen bot.
 * - Hook for future plugin-message handling.
 */
class DonutSmpProfile extends BaseProfile {
  constructor() {
    super("donutsmp", ["1.21.4"]);
    this._lastMoveAt = 0;
    this._versionCache = new Map(); // hostLower -> version
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

    // Expose on session for status/debug
    if (session) {
      session.version = effectiveVersion;
    }

    return {
      ...baseOptions,
      version: effectiveVersion,
      brand: "vanilla",
    };
  }

  attachHandlers(client, session) {
    // Placeholder for handling DonutSMP-specific plugin channels.
    client.on("plugin_message", () => {
      // In a future iteration, inspect and respond to channels used by DonutSMP.
    });

    // If we successfully log in, cache the working version (best-effort, in-memory).
    client.on("login", () => {
      const hostLower = String(session?.serverHost || "").toLowerCase();
      if (hostLower) {
        this._versionCache.set(hostLower, String(session?.version || "1.20.4"));
      }
    });
  }

  tick(session, client, nowMs) {
    if (session.state !== "online") return;

    // Very lightweight random-look behavior every 10–20 seconds.
    if (!this._lastMoveAt || nowMs - this._lastMoveAt > 10000) {
      this._lastMoveAt = nowMs;
      try {
        const yaw = (Math.random() * Math.PI * 2) - Math.PI;
        const pitch = (Math.random() * 0.6) - 0.3; // small up/down
        client.write("look", {
          yaw,
          pitch,
          onGround: true,
        });
      } catch {
        // Ignore movement errors.
      }
    }
  }
}

module.exports = {
  DonutSmpProfile,
};

