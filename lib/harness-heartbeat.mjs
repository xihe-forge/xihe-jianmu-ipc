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

async function fetchJson(fetchImpl, url, timeoutMs) {
  const response = await runWithTimeout(
    (signal) => fetchImpl(url, { method: 'GET', signal }),
    timeoutMs,
  );

  if (response?.status !== 200) {
    throw new Error(`HTTP ${response?.status ?? 'unknown'}`);
  }

  return response.json();
}

function getLatestMessageTs(messages = []) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }

  const latest = messages[0];
  return Number.isFinite(latest?.ts) ? latest.ts : null;
}

function getSessionByName(sessions, sessionName) {
  if (!Array.isArray(sessions)) {
    return null;
  }
  return sessions.find((session) => session?.name === sessionName) ?? null;
}

export async function probeHarnessHeartbeat({
  hubUrl = DEFAULT_HUB_URL,
  sessionName = DEFAULT_SESSION_NAME,
  timeoutMs = 5000,
  maxSilentMs = 10 * 60 * 1000,
  wsDisconnectGraceMs = 3 * 60 * 1000,
  lastSeenOnlineAt = null,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  const startedAt = now();

  try {
    const [sessions, recentMessages] = await Promise.all([
      fetchJson(fetchImpl, `${hubUrl}/sessions`, timeoutMs),
      fetchJson(
        fetchImpl,
        `${hubUrl}/messages?peer=${encodeURIComponent(sessionName)}&limit=1`,
        timeoutMs,
      ),
    ]);

    const session = getSessionByName(sessions, sessionName);
    const latestMessageTs = getLatestMessageTs(recentMessages);
    const sessionConnectedAt = Number.isFinite(session?.connectedAt) ? session.connectedAt : null;
    const lastActivityTs = Math.max(
      latestMessageTs ?? Number.NEGATIVE_INFINITY,
      sessionConnectedAt ?? Number.NEGATIVE_INFINITY,
    );

    if (session) {
      const lastMsgAgeMs = Number.isFinite(lastActivityTs)
        ? Math.max(0, now() - lastActivityTs)
        : Number.MAX_SAFE_INTEGER;

      if (lastMsgAgeMs < maxSilentMs) {
        return {
          ok: true,
          connected: true,
          reason: 'online and active',
          lastMsgAgeMs,
          latencyMs: normalizeLatency(startedAt, now),
        };
      }

      return {
        ok: false,
        connected: true,
        error: 'silent',
        reason: 'online but silent',
        lastMsgAgeMs,
        requiresPing: true,
        latencyMs: normalizeLatency(startedAt, now),
      };
    }

    const baselineTs = Number.isFinite(lastSeenOnlineAt)
      ? lastSeenOnlineAt
      : latestMessageTs;
    if (!Number.isFinite(baselineTs)) {
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
      error: 'disconnected-grace-exceeded',
      reason: 'disconnected beyond grace',
      disconnectedForMs,
      requiresPing: true,
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
