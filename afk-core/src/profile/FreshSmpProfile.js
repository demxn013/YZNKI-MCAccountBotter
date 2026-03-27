"use strict";

const { BaseProfile } = require("./BaseProfile");
const { HungerHandler } = require("../behavior/HungerHandler");

/**
 * FreshSmpProfile
 *
 * Stub profile for FreshSMP. Starts with vanilla-like behavior and can be
 * extended with FreshSMP-specific anti-bot handling as needed.
 * Includes automatic hunger management.
 */
class FreshSmpProfile extends BaseProfile {
  constructor() {
    super("freshsmp", ["1.21.11"]);
    this._hungerHandler = null;
  }

  buildClientOptions(baseOptions, session) {
    return {
      ...baseOptions,
      brand: "vanilla",
    };
  }

  attachHandlers(client, session) {
    // Initialise hunger handler using the negotiated version.
    const version = (session && session.version) ? String(session.version) : "1.21.4";
    this._hungerHandler = new HungerHandler(version);
    this._hungerHandler.attach(client);

    client.on("plugin_message", () => {
      // Future: inspect FreshSMP-specific plugin channels if necessary.
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
  FreshSmpProfile,
};