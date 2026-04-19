import { test } from 'node:test';
import assert from 'node:assert/strict';
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

test('reconnect replay: 离线期间发给 session 的消息会经 inbox 回放', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'reconnect-replay-offline' });
  const sessionName = uniqueName('replay-offline');
  const sender = uniqueName('sender');
  const first = await connectSession(hub.port, sessionName);

  try {
    await closeWebSocket(first);
    await waitForHealth(
      hub.port,
      (body) => !body.sessions.some((session) => session.name === sessionName),
    );

    const expectedIds = [];
    const expectedContents = ['offline-1', 'offline-2', 'offline-3'];
    for (const content of expectedContents) {
      const response = await httpRequest(hub.port, {
        method: 'POST',
        path: '/send',
        json: { from: sender, to: sessionName, content },
      });
      assert.equal(response.statusCode, 200);
      expectedIds.push(response.body.id);
    }

    const reconnected = await connectSession(hub.port, sessionName);
    try {
      const inbox = await waitForWebSocketMessage(
        reconnected,
        (message) => message.type === 'inbox',
      );

      assert.deepEqual(inbox.messages.map((message) => message.id), expectedIds);
      assert.deepEqual(inbox.messages.map((message) => message.content), expectedContents);
    } finally {
      await closeWebSocket(reconnected);
    }
  } finally {
    await stopHub(hub);
  }
});

test('reconnect replay: 在线期间消息在崩溃后需显式从 /recent-messages 拉取', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'reconnect-replay-recent' });
  const sessionName = uniqueName('replay-recent');
  const sender = uniqueName('sender');
  const online = await connectSession(hub.port, sessionName);

  try {
    const sent = [];
    for (const content of ['live-1', 'live-2']) {
      const response = await httpRequest(hub.port, {
        method: 'POST',
        path: '/send',
        json: { from: sender, to: sessionName, content },
      });
      assert.equal(response.statusCode, 200);
      sent.push({ id: response.body.id, content });
    }

    online.terminate();
    await waitForHealth(
      hub.port,
      (body) => !body.sessions.some((session) => session.name === sessionName),
    );

    const reconnected = await connectSession(hub.port, sessionName);
    try {
      const response = await httpRequest(hub.port, {
        method: 'GET',
        path: `/recent-messages?name=${encodeURIComponent(sessionName)}`,
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.body.messages.map((message) => message.id), sent.map((item) => item.id));
      assert.deepEqual(response.body.messages.map((message) => message.content), sent.map((item) => item.content));
    } finally {
      await closeWebSocket(reconnected);
    }
  } finally {
    await stopHub(hub);
  }
});
