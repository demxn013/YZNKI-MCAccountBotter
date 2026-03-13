"use strict";

const { BaseProfile } = require("./BaseProfile");

/**
 * FreshSmpProfile
 *
 * Stub profile for FreshSMP. Starts with vanilla-like behavior and can be
 * extended with FreshSMP-specific anti-bot handling as needed.
 */
class FreshSmpProfile extends BaseProfile {
  constructor() {
    super("freshsmp", ["1.20.1"]);
  }

  buildClientOptions(baseOptions) {
    return {
      ...baseOptions,
      brand: "vanilla",
    };
  }

  attachHandlers(client, _session) {
    client.on("plugin_message", () => {
      // Future: inspect FreshSMP-specific plugin channels if necessary.
    });
  }
}

module.exports = {
  FreshSmpProfile,
};

