import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHttpHandler } from '../../lib/http-handlers.mjs';
import {
  TEST_TIMEOUT,
  closeWebSocket,
  connectSession,
  httpRequest,
  readAuditEntries,
  startHub,
  stopHub,
  waitForClose,
  waitForWebSocketMessage,
} from '../helpers/hub-fixture.mjs';

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function createStubHandlerContext(overrides = {}) {
  return {
    sessions: new Map(),
    routeMessage: () => {},
    broadcastToTopic: () => [],
    broadcastNetworkDown: async () => ({ broadcastTo: 0, subscribers: [] }),
    broadcastNetworkUp: async () => ({ broadcastTo: 0, subscribers: [], clearedSessions: [] }),
    checkAuth: () => true,
    authTokens: null,
    AUTH_TOKEN: null,
    INTERNAL_TOKEN: 'test-internal-token',
    createMessage: (value) => value,
    createTask: (value) => value,
    TASK_STATUSES: [],
    saveTask: () => {},
    getTask: () => null,
    updateTaskStatus: () => {},
    listTasks: () => [],
    getTaskStats: () => [],
    getMessages: () => [],
    getRecipientRecent: () => [],
    getMessageCount: () => 0,
    getMessageCountByAgent: () => [],
    suspendSession: () => ({}),
    createPendingRebind: () => {},
    registerSessionRecord: async () => ({}),
    updateSessionRecordProjects: async () => ({}),
    sessionReclaim: async () => ({ ok: true, evicted: true }),
    feishuApps: [],
    getFeishuToken: async () => null,
    stderr: () => {},
    audit: () => {},
    hubDir: process.cwd(),
    ...overrides,
  };
}

function listenServer(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

test('POST /reclaim-name: non-loopback 请求返回 403', { timeout: TEST_TIMEOUT }, async () => {
  const handler = createHttpHandler(createStubHandlerContext());
  const server = http.createServer((req, res) => {
    Object.defineProperty(req.socket, 'remoteAddress', {
      configurable: true,
      value: '8.8.8.8',
    });
    handler(req, res);
  });

  try {
    const port = await listenServer(server);
    const response = await httpRequest(port, {
      method: 'POST',
      path: '/reclaim-name',
      json: { name: 'worker-a' },
    });

    assert.equal(response.statusCode, 403);
    assert.deepEqual(response.body, { ok: false, reason: 'non-loopback' });
  } finally {
    await closeServer(server);
  }
});

test(
  'POST /reclaim-name: zombie holder 无 pong 时会 terminate 旧连接，后续同名重连收到 inbox 回放',
  { timeout: TEST_TIMEOUT + 8_000 },
  async () => {
    const hub = await startHub({ prefix: 'reclaim-name-zombie' });
    const sessionName = uniqueName('reclaim-zombie');
    const auditStart = readAuditEntries().length;
    const original = await connectSession(hub.port, sessionName, { autoPong: false });

    try {
      const originalClose = waitForClose(original, 8_000);
      const response = await httpRequest(hub.port, {
        method: 'POST',
        path: '/reclaim-name',
        json: { name: sessionName },
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.body.ok, true);
      assert.equal(response.body.evicted, true);
      assert.equal(typeof response.body.previousConnectedAt, 'number');

      const closeEvent = await originalClose;
      assert.equal(closeEvent.code, 1006);

      await httpRequest(hub.port, {
        method: 'POST',
        path: '/send',
        json: {
          from: uniqueName('sender'),
          to: sessionName,
          content: 'buffered-after-reclaim',
        },
      });

      const replacement = await connectSession(hub.port, sessionName);
      try {
        const inbox = await waitForWebSocketMessage(
          replacement,
          (message) =>
            message.type === 'inbox'
            && message.messages.some((item) => item.content === 'buffered-after-reclaim'),
        );

        assert.ok(inbox.messages.some((item) => item.content === 'buffered-after-reclaim'));

        const audits = readAuditEntries()
          .slice(auditStart)
          .filter((entry) => entry.event === 'reclaim_evict' && entry.name === sessionName);
        assert.equal(audits.length, 1);
      } finally {
        await closeWebSocket(replacement);
      }
    } finally {
      await closeWebSocket(original);
      await stopHub(hub);
    }
  },
);

test('POST /reclaim-name: holder 仍存活时返回 holder-alive 且旧连接保持在线', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'reclaim-name-alive' });
  const sessionName = uniqueName('reclaim-alive');
  const original = await connectSession(hub.port, sessionName);

  try {
    const response = await httpRequest(hub.port, {
      method: 'POST',
      path: '/reclaim-name',
      json: { name: sessionName },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.reason, 'holder-alive');
    assert.equal(typeof response.body.lastAliveAt, 'number');

    await httpRequest(hub.port, {
      method: 'POST',
      path: '/send',
      json: {
        from: uniqueName('sender'),
        to: sessionName,
        content: 'still-owned-by-original',
      },
    });
    const delivered = await waitForWebSocketMessage(
      original,
      (message) => message.type === 'message' && message.content === 'still-owned-by-original',
    );
    assert.equal(delivered.to, sessionName);
  } finally {
    await closeWebSocket(original);
    await stopHub(hub);
  }
});
