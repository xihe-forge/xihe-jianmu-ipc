const STALE_MS_DEFAULT = 10 * 60 * 1000;
const COOLDOWN_MS_DEFAULT = 5 * 60 * 1000;
const WS_OPEN = 1;

function isThenable(value) {
  return value && typeof value.then === 'function';
}

export function createStaleSuspendDetector({
  db,
  getSessions,
  now = Date.now,
  staleMs = STALE_MS_DEFAULT,
  cooldownMs = COOLDOWN_MS_DEFAULT,
}) {
  const recentlyDetected = new Map();

  function processSessions(sessions, ts) {
    const cutoff = ts - staleMs;
    const suspendedSet = new Set((db.listSuspendedSessions?.() || []).map((s) => s.name));
    const detected = [];
    const skipped = [];

    for (const session of sessions.values?.() ?? []) {
      if (!session?.ws || session.ws.readyState !== WS_OPEN) {
        skipped.push({ name: session?.name, reason: 'ws-not-open' });
        continue;
      }

      const probe = Number.isFinite(session.lastAliveProbe) ? session.lastAliveProbe : ts;
      if (probe >= cutoff) {
        skipped.push({ name: session.name, reason: 'fresh' });
        continue;
      }

      if (suspendedSet.has(session.name)) {
        skipped.push({ name: session.name, reason: 'already-suspended' });
        continue;
      }

      const last = recentlyDetected.get(session.name) || 0;
      if (ts - last < cooldownMs) {
        skipped.push({ name: session.name, reason: 'cooldown' });
        continue;
      }

      db.suspendSession({
        name: session.name,
        reason: 'stuck-stale',
        task_description: 'lastAliveProbe stale > 10min · 推断 retry exhausted 或 stuck',
        suspended_by: 'watchdog',
      });
      recentlyDetected.set(session.name, ts);
      detected.push(session.name);
    }

    return { detected, skipped };
  }

  return {
    tick() {
      const ts = now();
      const sessions = getSessions();
      if (isThenable(sessions)) {
        return sessions.then((resolvedSessions) => processSessions(resolvedSessions, ts));
      }
      return processSessions(sessions, ts);
    },
  };
}
