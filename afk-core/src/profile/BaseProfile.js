"use strict";

/**
 * Base interface for per-server profiles.
 * Implementations can override options and attach custom behavior.
 */

class BaseProfile {
  constructor(id, supportedVersions) {
    this.id = id;
    this.supportedVersions = supportedVersions || [];
  }

  buildClientOptions(baseOptions /*, session */) {
    return baseOptions;
  }

  // eslint-disable-next-line no-unused-vars
  attachHandlers(_client, _session) {
    // no-op by default
  }

  // eslint-disable-next-line no-unused-vars
  tick(_session, _client, _nowMs) {
    // no-op by default
  }
}

module.exports = {
  BaseProfile,
};

