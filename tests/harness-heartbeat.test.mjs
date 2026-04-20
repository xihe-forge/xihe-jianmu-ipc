import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeHarnessHeartbeat } from '../lib/harness-heartbeat.mjs';

function createClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    set: (value) => {
      current = value;
    },
  };
}

function createFetchImpl(body) {
  const calls = [];

  return {
    calls,
    fetchImpl: async (url, init = {}) => {
      calls.push({
        url: String(url),
        headers: normalizeHeaders(init.headers),
      });
      return { status: 200, json: async () => body };
    },
  };
}

function normalizeHeaders(headers) {
  const normalized = {};
  if (!headers) {
    return normalized;
  }

  for (const [key, value] of Object.entries(headers)) {
    normalized[String(key).toLowerCase()] = String(value);
  }

  return normalized;
}

test('probeHarnessHeartbeat: /session-alive alive=true 时返回 ws open 并带 Bearer', async () => {
  const clock = createClock(10_000);
  const { fetchImpl, calls } = createFetchImpl({
    ok: true,
    name: 'harness',
    alive: true,
    connectedAt: 9_000,
    lastAliveProbe: 10_000,
  });

  const result = await probeHarnessHeartbeat({
    fetchImpl,
    now: clock.now,
    authToken: 'shared-secret',
  });

  assert.deepEqual(result, {
    ok: true,
    connected: true,
    reason: 'ws open',
    latencyMs: 0,
  });
  assert.deepEqual(calls, [{
    url: 'http://127.0.0.1:3179/session-alive?name=harness',
    headers: {
      authorization: 'Bearer shared-secret',
    },
  }]);
});

test('probeHarnessHeartbeat: /session-alive alive=false 且仍在 grace 内时保持 ok', async () => {
  const clock = createClock(200_000);
  const { fetchImpl } = createFetchImpl({
    ok: true,
    name: 'harness',
    alive: false,
    connectedAt: 20_000,
    lastAliveProbe: 200_000,
  });

  const result = await probeHarnessHeartbeat({
    fetchImpl,
    now: clock.now,
    lastSeenOnlineAt: 80_000,
    wsDisconnectGraceMs: 180_000,
  });

  assert.deepEqual(result, {
    ok: true,
    connected: false,
    reason: 'disconnected, within grace',
    disconnectedForMs: 120_000,
    latencyMs: 0,
  });
});

test('probeHarnessHeartbeat: /session-alive alive=false 且超过 grace 时返回 ws-disconnected-grace-exceeded', async () => {
  const clock = createClock(500_000);
  const { fetchImpl } = createFetchImpl({
    ok: true,
    name: 'harness',
    alive: false,
    connectedAt: 200_000,
    lastAliveProbe: 500_000,
  });

  const result = await probeHarnessHeartbeat({
    fetchImpl,
    now: clock.now,
    wsDisconnectGraceMs: 180_000,
  });

  assert.deepEqual(result, {
    ok: false,
    connected: false,
    error: 'ws-disconnected-grace-exceeded',
    reason: 'ws down beyond grace',
    disconnectedForMs: 300_000,
    latencyMs: 0,
  });
});

test('probeHarnessHeartbeat: /session-alive alive=false 且无 baseline 时返回 disconnected, no baseline', async () => {
  const clock = createClock(50_000);
  const { fetchImpl } = createFetchImpl({
    ok: true,
    name: 'harness',
    alive: false,
    connectedAt: 0,
    lastAliveProbe: 50_000,
  });

  const result = await probeHarnessHeartbeat({
    fetchImpl,
    now: clock.now,
  });

  assert.deepEqual(result, {
    ok: true,
    connected: false,
    reason: 'disconnected, no baseline',
    latencyMs: 0,
  });
});
