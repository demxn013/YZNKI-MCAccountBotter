"use strict";

const { createClient } = require("minecraft-protocol");
const { classifyKick, classifyError } = require("./AntiBotClassifier");
const { recordKick } = require("../metrics/metrics");

/**
 * @typedef {'connecting' | 'online' | 'error' | 'ended'} SessionState
 */

class Session {
  /**
   * @param {{
   *  id: string,
   *  minecraftUser: string,
   *  serverHost: string,
   *  serverPort: number,
   *  version: string,
   *  profile: any,
   *  authContext: any,
   *  onEnd: () => void
   * }} opts
   */
  constructor(opts) {
    this.id = opts.id;
    this.minecraftUser = opts.minecraftUser;
    this.serverHost = opts.serverHost;
    this.serverPort = opts.serverPort;
    this.version = opts.version;
    this.profile = opts.profile;
    this.authContext = opts.authContext;
    this.onEnd = opts.onEnd;

    this.state = "connecting";
    this.lastError = null;
    this.lastKickReason = null;
    this.errorCategory = null;
    this.errorCode = null;
    this.createdAt = new Date();
    this.connectedSince = null;
    this.lastKeepAliveAt = null;
    this.lastRttMs = null;

    this.client = null;
  }

  async connect() {
    const baseOptions = {
      host: this.serverHost,
      port: this.serverPort,
      username: this.minecraftUser,
      version: this.version,
      ...this.authContext,
    };

    const clientOptions = this.profile.buildClientOptions
      ? this.profile.buildClientOptions(baseOptions, this)
      : baseOptions;

    const client = createClient(clientOptions);
    this.client = client;

    client.on("connect", () => {
      this.state = "connecting";
    });

    client.on("login", () => {
      this.state = "online";
      this.connectedSince = new Date();
    });

    client.on("keep_alive", () => {
      this.lastKeepAliveAt = new Date();
    });

    client.on("kick_disconnect", (packet) => {
      const classification = classifyKick(packet);
      this.state = "error";
      this.lastKickReason = classification.message;
      this.errorCategory = classification.category;
      this.errorCode = classification.code;
      this.lastError = classification.raw || null;
      recordKick(classification.category);
      this._end();
    });

    client.on("end", (reason) => {
      if (this.state !== "error") {
        const classification = classifyError(reason);
        this.state = "ended";
        this.lastError = classification.message;
        this.errorCategory = classification.category;
        this.errorCode = classification.code;
      }
      this._end();
    });

    client.on("error", (err) => {
      const classification = classifyError(err);
      this.state = "error";
      this.lastError = classification.message;
      this.errorCategory = classification.category;
      this.errorCode = classification.code;
    });

    if (this.profile && typeof this.profile.attachHandlers === "function") {
      this.profile.attachHandlers(client, this);
    }
  }

  stop() {
    if (this.client) {
      try {
        this.client.end("manual_disconnect");
      } catch {
        // ignore
      }
    }
    this.state = "ended";
  }

  tick(nowMs) {
    if (this.profile && typeof this.profile.tick === "function" && this.client) {
      this.profile.tick(this, this.client, nowMs);
    }
  }

  toStatusJson() {
    return {
      success: true,
      sessionId: this.id,
      online: this.state === "online",
      state: this.state,
      createdAt: this.createdAt.toISOString(),
      connectedSince: this.connectedSince ? this.connectedSince.toISOString() : null,
      lastError: this.lastError,
      lastKickReason: this.lastKickReason,
      errorCategory: this.errorCategory,
      errorCode: this.errorCode,
      serverInfo: {
        host: this.serverHost,
        port: this.serverPort,
        version: this.version,
        profile: this.profile.id,
      },
      health: {
        lastKeepAliveAt: this.lastKeepAliveAt
          ? this.lastKeepAliveAt.toISOString()
          : null,
        rttMs: this.lastRttMs,
      },
    };
  }

  _end() {
    if (this.client) {
      try {
        this.client.end();
      } catch {
        // ignore
      }
    }
    if (typeof this.onEnd === "function") {
      this.onEnd();
    }
  }
}

module.exports = {
  Session,
};

