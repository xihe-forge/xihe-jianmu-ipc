import { resolve as dnsResolve } from 'node:dns/promises';

const CLI_PROXY_URL = 'http://127.0.0.1:8317/v1/responses';
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

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

async function measureProbe({ timeoutMs, now = Date.now, runner, evaluate }) {
  const startedAt = now();

  try {
    const response = await runWithTimeout(runner, timeoutMs);
    const result = evaluate(response);
    return {
      ok: !!result.ok,
      latencyMs: normalizeLatency(startedAt, now),
      ...(result.error ? { error: result.error } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: normalizeLatency(startedAt, now),
      error: normalizeError(error),
    };
  }
}

export async function probeCliProxy({
  timeoutMs = 5000,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  return measureProbe({
    timeoutMs,
    now,
    runner: (signal) => fetchImpl(CLI_PROXY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
      signal,
    }),
    evaluate: (response) => {
      if (response.status >= 500) {
        return { ok: false, error: `HTTP ${response.status}` };
      }
      return { ok: true };
    },
  });
}

export async function probeHub({
  port = 3179,
  timeoutMs = 2000,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  return measureProbe({
    timeoutMs,
    now,
    runner: (signal) => fetchImpl(`http://127.0.0.1:${port}/health`, {
      method: 'GET',
      signal,
    }),
    evaluate: (response) => {
      if (response.status !== 200) {
        return { ok: false, error: `HTTP ${response.status}` };
      }
      return { ok: true };
    },
  });
}

export async function probeAnthropic({
  timeoutMs = 10000,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  return measureProbe({
    timeoutMs,
    now,
    runner: (signal) => fetchImpl(ANTHROPIC_MESSAGES_URL, {
      method: 'GET',
      signal,
    }),
    evaluate: (response) => {
      if (response.status >= 500) {
        return { ok: false, error: `HTTP ${response.status}` };
      }
      return { ok: true };
    },
  });
}

export async function probeDns({
  host = 'github.com',
  timeoutMs = 3000,
  resolveImpl = dnsResolve,
  now = Date.now,
} = {}) {
  return measureProbe({
    timeoutMs,
    now,
    runner: () => resolveImpl(host),
    evaluate: () => ({ ok: true }),
  });
}
