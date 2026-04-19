import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TEST_TIMEOUT,
  closeWebSocket,
  connectSession,
  httpRequest,
  setHubNowOffset,
  startHub,
  stopHub,
  waitForHealth,
  waitForWebSocketMessage,
} from '../helpers/hub-fixture.mjs';

const NO_INBOX_TIMEOUT = 400;
const REPLAY_TIMEOUT = 8_000;
const COLD_START_OFFSET_MS = 40 * 60 * 1000;

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

async function seedOfflineMessages(port, sessionName, sender, contents) {
  const expectedIds = [];

  for (const content of contents) {
    const response = await httpRequest(port, {
      method: 'POST',
      path: '/send',
      json: { from: sender, to: sessionName, content },
    });
    assert.equal(response.statusCode, 200);
    expectedIds.push(response.body.id);
  }

  return expectedIds;
}

async function waitUntilOffline(hub, sessionName) {
  await waitForHealth(
    hub.port,
    (body) => !body.sessions.some((session) => session.name === sessionName),
    REPLAY_TIMEOUT,
  );
}

test('reconnect no reflow: 首次连接会回放 recent/inbox 历史', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'reconnect-no-reflow-first' });
  const sessionName = uniqueName('alice');
  const sender = uniqueName('sender');
  const contents = ['backlog-1', 'backlog-2', 'backlog-3', 'backlog-4', 'backlog-5'];

  try {
    const expectedIds = await seedOfflineMessages(hub.port, sessionName, sender, contents);
    const first = await connectSession(hub.port, sessionName);

    try {
      const inbox = await waitForWebSocketMessage(
        first,
        (message) => message.type === 'inbox' && Array.isArray(message.messages) && message.messages.length >= expectedIds.length,
        REPLAY_TIMEOUT,
      );

      assert.deepEqual(inbox.messages.map((message) => message.id), expectedIds);
      assert.deepEqual(inbox.messages.map((message) => message.content), contents);
    } finally {
      await closeWebSocket(first);
      await waitUntilOffline(hub, sessionName);
    }
  } finally {
    await stopHub(hub);
  }
});

test('reconnect no reflow: 短时重连不会再次回放 recent messages', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'reconnect-no-reflow-fast' });
  const sessionName = uniqueName('alice');
  const sender = uniqueName('sender');
  const contents = ['backlog-1', 'backlog-2', 'backlog-3', 'backlog-4', 'backlog-5'];

  try {
    const expectedIds = await seedOfflineMessages(hub.port, sessionName, sender, contents);
    const first = await connectSession(hub.port, sessionName);

    try {
      const inbox = await waitForWebSocketMessage(
        first,
        (message) => message.type === 'inbox' && Array.isArray(message.messages) && message.messages.length >= expectedIds.length,
        REPLAY_TIMEOUT,
      );
      assert.deepEqual(inbox.messages.map((message) => message.id), expectedIds);
    } finally {
      await closeWebSocket(first);
      await waitUntilOffline(hub, sessionName);
    }

    const reconnected = await connectSession(hub.port, sessionName);
    try {
      await assert.rejects(
        waitForWebSocketMessage(reconnected, (message) => message.type === 'inbox', NO_INBOX_TIMEOUT),
      );
    } finally {
      await closeWebSocket(reconnected);
      await waitUntilOffline(hub, sessionName);
    }
  } finally {
    await stopHub(hub);
  }
});

test('reconnect no reflow: 40 分钟后重连视为冷启并回放 recent messages', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'reconnect-no-reflow-cold' });
  const sessionName = uniqueName('alice');
  const sender = uniqueName('sender');
  const contents = ['backlog-1', 'backlog-2', 'backlog-3', 'backlog-4', 'backlog-5'];

  try {
    const expectedIds = await seedOfflineMessages(hub.port, sessionName, sender, contents);
    const first = await connectSession(hub.port, sessionName);

    try {
      const inbox = await waitForWebSocketMessage(
        first,
        (message) => message.type === 'inbox' && Array.isArray(message.messages) && message.messages.length >= expectedIds.length,
        REPLAY_TIMEOUT,
      );
      assert.deepEqual(inbox.messages.map((message) => message.id), expectedIds);
    } finally {
      await closeWebSocket(first);
      await waitUntilOffline(hub, sessionName);
    }

    setHubNowOffset(hub, COLD_START_OFFSET_MS);

    const reconnected = await connectSession(hub.port, sessionName);
    try {
      const inbox = await waitForWebSocketMessage(
        reconnected,
        (message) => message.type === 'inbox' && Array.isArray(message.messages) && message.messages.length >= expectedIds.length,
        REPLAY_TIMEOUT,
      );

      assert.deepEqual(inbox.messages.map((message) => message.id), expectedIds);
      assert.deepEqual(inbox.messages.map((message) => message.content), contents);
    } finally {
      await closeWebSocket(reconnected);
      await waitUntilOffline(hub, sessionName);
    }
  } finally {
    await stopHub(hub);
  }
});
