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
  now = Date.now,
} = {}) {
  let state = 'ok';
  let contextPct = null;
  let currentNextAction = null;
  let warnCountSinceLastCompact = 0;
  let lastTransition = now();
  let lastReason = 'init';
  let lastHeartbeatAt = null;
  let lastProbeAt = null;
  let lastProbeError = null;

  function transition(newState, reason) {
    const oldState = state;
    lastReason = reason;
    if (oldState === newState) {
      return;
    }

    state = newState;
    lastTransition = now();
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
    lastHeartbeatAt = now();
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
  }

  function getSnapshot() {
    return {
      state,
      contextPct,
      nextAction: currentNextAction,
      warnCount: warnCountSinceLastCompact,
      lastTransition,
      lastReason,
      lastHeartbeatAt,
      lastProbeAt,
      lastProbeError,
      thresholds: {
        warnThreshold,
        criticalThreshold,
        silentMsThreshold,
        wsGraceMs,
      },
    };
  }

  return {
    ingestHeartbeat,
    ingestProbeResult,
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
  };
}
