"use strict";

const { BaseProfile } = require("./BaseProfile");
const { HungerHandler } = require("../behavior/HungerHandler");

/**
 * HypixelProfile
 *
 * Stub profile for Hypixel. Hypixel has strict rules and anti-bot systems;
 * this profile focuses on exposing a dedicated place for Hypixel-specific
 * behavior while keeping core behavior close to vanilla.
 *
 * Hunger management is included. Note: many Hypixel minigames disable hunger,
 * so the handler will simply never find food < 18 and remain idle in those modes.
 * For games where hunger is active (e.g. Survival Games), the bot will eat normally.
 *
 * 1.8.9 eating is intentionally skipped inside HungerHandler (different protocol).
 */
class HypixelProfile extends BaseProfile {
  constructor() {
    super("hypixel", ["1.8.9", "1.21.11"]);
    this._hungerHandler = null;
  }

  buildClientOptions(baseOptions /*, session */) {
    return {
      ...baseOptions,
      brand: "vanilla",
    };
  }

  attachHandlers(client, session) {
    // Initialise hunger handler using the negotiated version.
    // HungerHandler internally skips eating on 1.8.x (different packet format).
    const version = (session && session.version) ? String(session.version) : "1.8.9";
    this._hungerHandler = new HungerHandler(version);
    this._hungerHandler.attach(client);

    client.on("plugin_message", () => {
      // Future: handle Hypixel channels if we choose to support them.
    });
  }

  tick(session, client, nowMs) {
    if (session.state !== "online") return;
    if (this._hungerHandler) {
      this._hungerHandler.tick(client);
    }
  }
}

module.exports = {
  HypixelProfile,
};