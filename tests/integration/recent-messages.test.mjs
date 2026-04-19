import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createMcpTools } from '../../lib/mcp-tools.mjs';
import {
  TEST_TIMEOUT,
  closeWebSocket,
  connectSession,
  httpRequest,
  startHub,
  stopHub,
} from '../helpers/hub-fixture.mjs';

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function getJson(result) {
  return JSON.parse(result.content[0].text);
}

function createRecentMessagesTools({ port, sessionName }) {
  return createMcpTools({
    getSessionName: () => sessionName,
    setSessionName: () => {},
    getHubHost: () => '127.0.0.1',
    setHubHost: () => {},
    getHubPort: () => port,
    setHubPort: () => {},
    getWs: () => null,
    disconnectWs: () => {},
    reconnect: () => {},
    getPendingOutgoingCount: () => 0,
    wsSend: () => true,
    httpGet: async (url) => {
      const parsed = new URL(url);
      const response = await httpRequest(Number(parsed.port), {
        method: 'GET',
        path: `${parsed.pathname}${parsed.search}`,
      });
      return response.body;
    },
    httpPost: async () => {
      throw new Error('not implemented');
    },
    httpPatch: async () => {
      throw new Error('not implemented');
    },
    spawnSession: async () => {
      throw new Error('not implemented');
    },
  });
}

test('GET /recent-messages: 返回 6h 内发给 session 或广播的持久化消息', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'recent-messages-http' });
  const sessionName = uniqueName('recent-http');
  const receiver = await connectSession(hub.port, sessionName);
  const db = new Database(hub.dbPath);

  try {
    const direct = await httpRequest(hub.port, {
      method: 'POST',
      path: '/send',
      json: { from: uniqueName('sender'), to: sessionName, content: 'recent-direct' },
    });
    const broadcast = await httpRequest(hub.port, {
      method: 'POST',
      path: '/send',
      json: { from: uniqueName('sender'), to: '*', content: 'recent-broadcast' },
    });
    await httpRequest(hub.port, {
      method: 'POST',
      path: '/send',
      json: { from: uniqueName('sender'), to: uniqueName('other-target'), content: 'other-target' },
    });

    db.prepare(`
      INSERT INTO messages (id, type, "from", "to", content, content_type, topic, ts, status)
      VALUES (@id, 'message', @from, @to, @content, 'text', NULL, @ts, 'delivered')
    `).run({
      id: uniqueName('old-message'),
      from: uniqueName('sender'),
      to: sessionName,
      content: 'too-old',
      ts: Date.now() - 8 * 60 * 60 * 1000,
    });

    const response = await httpRequest(hub.port, {
      method: 'GET',
      path: `/recent-messages?name=${encodeURIComponent(sessionName)}`,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.name, sessionName);
    assert.equal(response.body.since, 21600000);
    assert.equal(response.body.limit, 50);
    assert.deepEqual(
      response.body.messages.map((message) => message.id),
      [direct.body.id, broadcast.body.id],
    );
  } finally {
    db.close();
    await closeWebSocket(receiver);
    await stopHub(hub);
  }
});

test('GET /recent-messages: 启用 AUTH_TOKEN 时接受 X-IPC-Token', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({
    prefix: 'recent-messages-auth',
    env: { IPC_AUTH_TOKEN: 'shared-secret' },
  });

  try {
    const unauthorized = await httpRequest(hub.port, {
      method: 'GET',
      path: `/recent-messages?name=${encodeURIComponent(uniqueName('auth-target'))}`,
    });
    assert.equal(unauthorized.statusCode, 401);

    const authorized = await httpRequest(hub.port, {
      method: 'GET',
      path: `/recent-messages?name=${encodeURIComponent(uniqueName('auth-target'))}`,
      headers: { 'X-IPC-Token': 'shared-secret' },
    });
    assert.equal(authorized.statusCode, 200);
    assert.equal(authorized.body.ok, true);
  } finally {
    await stopHub(hub);
  }
});

test('ipc_recent_messages: 返回当前 session 的 recent backlog', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'recent-messages-mcp' });
  const sessionName = uniqueName('recent-mcp');
  const receiver = await connectSession(hub.port, sessionName);

  try {
    const direct = await httpRequest(hub.port, {
      method: 'POST',
      path: '/send',
      json: { from: uniqueName('sender'), to: sessionName, content: 'tool-direct' },
    });
    const broadcast = await httpRequest(hub.port, {
      method: 'POST',
      path: '/send',
      json: { from: uniqueName('sender'), to: '*', content: 'tool-broadcast' },
    });

    const tools = createRecentMessagesTools({ port: hub.port, sessionName });
    const result = await tools.handleToolCall('ipc_recent_messages', {});
    const payload = getJson(result);

    assert.deepEqual(
      payload.messages.map((message) => message.id),
      [direct.body.id, broadcast.body.id],
    );
    assert.equal(payload.count, 2);
    assert.equal(payload.since, 21600000);
    assert.equal(payload.limit, 50);
  } finally {
    await closeWebSocket(receiver);
    await stopHub(hub);
  }
});
