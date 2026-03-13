"use strict";

const { BaseProfile } = require("./BaseProfile");

/**
 * Default profile for vanilla / Paper servers.
 * Keeps behavior simple and close to a vanilla client.
 */
class DefaultProfile extends BaseProfile {
  constructor() {
    super("default", ["1.21.11"]);
  }

  buildClientOptions(baseOptions) {
    return {
      ...baseOptions,
      // Let the server think we're close to vanilla.
      brand: "vanilla",
    };
  }

  attachHandlers(client, _session) {
    // Here we could attach additional logging or lightweight behavior.
    client.on("keep_alive", () => {
      // minecraft-protocol handles responding automatically.
    });
  }
}

module.exports = {
  DefaultProfile,
};

