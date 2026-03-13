"use strict";

const { BaseProfile } = require("./BaseProfile");

/**
 * HypixelProfile
 *
 * Stub profile for Hypixel. Hypixel has strict rules and anti-bot systems;
 * this profile focuses on exposing a dedicated place for Hypixel-specific
 * behavior while keeping core behavior close to vanilla.
 */
class HypixelProfile extends BaseProfile {
  constructor() {
    super("hypixel", ["1.8.9", "1.21.11"]);
  }

  buildClientOptions(baseOptions) {
    return {
      ...baseOptions,
      brand: "vanilla",
    };
  }

  attachHandlers(client, _session) {
    client.on("plugin_message", () => {
      // Future: handle Hypixel channels if we choose to support them.
    });
  }
}

module.exports = {
  HypixelProfile,
};

