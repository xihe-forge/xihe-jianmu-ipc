export function createNetworkEventBroadcaster({ router, db, now = Date.now }) {
  async function broadcastNetworkDown({ failing = [], since, triggeredBy = 'watchdog' }) {
    const payload = {
      type: 'network-down',
      triggeredBy,
      failing: [...failing],
      since,
      ts: now(),
    };
    const subscribers = router.broadcastToTopic('network-down', payload);
    return {
      broadcastTo: subscribers.length,
      subscribers,
      payload,
    };
  }

  async function broadcastNetworkUp({ recoveredAfter = 0, triggeredBy = 'watchdog' } = {}) {
    const suspendedSessions = db.listSuspendedSessions().map((session) => session.name);
    const payload = {
      type: 'network-up',
      triggeredBy,
      recoveredAfter,
      suspendedSessions,
      ts: now(),
    };
    const subscribers = router.broadcastToTopic('network-up', payload);
    const clearedSessions = db.clearSuspendedSessions();
    return {
      broadcastTo: subscribers.length,
      subscribers,
      clearedSessions,
      payload,
    };
  }

  return {
    broadcastNetworkDown,
    broadcastNetworkUp,
  };
}
