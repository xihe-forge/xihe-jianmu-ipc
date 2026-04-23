const RECLAIM_RATE_LIMIT_MS = 10_000;
const RECLAIM_PING_TIMEOUT_MS = 5_000;

function isWsOpen(ws) {
  return Boolean(ws) && (ws.readyState === ws.OPEN || ws.readyState === 1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function removePongListener(ws, listener) {
  if (!listener || !ws) return;
  if (typeof ws.off === 'function') {
    ws.off('pong', listener);
    return;
  }
  if (typeof ws.removeListener === 'function') {
    ws.removeListener('pong', listener);
  }
}

export function createSessionReclaimHandler({
  sessions,
  audit = () => {},
  findPendingRebind = () => null,
  now = Date.now,
}) {
  const reclaimLastAt = new Map();

  return async function handleSessionReclaim({ name, remoteAddress } = {}) {
    if (!name || typeof name !== 'string') {
      return { ok: false, reason: 'name required' };
    }

    const existing = sessions.get(name);
    if (!existing) {
      return { ok: false, reason: 'no-holder' };
    }

    if (findPendingRebind(name)) {
      return { ok: false, reason: 'pending-rebind-in-progress' };
    }

    const currentTime = now();
    const lastAt = reclaimLastAt.get(name);
    if (Number.isFinite(lastAt) && currentTime - lastAt < RECLAIM_RATE_LIMIT_MS) {
      return {
        ok: false,
        reason: 'rate-limited',
        retryAfterMs: RECLAIM_RATE_LIMIT_MS - (currentTime - lastAt),
      };
    }
    reclaimLastAt.set(name, currentTime);

    if (isWsOpen(existing.ws)) {
      let onPong = null;
      const pongPromise =
        typeof existing.ws?.once === 'function'
          ? new Promise((resolve) => {
              onPong = () => resolve(true);
              existing.ws.once('pong', onPong);
            })
          : Promise.resolve(false);

      try {
        existing.ws.ping();
      } catch {
        removePongListener(existing.ws, onPong);
      }

      const pongReceived = await Promise.race([
        pongPromise,
        sleep(RECLAIM_PING_TIMEOUT_MS).then(() => false),
      ]);
      if (pongReceived) {
        return { ok: false, reason: 'holder-alive', lastAliveAt: now() };
      }

      removePongListener(existing.ws, onPong);
    }

    const previousConnectedAt = Number.isFinite(existing.connectedAt) ? existing.connectedAt : null;
    audit('reclaim_evict', {
      name,
      previousConnectedAt,
      remoteAddress,
    });
    existing.ws?.terminate?.();

    return { ok: true, evicted: true, previousConnectedAt };
  };
}
