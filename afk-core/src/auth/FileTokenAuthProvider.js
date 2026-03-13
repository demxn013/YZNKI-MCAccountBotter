"use strict";

const path = require("path");
const fs = require("fs");
const { AuthProvider } = require("./AuthProvider");

/**
 * FileTokenAuthProvider
 *
 * Uses an existing Microsoft auth cache / token directory, shared with
 * the rest of the system. It assumes that prismarine-auth / minecraft-protocol
 * will read and refresh tokens using this cache when `auth: 'microsoft'`
 * and `profilesFolder` are provided.
 */
class FileTokenAuthProvider extends AuthProvider {
  /**
   * @param {{ tokensDir: string }} opts
   */
  constructor(opts) {
    super();
    this.tokensDir = opts.tokensDir;
  }

  /**
   * @param {{ type: string, value?: string } | string} authHandle
   * @returns {Promise<{ success: boolean, value?: any, error?: string }>}
   */
  async getAuthContext(authHandle) {
    const handle =
      typeof authHandle === "string"
        ? { type: "minecraftUser", value: authHandle }
        : authHandle || {};

    if (handle.type !== "minecraftUser" || !handle.value) {
      return {
        success: false,
        error: "unsupported_auth_handle",
      };
    }

    const username = String(handle.value);

    // Best-effort existence check to distinguish "missing token" vs other issues.
    let hasCache = false;
    try {
      const cachePath = path.join(this.tokensDir, "nmp-cache.json");
      if (fs.existsSync(cachePath)) {
        const raw = fs.readFileSync(cachePath, "utf8");
        const json = JSON.parse(raw);
        const key = Object.keys(json).find(
          (k) => k.toLowerCase() === username.toLowerCase(),
        );
        if (key) {
          hasCache = true;
        }
      }
    } catch {
      // Non-fatal; treat as cache-missing and let auth fail if needed.
    }

    if (!hasCache) {
      return {
        success: false,
        error: "missing_token_cache",
      };
    }

    return {
      success: true,
      value: {
        auth: "microsoft",
        profilesFolder: this.tokensDir,
      },
    };
  }
}

module.exports = {
  FileTokenAuthProvider,
};

