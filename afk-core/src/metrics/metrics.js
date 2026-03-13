"use strict";

/**
 * Minimal in-memory metrics to give visibility into AFK core behavior.
 * This can later be replaced with Prometheus or another backend.
 */

const counters = {
  sessionsStartedTotal: 0,
  sessionsEndedTotal: 0,
  kicksByCategory: {},
};

function recordSessionStarted() {
  counters.sessionsStartedTotal += 1;
}

function recordSessionEnded() {
  counters.sessionsEndedTotal += 1;
}

function recordKick(category) {
  const key = category || "unknown";
  counters.kicksByCategory[key] = (counters.kicksByCategory[key] || 0) + 1;
}

function buildMetricsSnapshot() {
  return {
    sessionsStartedTotal: counters.sessionsStartedTotal,
    sessionsEndedTotal: counters.sessionsEndedTotal,
    kicksByCategory: counters.kicksByCategory,
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  recordSessionStarted,
  recordSessionEnded,
  recordKick,
  buildMetricsSnapshot,
};

