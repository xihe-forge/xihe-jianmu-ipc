import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHttpHandler } from '../lib/http-handlers.mjs';

function createCtx({ usageProxy, AUTH_TOKEN = null, checkAuth = () => true }) {
  return {
    sessions: new Map(),
    routeMessage: () => {},
    broadcastToTopic: () => {},
    broadcastNetworkDown: () => {},
    broadcastNetworkUp: () => {},
    checkAuth,
    authTokens: null,
    AUTH_TOKEN,
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
    sessionReclaim: () => ({ ok: true }),
    feishuApps: [],
    getFeishuToken: () => null,
    stderr: () => {},
    audit: () => {},
    hubDir: process.cwd(),
    listSuspendedSessions: () => [],
    usageProxy,
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

test('GET /usage returns usage proxy payload', async () => {
  const payload = {
    ok: true,
    five_hour: { utilization: 11, resets_at: '2026-05-05T05:00:00Z' },
    seven_day: { utilization: 22, resets_at: '2026-05-12T00:00:00Z' },
    generated_at: '2026-05-05T00:00:00.000Z',
    source: 'jianmu-fresh',
  };
  const ctx = createCtx({ usageProxy: async () => payload });

  await withServer(ctx, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/usage`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, payload);
  });
});

test('GET /usage maps usage proxy failure to 502', async () => {
  const ctx = createCtx({
    usageProxy: async () => ({
      ok: false,
      five_hour: null,
      seven_day: null,
      generated_at: '2026-05-05T00:00:00.000Z',
      source: 'jianmu-failure',
      error: 'http-429',
    }),
  });

  await withServer(ctx, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/usage`);
    const body = await response.json();

    assert.equal(response.status, 502);
    assert.equal(body.ok, false);
    assert.equal(body.source, 'jianmu-failure');
    assert.equal(body.error, 'http-429');
  });
});

test('GET /usage is available to local HUD without IPC auth token', async () => {
  const payload = {
    ok: true,
    five_hour: { utilization: 5, resets_at: '2026-05-05T05:00:00Z' },
    seven_day: { utilization: 6, resets_at: '2026-05-12T00:00:00Z' },
    generated_at: '2026-05-05T00:00:00.000Z',
    source: 'jianmu-cache',
  };
  const ctx = createCtx({
    AUTH_TOKEN: 'secret-token',
    checkAuth: () => false,
    usageProxy: async () => payload,
  });

  await withServer(ctx, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/usage`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, payload);
  });
});
