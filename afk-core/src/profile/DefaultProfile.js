"use strict";

const { BaseProfile } = require("./BaseProfile");
const { HungerHandler } = require("../behavior/HungerHandler");

/**
 * Default profile for vanilla / Paper servers.
 * Keeps behavior simple and close to a vanilla client.
 * Includes automatic hunger management (eats food when hungry).
 */
class DefaultProfile extends BaseProfile {
  constructor() {
    super("default", ["1.21.4"]);
    this._hungerHandler = null;
  }

  buildClientOptions(baseOptions /*, session */) {
    return {
      ...baseOptions,
      // Let the server think we're close to vanilla.
      brand: "vanilla",
    };
  }

  attachHandlers(client, session) {
    // Resolve the negotiated version from the session (set during connect).
    const version = (session && session.version) ? String(session.version) : "1.21.4";
    this._hungerHandler = new HungerHandler(version);
    this._hungerHandler.attach(client);

    client.on("keep_alive", () => {
      // minecraft-protocol handles responding automatically.
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
  DefaultProfile,
};