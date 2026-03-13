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
    super("donutsmp", ["1.21.11"]);
    this._lastMoveAt = 0;
  }

  buildClientOptions(baseOptions) {
    return {
      ...baseOptions,
      brand: "vanilla",
    };
  }

  attachHandlers(client, _session) {
    // Placeholder for handling DonutSMP-specific plugin channels.
    client.on("plugin_message", () => {
      // In a future iteration, inspect and respond to channels used by DonutSMP.
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

