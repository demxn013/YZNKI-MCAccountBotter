"use strict";

/**
 * Abstract auth provider interface.
 * Implementations translate an opaque authHandle into configuration
 * that minecraft-protocol can use to authenticate.
 */

class AuthProvider {
  /**
   * @param {any} authHandle
   * @returns {Promise<{ success: boolean, value?: any, error?: string }>}
   */
  // eslint-disable-next-line no-unused-vars
  async getAuthContext(authHandle) {
    throw new Error("Not implemented");
  }
}

module.exports = {
  AuthProvider,
};

