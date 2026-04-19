function normalizeReportedState({
  pct,
  reportedState,
  warnThreshold,
  criticalThreshold,
}) {
  if (reportedState === 'active' || reportedState === 'warn' || reportedState === 'critical') {
    return reportedState;
  }
  if (!Number.isFinite(pct)) {
    return null;
  }
  if (pct >= criticalThreshold) {
    return 'critical';
  }
  if (pct >= warnThreshold) {
    return 'warn';
  }
  return 'active';
}

export function createHarnessStateMachine({
  onTransition = null,
  warnThreshold = 55,
  criticalThreshold = 65,
  silentMsThreshold = 10 * 60 * 1000,
  wsGraceMs = 3 * 60 * 1000,
  warnWithoutCompactCount = 3,
  coldStartGraceMs = 2 * 60 * 1000,
  now = Date.now,
} = {}) {
  const startedAt = now();
  let state = 'ok';
  let contextPct = null;
  let currentNextAction = null;
  let warnCountSinceLastCompact = 0;
  let lastTransition = 0;
  let lastReason = 'init';
  let lastHeartbeatAt = null;
  let lastProbeAt = null;
  let lastProbeError = null;
  let aliveSignalReceived = false;
  let lastAliveSignalAt = null;
  let lastAliveSignalSource = null;

  function markAliveSignal(source = 'unknown', timestamp = now()) {
    aliveSignalReceived = true;
    lastAliveSignalAt = timestamp;
    lastAliveSignalSource = typeof source === 'string' && source.trim() !== ''
      ? source
      : 'unknown';
  }

  function transition(newState, reason) {
    const transitionTs = now();
    const oldState = state;
    if (
      newState === 'down'
      && !aliveSignalReceived
      && (transitionTs - startedAt) < coldStartGraceMs
    ) {
      const heldReason = `held-by-grace: ${reason} (no alive signal in cold-start ${Math.floor((transitionTs - startedAt) / 1000)}s)`;
      lastReason = heldReason;
      if (oldState === 'degraded') {
        return;
      }

      state = 'degraded';
      lastTransition = transitionTs;
      if (typeof onTransition === 'function') {
        onTransition({
          from: oldState,
          to: 'degraded',
          reason: heldReason,
          contextPct,
          warnCount: warnCountSinceLastCompact,
          nextAction: currentNextAction,
          ts: lastTransition,
        });
      }
      return;
    }

    lastReason = reason;
    if (oldState === newState) {
      return;
    }

    state = newState;
    lastTransition = transitionTs;
    if (typeof onTransition === 'function') {
      onTransition({
        from: oldState,
        to: newState,
        reason,
        contextPct,
        warnCount: warnCountSinceLastCompact,
        nextAction: currentNextAction,
        ts: lastTransition,
      });
    }
  }

  function ingestHeartbeat({ pct = null, state: reportedState = null, nextAction = null } = {}) {
    const heartbeatTs = now();
    lastHeartbeatAt = heartbeatTs;
    markAliveSignal('heartbeat', heartbeatTs);
    if (Number.isFinite(pct)) {
      contextPct = pct;
    }
    currentNextAction = typeof nextAction === 'string' ? nextAction : null;

    const normalizedState = normalizeReportedState({
      pct,
      reportedState,
      warnThreshold,
      criticalThreshold,
    });

    if (normalizedState === 'critical' && currentNextAction === 'self-handover') {
      transition('down', 'hard-signal');
      return;
    }

    if (normalizedState === 'warn' && currentNextAction === 'compact') {
      warnCountSinceLastCompact = 0;
    } else if (normalizedState === 'warn') {
      warnCountSinceLastCompact += 1;
      if (warnCountSinceLastCompact >= warnWithoutCompactCount) {
        transition('down', 'warn-without-compact');
        return;
      }
    } else if (normalizedState === 'active') {
      warnCountSinceLastCompact = 0;
      if (state !== 'ok') {
        transition('ok', 'recovered');
      }
      return;
    }

    if (normalizedState === 'warn' && state !== 'down') {
      transition('warn', 'context-warn');
      return;
    }

    if (normalizedState === 'critical' && currentNextAction !== 'self-handover' && state !== 'down') {
      transition('degraded', 'context-critical-no-action');
    }
  }

  function ingestProbeResult(probeResult = {}) {
    lastProbeAt = now();
    lastProbeError = probeResult?.error ?? null;
    if (probeResult?.error !== 'silent-confirmed') {
      return;
    }

    const reason = String(probeResult?.reason ?? '').includes('disconnected')
      ? 'soft-A-ws-disconnect'
      : 'soft-B-silent';
    transition('down', reason);
  }

  function reset() {
    state = 'ok';
    contextPct = null;
    currentNextAction = null;
    warnCountSinceLastCompact = 0;
    lastTransition = now();
    lastReason = 'reset';
    lastHeartbeatAt = null;
    lastProbeAt = null;
    lastProbeError = null;
    aliveSignalReceived = false;
    lastAliveSignalAt = null;
    lastAliveSignalSource = null;
  }

  function getSnapshot() {
    return {
      startedAt,
      state,
      contextPct,
      nextAction: currentNextAction,
      warnCount: warnCountSinceLastCompact,
      lastTransition,
      lastReason,
      lastHeartbeatAt,
      lastProbeAt,
      lastProbeError,
      aliveSignalReceived,
      lastAliveSignalAt,
      lastAliveSignalSource,
      thresholds: {
        warnThreshold,
        criticalThreshold,
        silentMsThreshold,
        wsGraceMs,
        coldStartGraceMs,
      },
    };
  }

  return {
    ingestHeartbeat,
    ingestProbeResult,
    markAliveSignal,
    reset,
    getSnapshot,
    get state() {
      return state;
    },
    get contextPct() {
      return contextPct;
    },
    get warnCount() {
      return warnCountSinceLastCompact;
    },
    get nextAction() {
      return currentNextAction;
    },
    get lastTransition() {
      return lastTransition;
    },
    get lastReason() {
      return lastReason;
    },
    get lastHeartbeatAt() {
      return lastHeartbeatAt;
    },
    get lastProbeAt() {
      return lastProbeAt;
    },
    get lastProbeError() {
      return lastProbeError;
    },
    get aliveSignalReceived() {
      return aliveSignalReceived;
    },
    get lastAliveSignalAt() {
      return lastAliveSignalAt;
    },
    get lastAliveSignalSource() {
      return lastAliveSignalSource;
    },
  };
}
