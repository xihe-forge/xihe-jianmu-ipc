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
    // ADR-006 v0.3 step 9：reason 仅当在 categorical set 内才作过滤·legacy 任意 reason 字符串保持仅为元数据兼容（CLAUDE.md POST /wake-suspended 注规约）
    const CATEGORICAL_REASONS = new Set(['stuck-network', 'stuck-rate-limited']);
    const filterReason = (reason !== null && reason !== undefined && CATEGORICAL_REASONS.has(reason))
      ? reason
      : null;
    const suspendedRecords = db.listSuspendedSessions()
      .filter((session) => filterReason === null || session.reason === filterReason);
    const suspendedSessions = suspendedRecords.map((session) => session.name);
    const payload = {
      type: 'network-up',
      triggeredBy,
      recoveredAfter,
      suspendedSessions,
      ts,
    };
    if (filterReason !== null) {
      payload.reason = filterReason;
    }
    const subscribers = router.broadcastToTopic('network-up', payload);
    const clearedSessions = db.clearSuspendedSessions(filterReason);
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
