const DEFAULT_HISTORY_LIMIT = 10;

function normalizeError(error) {
  if (!error) {
    return 'unknown error';
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error.code && error.message) {
    return `${error.code}: ${error.message}`;
  }
  if (error.code) {
    return String(error.code);
  }
  if (error.message) {
    return error.message;
  }
  return String(error);
}

function cloneChecks(lastChecks) {
  return Object.fromEntries(
    Object.entries(lastChecks).map(([name, check]) => [name, { ...check }]),
  );
}

function cloneHistory(history) {
  return history.map((entry) => ({
    ts: entry.ts,
    state: entry.state,
    failing: [...entry.failing],
    consecutive: { ...entry.consecutive },
    lastChecks: cloneChecks(entry.lastChecks),
  }));
}

function initConsecutive(probes) {
  return Object.fromEntries(
    Object.keys(probes).map((name) => [name, 0]),
  );
}

function normalizeCheck(result, error) {
  if (error) {
    return {
      ok: false,
      latencyMs: 0,
      error: normalizeError(error),
    };
  }

  return {
    ok: !!result?.ok,
    latencyMs: Number.isFinite(result?.latencyMs) ? result.latencyMs : 0,
    ...(result?.error ? { error: String(result.error) } : {}),
  };
}

function buildSnapshot({ now, state, failing, consecutive, lastChecks }) {
  return {
    ts: now(),
    state,
    failing: [...failing],
    consecutive: { ...consecutive },
    lastChecks: cloneChecks(lastChecks),
  };
}

export function createStateMachine({
  probes = {},
  onTransition = () => {},
  consecutiveFailThreshold = 3,
  historyLimit = DEFAULT_HISTORY_LIMIT,
  now = Date.now,
} = {}) {
  let state = 'OK';
  let lastChecks = {};
  let history = [];
  let consecutive = initConsecutive(probes);
  let recoveryConsecutive = 0;

  function getFailing(checks = lastChecks) {
    return Object.entries(checks)
      .filter(([, check]) => !check.ok)
      .map(([name]) => name);
  }

  function buildState() {
    return {
      state,
      failing: getFailing(),
      consecutive: { ...consecutive },
      lastChecks: cloneChecks(lastChecks),
      history: cloneHistory(history),
    };
  }

  async function tick() {
    const entries = Object.entries(probes);
    const settled = await Promise.allSettled(
      entries.map(([, probe]) => probe()),
    );

    const checks = {};
    for (let index = 0; index < entries.length; index += 1) {
      const [name] = entries[index];
      const result = settled[index];
      if (result.status === 'fulfilled') {
        checks[name] = normalizeCheck(result.value);
      } else {
        checks[name] = normalizeCheck(null, result.reason);
      }
    }

    const failing = [];
    for (const name of Object.keys(probes)) {
      if (checks[name]?.ok) {
        consecutive[name] = 0;
      } else {
        consecutive[name] = (consecutive[name] ?? 0) + 1;
        failing.push(name);
      }
    }

    const allOk = failing.length === 0;
    let nextState = state;

    if (state === 'down') {
      if (allOk) {
        recoveryConsecutive += 1;
      } else {
        recoveryConsecutive = 0;
      }

      if (recoveryConsecutive >= consecutiveFailThreshold) {
        nextState = 'OK';
      } else {
        nextState = 'down';
      }
    } else if (allOk) {
      nextState = 'OK';
      recoveryConsecutive = 0;
    } else if (
      failing.length >= 2
      || failing.some((name) => consecutive[name] >= consecutiveFailThreshold)
    ) {
      nextState = 'down';
      recoveryConsecutive = 0;
    } else {
      nextState = 'degraded';
      recoveryConsecutive = 0;
    }

    lastChecks = checks;
    const snapshot = buildSnapshot({
      now,
      state: nextState,
      failing,
      consecutive,
      lastChecks,
    });
    history = [...history, snapshot].slice(-historyLimit);

    if (nextState !== state) {
      const from = state;
      state = nextState;
      onTransition({
        from,
        to: nextState,
        failing: [...failing],
        consecutive: { ...consecutive },
        lastChecks: cloneChecks(lastChecks),
        history: cloneHistory(history),
        ts: snapshot.ts,
      });
    } else {
      state = nextState;
    }

    if (state !== 'down') {
      recoveryConsecutive = 0;
    }

    return buildState();
  }

  function reset() {
    state = 'OK';
    lastChecks = {};
    history = [];
    consecutive = initConsecutive(probes);
    recoveryConsecutive = 0;
  }

  return {
    tick,
    getState: buildState,
    reset,
  };
}
