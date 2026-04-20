const DEFAULT_HUB_URL = 'http://127.0.0.1:3179';
const DEFAULT_SESSION_NAME = 'harness';

function normalizeLatency(startedAt, now) {
  const elapsed = Number(now()) - Number(startedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) {
    return 0;
  }
  return elapsed;
}

function timeoutError(timeoutMs) {
  const error = new Error(`timeout after ${timeoutMs}ms`);
  error.code = 'ETIMEDOUT';
  return error;
}

function normalizeError(error) {
  if (!error) {
    return 'unknown error';
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error.name === 'AbortError') {
    return 'timeout';
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

async function runWithTimeout(runner, timeoutMs) {
  let timer = null;
  const controller = new AbortController();
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => runner(controller.signal)),
      timeoutPromise,
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function fetchJson(fetchImpl, url, timeoutMs, headers = null) {
  const requestInit = { method: 'GET' };
  if (headers && Object.keys(headers).length > 0) {
    requestInit.headers = headers;
  }
  const response = await runWithTimeout(
    (signal) => fetchImpl(url, { ...requestInit, signal }),
    timeoutMs,
  );

  if (response?.status !== 200) {
    throw new Error(`HTTP ${response?.status ?? 'unknown'}`);
  }

  return response.json();
}

export async function probeHarnessHeartbeat({
  hubUrl = DEFAULT_HUB_URL,
  sessionName = DEFAULT_SESSION_NAME,
  timeoutMs = 5000,
  wsDisconnectGraceMs = 60 * 1000,
  lastSeenOnlineAt = null,
  authToken = process.env.IPC_AUTH_TOKEN ?? null,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  const startedAt = now();

  try {
    const headers = typeof authToken === 'string' && authToken.trim() !== ''
      ? { Authorization: `Bearer ${authToken}` }
      : null;
    const body = await fetchJson(
      fetchImpl,
      `${hubUrl}/session-alive?name=${encodeURIComponent(sessionName)}`,
      timeoutMs,
      headers,
    );

    if (body?.alive === true) {
      return {
        ok: true,
        connected: true,
        reason: 'ws open',
        latencyMs: normalizeLatency(startedAt, now),
      };
    }

    const connectedAt = Number(body?.connectedAt);
    const baselineTs = Number.isFinite(lastSeenOnlineAt)
      ? lastSeenOnlineAt
      : (Number.isFinite(connectedAt) && connectedAt > 0 ? connectedAt : null);
    if (baselineTs == null) {
      return {
        ok: true,
        connected: false,
        reason: 'disconnected, no baseline',
        latencyMs: normalizeLatency(startedAt, now),
      };
    }

    const disconnectedForMs = Math.max(0, now() - baselineTs);
    if (disconnectedForMs < wsDisconnectGraceMs) {
      return {
        ok: true,
        connected: false,
        reason: 'disconnected, within grace',
        disconnectedForMs,
        latencyMs: normalizeLatency(startedAt, now),
      };
    }

    return {
      ok: false,
      connected: false,
      error: 'ws-disconnected-grace-exceeded',
      reason: 'ws down beyond grace',
      disconnectedForMs,
      latencyMs: normalizeLatency(startedAt, now),
    };
  } catch (error) {
    return {
      ok: false,
      error: normalizeError(error),
      latencyMs: normalizeLatency(startedAt, now),
    };
  }
}
