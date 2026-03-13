"use strict";

/**
 * Basic classifier for kicks and errors so the Discord / API layer
 * can distinguish auth problems, protocol issues, and likely anti-bot.
 */

function normalize(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  try {
    if (value.text) return String(value.text);
    if (value.reason) return String(value.reason);
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function classifyKick(packet) {
  const raw = normalize(packet);
  const lower = raw.toLowerCase();

  // Auth-related messages
  if (
    lower.includes("not logged into your minecraft account") ||
    lower.includes("invalid session") ||
    lower.includes("session not valid") ||
    lower.includes("authentication servers are down") ||
    lower.includes("failed to verify username")
  ) {
    return {
      category: "auth_error",
      code: "invalid_session",
      message: raw,
      raw,
    };
  }

  // Likely anti-bot or server-side reject
  if (
    lower.includes("invalid sequence") ||
    lower.includes("bot") ||
    lower.includes("suspicious") ||
    lower.includes("blacklisted") ||
    lower.includes("banned") ||
    lower.includes("proxy") ||
    lower.includes("vpn")
  ) {
    return {
      category: "server_rejected",
      code: "anti_bot_rejection",
      message: raw,
      raw,
    };
  }

  // Fallback
  return {
    category: "server_rejected",
    code: "kicked",
    message: raw || "Disconnected by server",
    raw,
  };
}

function classifyError(err) {
  const raw = normalize(err);
  const lower = raw.toLowerCase();

  // Network errors
  if (
    lower.includes("econnrefused") ||
    lower.includes("timeout") ||
    lower.includes("etimedout") ||
    lower.includes("enoent") ||
    lower.includes("ehostunreach") ||
    lower.includes("dns")
  ) {
    return {
      category: "network_error",
      code: "network_failure",
      message: raw,
    };
  }

  // Auth/token errors
  if (
    lower.includes("microsoft") ||
    lower.includes("xbox") ||
    lower.includes("token") ||
    lower.includes("auth") ||
    lower.includes("unauthorized") ||
    lower.includes("login failed")
  ) {
    return {
      category: "auth_error",
      code: "auth_failure",
      message: raw,
    };
  }

  // Protocol mismatch
  if (
    lower.includes("unsupported protocol") ||
    lower.includes("wrong protocol") ||
    lower.includes("version mismatch") ||
    lower.includes("invalid sequence")
  ) {
    return {
      category: "protocol_mismatch",
      code: "protocol_error",
      message: raw,
    };
  }

  return {
    category: "unknown",
    code: "generic_error",
    message: raw || "Unknown error",
  };
}

module.exports = {
  classifyKick,
  classifyError,
};

