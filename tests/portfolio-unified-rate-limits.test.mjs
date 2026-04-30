import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHttpHandler } from '../lib/http-handlers.mjs';

function createCtx({ now = Date.now } = {}) {
  const openWs = { readyState: 1, OPEN: 1 };
  const sessions = new Map([
    ['session-a', { name: 'session-a', ws: openWs, connectedAt: 1000, topics: new Set(), contextUsagePct: null }],
    ['session-b', { name: 'session-b', ws: openWs, connectedAt: 2000, topics: new Set(), contextUsagePct: null }],
  ]);

  return {
    sessions,
    routeMessage: () => {},
    broadcastToTopic: () => {},
    broadcastNetworkDown: () => {},
    broadcastNetworkUp: () => {},
    checkAuth: () => true,
    authTokens: null,
    AUTH_TOKEN: null,
    INTERNAL_TOKEN: 'test-token',
    createMessage: (message) => ({ id: 'msg-1', type: 'message', ...message }),
    createTask: (task) => ({ id: 'task-1', ...task }),
    TASK_STATUSES: ['pending', 'done'],
    saveTask: () => {},
    getTask: () => null,
    updateTaskStatus: () => {},
    listTasks: () => [],
    getTaskStats: () => ({}),
    getMessages: () => [],
    getRecipientRecent: () => [],
    getMessageCount: () => 0,
    getMessageCountByAgent: () => ({}),
    suspendSession: () => {},
    ERR_REBIND_PENDING: 'ERR_REBIND_PENDING',
    createPendingRebind: () => {},
    registerSessionRecord: () => {},
    updateSessionRecordProjects: () => {},
    sessionReclaim: { handle: () => ({ ok: true }) },
    feishuApps: [],
    getFeishuToken: () => null,
    stderr: () => {},
    audit: () => {},
    hubDir: process.cwd(),
    listSuspendedSessions: () => [],
    clearSuspendedSessions: () => 0,
    clearInbox: () => 0,
    now,
  };
}

async function withServer(ctx, fn) {
  const server = http.createServer(createHttpHandler(ctx));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function pushContext(baseUrl, name, rateLimits) {
  const response = await fetch(`${baseUrl}/session/context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, rate_limits: rateLimits }),
  });
  assert.equal(response.status, 204);
}

test('hub portfolio rateLimits chooses newer five_hour reset_at', async () => {
  const older = {
    five_hour: { used_percentage: 78, resets_at: 1777300000 },
    seven_day: { used_percentage: 60, resets_at: 1777900000 },
  };
  const newer = {
    five_hour: { used_percentage: 14, resets_at: 1777320000 },
    seven_day: { used_percentage: 61, resets_at: 1777900000 },
  };
  const ctx = createCtx();

  await withServer(ctx, async (baseUrl) => {
    await pushContext(baseUrl, 'session-a', older);
    await pushContext(baseUrl, 'session-b', newer);

    assert.deepEqual(ctx.sessions.get('session-a').rateLimits, older);
    const sessions = await fetch(`${baseUrl}/sessions`).then((res) => res.json());
    assert.deepEqual(sessions.map((session) => session.rateLimits), [newer, newer]);
  });
});

test('hub portfolio rateLimits chooses latest push when reset_at ties', async () => {
  let currentNow = 1_000;
  const first = {
    five_hour: { used_percentage: 40, resets_at: 1777320000 },
    seven_day: { used_percentage: 50, resets_at: 1777900000 },
  };
  const second = {
    five_hour: { used_percentage: 41, resets_at: 1777320000 },
    seven_day: { used_percentage: 51, resets_at: 1777900000 },
  };
  const ctx = createCtx({ now: () => currentNow });

  await withServer(ctx, async (baseUrl) => {
    await pushContext(baseUrl, 'session-a', first);
    currentNow = 2_000;
    await pushContext(baseUrl, 'session-b', second);

    const sessions = await fetch(`${baseUrl}/sessions`).then((res) => res.json());
    assert.deepEqual(sessions.map((session) => session.rateLimits), [second, second]);
  });
});

test('hub portfolio rateLimits ignores older reset_at after newer truth exists', async () => {
  const newer = {
    five_hour: { used_percentage: 14, resets_at: 1777320000 },
    seven_day: { used_percentage: 61, resets_at: 1777900000 },
  };
  const older = {
    five_hour: { used_percentage: 78, resets_at: 1777300000 },
    seven_day: { used_percentage: 60, resets_at: 1777900000 },
  };
  const ctx = createCtx();

  await withServer(ctx, async (baseUrl) => {
    await pushContext(baseUrl, 'session-b', newer);
    await pushContext(baseUrl, 'session-a', older);

    assert.deepEqual(ctx.sessions.get('session-a').rateLimits, older);
    const sessions = await fetch(`${baseUrl}/sessions`).then((res) => res.json());
    assert.deepEqual(sessions.map((session) => session.rateLimits), [newer, newer]);
  });
});
