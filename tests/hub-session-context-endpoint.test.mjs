import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHttpHandler } from '../lib/http-handlers.mjs';

function createCtx() {
  const sessions = new Map();
  const openWs = { readyState: 1, OPEN: 1 };
  sessions.set('harness', {
    name: 'harness',
    ws: openWs,
    connectedAt: 1000,
    lastAliveProbe: null,
    topics: new Set(['critique']),
    pid: 1234,
    cwd: 'D:/repo',
    contextUsagePct: null,
  });

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

test('POST /session/context updates registered session and /sessions exposes truth fields', async () => {
  const ctx = createCtx();
  await withServer(ctx, async (baseUrl) => {
    const body = {
      name: 'harness',
      session_id: 'session-123',
      transcript_path: 'D:/tmp/transcript.jsonl',
      model: { id: 'claude-opus-4-1' },
      cost: { total_cost_usd: 1.23 },
      context_window: { used_percentage: 42, max_tokens: 200000 },
      rate_limits: {
        five_hour: { used_percentage: 70, resets_at: 1777300000 },
        seven_day: { used_percentage: 80, resets_at: 1777900000 },
      },
      ts: 1777283654269,
    };

    const response = await fetch(`${baseUrl}/session/context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 204);

    const session = ctx.sessions.get('harness');
    assert.equal(session.contextUsagePct, 42);
    assert.deepEqual(session.contextWindow, body.context_window);
    assert.deepEqual(session.rateLimits, body.rate_limits);
    assert.deepEqual(session.cost, body.cost);
    assert.deepEqual(session.model, body.model);
    assert.equal(session.sessionId, body.session_id);
    assert.equal(session.transcriptPath, body.transcript_path);
    assert.equal(typeof session.lastStatuslinePushAt, 'number');

    const sessions = await fetch(`${baseUrl}/sessions`).then((res) => res.json());
    assert.deepEqual(sessions[0], {
      name: 'harness',
      connectedAt: 1000,
      startedAt: 1000,
      startupSource: 'unknown',
      label: 'harness',
      lastAliveProbe: null,
      topics: ['critique'],
      pid: 1234,
      cwd: 'D:/repo',
      contextUsagePct: 42,
      pendingOutgoing: 0,
      contextWindow: body.context_window,
      rateLimits: body.rate_limits,
      cost: body.cost,
      model: body.model,
      sessionId: body.session_id,
      transcriptPath: body.transcript_path,
      lastStatuslinePushAt: session.lastStatuslinePushAt,
    });
  });
});

test('POST /session/context ignores unknown names without creating stubs', async () => {
  const ctx = createCtx();
  await withServer(ctx, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/session/context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ghost', context_window: { used_percentage: 99 } }),
    });

    assert.equal(response.status, 204);
    assert.equal(ctx.sessions.has('ghost'), false);
    assert.equal(ctx.sessions.size, 1);
  });
});

test('POST /session/context returns 400 for invalid JSON', async () => {
  const ctx = createCtx();
  await withServer(ctx, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/session/context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad json',
    });
    assert.equal(response.status, 400);
  });
});
