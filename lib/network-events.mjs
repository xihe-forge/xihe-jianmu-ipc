const STALE_MS = 5 * 60 * 1000;
const WS_OPEN = 1;

export function createNetworkEventBroadcaster({ router, db, now = Date.now, getSessions = null }) {
  async function broadcastNetworkDown({ failing = [], since, triggeredBy = 'watchdog', ts = now() }) {
    const payload = {
      type: 'network-down',
      triggeredBy,
      failing: [...failing],
      since,
      ts,
    };
    const subscribers = router.broadcastToTopic('network-down', payload);
    return {
      broadcastTo: subscribers.length,
      subscribers,
      payload,
    };
  }

  async function broadcastNetworkUp({ recoveredAfter = 0, triggeredBy = 'watchdog', reason = null, ts = now() } = {}) {
    const suspendedRecords = db.listSuspendedSessions()
      .filter((session) => reason === null || reason === undefined || session.reason === reason);
    const suspendedSessions = suspendedRecords.map((session) => session.name);
    const payload = {
      type: 'network-up',
      triggeredBy,
      recoveredAfter,
      suspendedSessions,
      ts,
    };
    if (reason !== null && reason !== undefined) {
      payload.reason = reason;
    }
    const subscribers = router.broadcastToTopic('network-up', payload);
    const clearedSessions = db.clearSuspendedSessions(reason);
    const autoWokenSessions = [];

    if (typeof getSessions === 'function') {
      const sessions = getSessions();
      const cutoff = ts - STALE_MS;
      for (const session of sessions.values()) {
        if (!session?.ws || session.ws.readyState !== WS_OPEN) continue;
        if (!Number.isFinite(session.lastAliveProbe)) continue;
        const probe = session.lastAliveProbe;
        if (probe < cutoff) {
          router.routeMessage({
            from: 'jianmu-pm',
            to: session.name,
            content: '【auto-wake from jianmu-pm】 session 检测到 5min+ idle (lastAliveProbe stale) + anthropic API 已恢复 · 自动续上挂起任务（如有）· 不消耗 token',
          });
          autoWokenSessions.push(session.name);
        }
      }
    }

    return {
      broadcastTo: subscribers.length,
      subscribers,
      clearedSessions,
      autoWokenSessions,
      payload,
    };
  }

  return {
    broadcastNetworkDown,
    broadcastNetworkUp,
  };
}
