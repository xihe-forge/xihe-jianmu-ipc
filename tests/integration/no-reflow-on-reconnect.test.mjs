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
  waitForHealth,
  waitForWebSocketMessage,
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

function seedNoReflowData(db, sessionName) {
  const baseTs = Date.now() - 60 * 60 * 1000;
  const recentMessageIds = [];
  const inboxMessageIds = [];
  const insertMessage = db.prepare(`
    INSERT INTO messages (id, type, "from", "to", content, content_type, topic, ts, status)
    VALUES (@id, 'message', @from, @to, @content, 'text', NULL, @ts, 'delivered')
  `);
  const insertInbox = db.prepare(`
    INSERT INTO inbox (session_name, message, ts)
    VALUES (@sessionName, @message, @ts)
  `);

  for (let index = 0; index < 5; index += 1) {
    const id = uniqueName(`recent-${index}`);
    recentMessageIds.push(id);
    insertMessage.run({
      id,
      from: uniqueName('sender'),
      to: sessionName,
      content: `recent-${index + 1}`,
      ts: baseTs + index,
    });
  }

  for (let index = 0; index < 2; index += 1) {
    const id = uniqueName(`inbox-${index}`);
    inboxMessageIds.push(id);
    insertInbox.run({
      sessionName,
      message: JSON.stringify({
        id,
        type: 'message',
        from: uniqueName('sender'),
        to: sessionName,
        content: `offline-${index + 1}`,
        contentType: 'text',
        ts: baseTs + 100 + index,
      }),
      ts: baseTs + 100 + index,
    });
  }

  return { recentMessageIds, inboxMessageIds };
}

test('no reflow on reconnect: flushInbox 只回放 inbox，不自动推 messages 表历史', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'no-reflow-on-reconnect-ws' });
  const sessionName = uniqueName('alice');
  const first = await connectSession(hub.port, sessionName);
  const db = new Database(hub.dbPath);

  try {
    await closeWebSocket(first);
    await waitForHealth(
      hub.port,
      (body) => !body.sessions.some((session) => session.name === sessionName),
    );

    const { recentMessageIds, inboxMessageIds } = seedNoReflowData(db, sessionName);
    const reconnected = await connectSession(hub.port, sessionName);

    try {
      const inbox = await waitForWebSocketMessage(
        reconnected,
        (message) => message.type === 'inbox',
      );

      assert.deepEqual(inbox.messages.map((message) => message.id), inboxMessageIds);
      assert.ok(inbox.messages.every((message) => !recentMessageIds.includes(message.id)));
    } finally {
      await closeWebSocket(reconnected);
    }
  } finally {
    db.close();
    await stopHub(hub);
  }
});

test('no reflow on reconnect: /recent-messages 仍可显式拉取 messages 表历史', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'no-reflow-on-reconnect-http' });
  const sessionName = uniqueName('alice');
  const first = await connectSession(hub.port, sessionName);
  const db = new Database(hub.dbPath);

  try {
    await closeWebSocket(first);
    await waitForHealth(
      hub.port,
      (body) => !body.sessions.some((session) => session.name === sessionName),
    );

    const { recentMessageIds } = seedNoReflowData(db, sessionName);
    const reconnected = await connectSession(hub.port, sessionName);

    try {
      const response = await httpRequest(hub.port, {
        method: 'GET',
        path: `/recent-messages?name=${encodeURIComponent(sessionName)}`,
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.body.messages.map((message) => message.id), recentMessageIds);
    } finally {
      await closeWebSocket(reconnected);
    }
  } finally {
    db.close();
    await stopHub(hub);
  }
});

test('no reflow on reconnect: ipc_recent_messages 仍可显式拉取 messages 表历史', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'no-reflow-on-reconnect-mcp' });
  const sessionName = uniqueName('alice');
  const first = await connectSession(hub.port, sessionName);
  const db = new Database(hub.dbPath);

  try {
    await closeWebSocket(first);
    await waitForHealth(
      hub.port,
      (body) => !body.sessions.some((session) => session.name === sessionName),
    );

    const { recentMessageIds } = seedNoReflowData(db, sessionName);
    const reconnected = await connectSession(hub.port, sessionName);

    try {
      const tools = createRecentMessagesTools({ port: hub.port, sessionName });
      const result = await tools.handleToolCall('ipc_recent_messages', {});
      const payload = getJson(result);

      assert.deepEqual(payload.messages.map((message) => message.id), recentMessageIds);
      assert.equal(payload.count, recentMessageIds.length);
    } finally {
      await closeWebSocket(reconnected);
    }
  } finally {
    db.close();
    await stopHub(hub);
  }
});
