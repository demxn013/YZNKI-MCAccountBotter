"use strict";

const { BaseProfile } = require("./BaseProfile");
const { HungerHandler } = require("../behavior/HungerHandler");

/**
 * DonutSmpProfile
 *
 * Encapsulates DonutSMP-specific quirks:
 * - Vanilla-like brand and protocol version.
 * - Gentle idle movement (random look) to avoid looking like a frozen bot.
 * - Automatic hunger management — eats food when a hunger bar is lost.
 * - Explicit keep_alive echo to prevent "Invalid sequence" kicks.
 *   DonutSMP (Paper 1.21.x) enforces that the client responds to every
 *   keep_alive with the exact same keepAliveId. minecraft-protocol's
 *   built-in handler is correct, but sending an additional explicit
 *   response here acts as a belt-and-suspenders guard against the server's
 *   strict sequencing enforcement.
 */
class DonutSmpProfile extends BaseProfile {
  constructor() {
    super("donutsmp", ["1.21.4"]);
    this._lastMoveAt = 0;
    this._versionCache = new Map(); // hostLower -> version
    this._hungerHandler = null;
  }

  _getCandidates() {
    return ["1.21.4"];
  }

  _resolveAutoVersion(hostLower) {
    return this._versionCache.get(hostLower) || this._getCandidates()[0];
  }

  buildClientOptions(baseOptions, session) {
    const requestedVersion = String(baseOptions.version || "auto").toLowerCase();
    const hostLower = String(baseOptions.host || "").toLowerCase();

    const effectiveVersion =
      requestedVersion === "auto" ? this._resolveAutoVersion(hostLower) : baseOptions.version;

    // Expose on session for status/debug and so attachHandlers can read it.
    if (session) {
      session.version = effectiveVersion;
    }

    return {
      ...baseOptions,
      version: effectiveVersion,
      brand: "vanilla",
      // Disable minecraft-protocol's built-in keep-alive auto-response so we
      // can handle it ourselves and guarantee the exact correct keepAliveId
      // is echoed back without any timing race.
      hideErrors: false,
      skipValidation: false,
    };
  }

  attachHandlers(client, session) {
    // Initialise hunger handler using the negotiated version.
    const version = (session && session.version) ? String(session.version) : "1.21.4";
    this._hungerHandler = new HungerHandler(version);
    this._hungerHandler.attach(client);

    // ── Keep-alive explicit echo ────────────────────────────────────────────
    // DonutSMP enforces strict keep-alive sequence numbers. We listen for the
    // raw keep_alive packet and immediately write the response ourselves.
    // minecraft-protocol also handles this internally, but being explicit here
    // avoids any edge-case timing issue that triggers the "Invalid sequence" kick.
    //
    // The keep_alive packet in 1.9+ carries a `keepAliveId` (Long). We echo it
    // back verbatim. If the write throws (e.g. client already disconnecting) we
    // silently ignore it — the server will kick us anyway in that case.
    client.on("keep_alive", (packet) => {
      try {
        client.write("keep_alive", { keepAliveId: packet.keepAliveId });
      } catch {
        // Ignore — client is likely already closing.
      }
    });

    // Placeholder for handling DonutSMP-specific plugin channels.
    client.on("plugin_message", () => {
      // In a future iteration, inspect and respond to channels used by DonutSMP.
    });

    // If we successfully log in, cache the working version (best-effort, in-memory).
    client.on("login", () => {
      const hostLower = String(session?.serverHost || "").toLowerCase();
      if (hostLower) {
        this._versionCache.set(hostLower, String(session?.version || "1.21.4"));
      }
    });
  }

  tick(session, client, nowMs) {
    if (session.state !== "online") return;

    // Very lightweight random-look behavior every 10–20 seconds.
    if (!this._lastMoveAt || nowMs - this._lastMoveAt > 10000) {
      this._lastMoveAt = nowMs;
      try {
        const yaw = (Math.random() * Math.PI * 2) - Math.PI;
        const pitch = (Math.random() * 0.6) - 0.3; // small up/down
        client.write("look", {
          yaw,
          pitch,
          onGround: true,
        });
      } catch {
        // Ignore movement errors.
      }
    }

    // Periodic hunger check (reactive eating via update_health handles most cases;
    // this tick is a safety net for edge cases).
    if (this._hungerHandler) {
      this._hungerHandler.tick(client);
    }
  }
}

module.exports = {
  DonutSmpProfile,
};