export function createWakeCooldown({ db, cooldownMs = 5 * 60 * 1000, now = Date.now }) {
  return {
    canWake(sessionName) {
      const record = db.getWakeRecord?.(sessionName);
      if (!record) return true;
      return now() - record.last_wake_at >= cooldownMs;
    },

    recordWake(sessionName) {
      db.upsertWakeRecord?.({ name: sessionName, last_wake_at: now() });
    },

    cooldownRemainingMs(sessionName) {
      const record = db.getWakeRecord?.(sessionName);
      if (!record) return 0;
      return Math.max(0, cooldownMs - (now() - record.last_wake_at));
    },
  };
}
