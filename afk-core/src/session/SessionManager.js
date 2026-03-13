"use strict";

const { Session } = require("./Session");
const {
  recordSessionStarted,
  recordSessionEnded,
} = require("../metrics/metrics");

/**
 * SessionManager
 *
 * Holds active AFK sessions and coordinates lifecycle.
 */
class SessionManager {
  /**
   * @param {{ authProvider: any, profiles: Record<string, any>, maxSessions?: number }} deps
   */
  constructor(deps) {
    this.authProvider = deps.authProvider;
    this.profiles = deps.profiles;
    this.maxSessions = typeof deps.maxSessions === "number" ? deps.maxSessions : 0; // 0 = unlimited
    this.sessions = new Map();

    // Basic tick loop for profile-specific behavior.
    const TICK_INTERVAL_MS = 1000;
    setInterval(() => this.tickAll(), TICK_INTERVAL_MS).unref();
  }

  /**
   * @param {{
   *  sessionId: string,
   *  minecraftUser: string,
   *  serverHost: string,
   *  serverPort: number,
   *  version: string,
   *  profile: any,
   *  authHandle: any
   * }} opts
   */
  async startSession(opts) {
    if (this.sessions.has(opts.sessionId)) {
      return { success: false, reason: "session_exists" };
    }

    if (this.maxSessions > 0 && this.sessions.size >= this.maxSessions) {
      return { success: false, reason: "capacity_reached", maxSessions: this.maxSessions };
    }

    const authContext = await this.authProvider.getAuthContext(opts.authHandle);
    if (!authContext.success) {
      return {
        success: false,
        reason: "auth_error",
        details: authContext.error,
      };
    }

    const session = new Session({
      id: opts.sessionId,
      minecraftUser: opts.minecraftUser,
      serverHost: opts.serverHost,
      serverPort: opts.serverPort,
      version: opts.version,
      profile: opts.profile,
      authContext: authContext.value,
      onEnd: () => {
        this.sessions.delete(opts.sessionId);
      },
    });

    this.sessions.set(opts.sessionId, session);
    recordSessionStarted();
    await session.connect();

    return {
      success: true,
      status: session.state,
    };
  }

  stopSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { success: false, reason: "not_found" };
    }

    session.stop();
    this.sessions.delete(sessionId);
    recordSessionEnded();
    return {
      success: true,
      previousStatus: session.state,
    };
  }

  getStatus(sessionId) {
    const session = this.sessions.get(sessionId);
    return session ? session.toStatusJson() : null;
  }

  list() {
    return [...this.sessions.values()].map((s) => s.toStatusJson());
  }

  tickAll() {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      session.tick(now);
    }
  }
}

module.exports = {
  SessionManager,
};

