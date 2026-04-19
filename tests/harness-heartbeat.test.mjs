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

function createFetchImpl({ sessions = [], messages = [] }) {
  const calls = [];

  return {
    calls,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/sessions')) {
        return { status: 200, json: async () => sessions };
      }
      if (String(url).includes('/messages?peer=')) {
        return { status: 200, json: async () => messages };
      }
      throw new Error(`unexpected url: ${url}`);
    },
  };
}

test('probeHarnessHeartbeat: 在线且最近有活动时返回 ok', async () => {
  const clock = createClock(10_000);
  const { fetchImpl, calls } = createFetchImpl({
    sessions: [{ name: 'harness', connectedAt: 9_000 }],
    messages: [{ id: 'msg-1', ts: 9_500 }],
  });

  const result = await probeHarnessHeartbeat({
    fetchImpl,
    now: clock.now,
  });

  assert.deepEqual(result, {
    ok: true,
    connected: true,
    reason: 'online and active',
    lastMsgAgeMs: 500,
    latencyMs: 0,
  });
  assert.deepEqual(calls, [
    'http://127.0.0.1:3179/sessions',
    'http://127.0.0.1:3179/messages?peer=harness&limit=1',
  ]);
});

test('probeHarnessHeartbeat: 在线但静默超阈值时返回 requiresPing', async () => {
  const clock = createClock(700_000);
  const { fetchImpl } = createFetchImpl({
    sessions: [{ name: 'harness', connectedAt: 1_000 }],
    messages: [{ id: 'msg-1', ts: 50_000 }],
  });

  const result = await probeHarnessHeartbeat({
    fetchImpl,
    now: clock.now,
    maxSilentMs: 600_000,
  });

  assert.deepEqual(result, {
    ok: false,
    connected: true,
    error: 'silent',
    reason: 'online but silent',
    lastMsgAgeMs: 650_000,
    requiresPing: true,
    latencyMs: 0,
  });
});

test('probeHarnessHeartbeat: 离线但仍在 grace 窗口内时保持 ok', async () => {
  const clock = createClock(200_000);
  const { fetchImpl } = createFetchImpl({
    sessions: [],
    messages: [{ id: 'msg-1', ts: 20_000 }],
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

test('probeHarnessHeartbeat: 离线超出 grace 窗口时返回 requiresPing', async () => {
  const clock = createClock(500_000);
  const { fetchImpl } = createFetchImpl({
    sessions: [],
    messages: [{ id: 'msg-1', ts: 100_000 }],
  });

  const result = await probeHarnessHeartbeat({
    fetchImpl,
    now: clock.now,
    lastSeenOnlineAt: 200_000,
    wsDisconnectGraceMs: 180_000,
  });

  assert.deepEqual(result, {
    ok: false,
    connected: false,
    error: 'disconnected-grace-exceeded',
    reason: 'disconnected beyond grace',
    disconnectedForMs: 300_000,
    requiresPing: true,
    latencyMs: 0,
  });
});
