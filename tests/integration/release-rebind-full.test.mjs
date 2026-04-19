import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import {
  TEST_TIMEOUT,
  buildSessionUrl,
  closeWebSocket,
  connectSession,
  httpRequest,
  sleep,
  startHub,
  stopHub,
  waitForClose,
  waitForHealth,
  waitForPingCount,
  waitForWebSocketMessage,
} from '../helpers/hub-fixture.mjs';

const LONG_TIMEOUT = Math.max(TEST_TIMEOUT, 20_000);

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

async function subscribeToTopic(ws, topic) {
  const subscribed = waitForWebSocketMessage(
    ws,
    (message) => message.type === 'subscribed' && message.topic === topic,
  );
  ws.send(JSON.stringify({ type: 'subscribe', topic }));
  await subscribed;
}

async function prepareRebind(port, name, options = {}) {
  const payload = { name };
  if (options.ttlSeconds !== undefined) payload.ttl_seconds = options.ttlSeconds;
  if (options.topics !== undefined) payload.topics = options.topics;
  if (options.nextSessionHint !== undefined) payload.next_session_hint = options.nextSessionHint;

  return httpRequest(port, {
    method: 'POST',
    path: '/prepare-rebind',
    json: payload,
    headers: {
      'X-IPC-Session': name,
      ...(options.headers ?? {}),
    },
  });
}

function findHealthSession(body, name) {
  return body.sessions.find((session) => session.name === name) ?? null;
}

function insertInboxMessages(dbPath, sessionName, messages) {
  const db = new Database(dbPath);
  try {
    const stmt = db.prepare(`
      INSERT INTO inbox (session_name, message, ts)
      VALUES (@sessionName, @message, @ts)
    `);
    const insertMany = db.transaction((rows) => {
      for (const message of rows) {
        stmt.run({
          sessionName,
          message: JSON.stringify(message),
          ts: message.ts,
        });
      }
    });
    insertMany(messages);
  } finally {
    db.close();
  }
}

function getPendingRebindRow(dbPath, name) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(`
      SELECT name, last_topics, buffered_messages, released_at, ttl_seconds, next_session_hint
      FROM pending_rebind
      WHERE name = @name
    `).get({ name }) ?? null;
  } finally {
    db.close();
  }
}

async function waitForPendingRebindDeletion(dbPath, name, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!getPendingRebindRow(dbPath, name)) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`pending_rebind ${name} 未在预期时间内被 cleanup job 删除`);
}

function hasBufferedMessage(ws, predicate) {
  return Array.isArray(ws?._bufferedMessages) && ws._bufferedMessages.some(predicate);
}

test('release-rebind: 正常 rebind 会继承 topics，并收到宽限期内 buffered 消息', { timeout: LONG_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'release-rebind-normal' });
  const sessionName = uniqueName('rebind-normal');
  const sender = uniqueName('sender');
  const first = await connectSession(hub.port, sessionName);

  try {
    await subscribeToTopic(first, 'foo');
    await subscribeToTopic(first, 'bar');

    const prepare = await prepareRebind(hub.port, sessionName, { ttlSeconds: 5 });
    assert.equal(prepare.statusCode, 200);

    await closeWebSocket(first);
    await waitForHealth(
      hub.port,
      (body) => !body.sessions.some((session) => session.name === sessionName),
    );

    const send = await httpRequest(hub.port, {
      method: 'POST',
      path: '/send',
      json: { from: sender, to: sessionName, content: 'during-grace' },
    });
    assert.equal(send.statusCode, 200);

    const replacement = await connectSession(hub.port, sessionName);
    try {
      const inbox = await waitForWebSocketMessage(
        replacement,
        (message) => message.type === 'inbox' && message.messages.some((item) => item.content === 'during-grace'),
      );
      assert.deepEqual(inbox.messages.map((message) => message.content), ['during-grace']);

      const health = await waitForHealth(
        hub.port,
        (body) => {
          const session = findHealthSession(body, sessionName);
          return Boolean(session) && session.topics.includes('foo') && session.topics.includes('bar');
        },
      );
      assert.deepEqual(findHealthSession(health, sessionName)?.topics.sort(), ['bar', 'foo']);
    } finally {
      await closeWebSocket(replacement);
    }
  } finally {
    await stopHub(hub);
  }
});

test('release-rebind: 5 秒超时后 cleanup job 删除 pending_rebind，新连接不继承 topics 或 buffered', { timeout: LONG_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'release-rebind-expire' });
  const sessionName = uniqueName('rebind-expire');
  const first = await connectSession(hub.port, sessionName);

  try {
    await subscribeToTopic(first, 'expiring-topic');

    const prepare = await prepareRebind(hub.port, sessionName, { ttlSeconds: 5 });
    assert.equal(prepare.statusCode, 200);

    await closeWebSocket(first);
    await waitForHealth(
      hub.port,
      (body) => !body.sessions.some((session) => session.name === sessionName),
    );

    await httpRequest(hub.port, {
      method: 'POST',
      path: '/send',
      json: { from: uniqueName('sender'), to: sessionName, content: 'should-expire' },
    });

    await waitForPendingRebindDeletion(hub.dbPath, sessionName);

    const replacement = await connectSession(hub.port, sessionName);
    try {
      await sleep(300);
      assert.equal(
        hasBufferedMessage(replacement, (message) => message.type === 'inbox' && message.messages.some((item) => item.content === 'should-expire')),
        false,
      );

      const health = await waitForHealth(
        hub.port,
        (body) => Boolean(findHealthSession(body, sessionName)),
      );
      assert.deepEqual(findHealthSession(health, sessionName)?.topics, []);
    } finally {
      await closeWebSocket(replacement);
    }
  } finally {
    await stopHub(hub);
  }
});

test('release-rebind: 未 prepare 的同名重连仍走现有 stub/inbox 逻辑，不继承旧 topics', { timeout: LONG_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'release-rebind-stub' });
  const sessionName = uniqueName('rebind-stub');
  const first = await connectSession(hub.port, sessionName);

  try {
    await subscribeToTopic(first, 'stale-topic');
    await closeWebSocket(first);
    await waitForHealth(
      hub.port,
      (body) => !body.sessions.some((session) => session.name === sessionName),
    );

    const send = await httpRequest(hub.port, {
      method: 'POST',
      path: '/send',
      json: { from: uniqueName('sender'), to: sessionName, content: 'offline-inbox' },
    });
    assert.equal(send.statusCode, 200);

    const replacement = await connectSession(hub.port, sessionName);
    try {
      const inbox = await waitForWebSocketMessage(
        replacement,
        (message) => message.type === 'inbox' && message.messages.some((item) => item.content === 'offline-inbox'),
      );
      assert.ok(inbox.messages.some((message) => message.content === 'offline-inbox'));

      const health = await waitForHealth(
        hub.port,
        (body) => Boolean(findHealthSession(body, sessionName)),
      );
      assert.deepEqual(findHealthSession(health, sessionName)?.topics, []);
    } finally {
      await closeWebSocket(replacement);
    }
  } finally {
    await stopHub(hub);
  }
});

test('release-rebind: inbox + buffered_messages 会按 ts 升序合并 flush 到新 session', { timeout: LONG_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'release-rebind-order' });
  const sessionName = uniqueName('rebind-order');
  const first = await connectSession(hub.port, sessionName);

  try {
    const persisted = [
      { id: uniqueName('persisted-1'), type: 'message', from: 'seed', to: sessionName, content: 'persisted-1', contentType: 'text', topic: null, ts: 10 },
      { id: uniqueName('persisted-2'), type: 'message', from: 'seed', to: sessionName, content: 'persisted-2', contentType: 'text', topic: null, ts: 20 },
      { id: uniqueName('persisted-3'), type: 'message', from: 'seed', to: sessionName, content: 'persisted-3', contentType: 'text', topic: null, ts: 30 },
    ];
    insertInboxMessages(hub.dbPath, sessionName, persisted);

    const prepare = await prepareRebind(hub.port, sessionName, { ttlSeconds: 5 });
    assert.equal(prepare.statusCode, 200);

    await closeWebSocket(first);
    await waitForHealth(
      hub.port,
      (body) => !body.sessions.some((session) => session.name === sessionName),
    );

    const bufferedPayloads = ['buffered-4', 'buffered-5'];
    for (const content of bufferedPayloads) {
      const response = await httpRequest(hub.port, {
        method: 'POST',
        path: '/send',
        json: { from: uniqueName('sender'), to: sessionName, content },
      });
      assert.equal(response.statusCode, 200);
    }

    const row = getPendingRebindRow(hub.dbPath, sessionName);
    const buffered = JSON.parse(row.buffered_messages);
    assert.deepEqual(buffered.map((message) => message.content), bufferedPayloads);

    const replacement = await connectSession(hub.port, sessionName);
    try {
      const inbox = await waitForWebSocketMessage(
        replacement,
        (message) => message.type === 'inbox' && message.messages.length === 5,
      );
      assert.deepEqual(
        inbox.messages.map((message) => message.content),
        ['persisted-1', 'persisted-2', 'persisted-3', 'buffered-4', 'buffered-5'],
      );
      assert.deepEqual(
        inbox.messages.map((message) => message.ts),
        [...inbox.messages.map((message) => message.ts)].sort((a, b) => a - b),
      );
    } finally {
      await closeWebSocket(replacement);
    }
  } finally {
    await stopHub(hub);
  }
});

test('release-rebind: 继任者自动继承 topic 订阅并能直接收到 topic fanout', { timeout: LONG_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'release-rebind-topics' });
  const sessionName = uniqueName('rebind-topics');
  const first = await connectSession(hub.port, sessionName);

  try {
    await subscribeToTopic(first, 'network-up');
    await subscribeToTopic(first, 'custom-xyz');

    const prepare = await prepareRebind(hub.port, sessionName, { ttlSeconds: 5 });
    assert.equal(prepare.statusCode, 200);

    await closeWebSocket(first);
    await waitForHealth(
      hub.port,
      (body) => !body.sessions.some((session) => session.name === sessionName),
    );

    const replacement = await connectSession(hub.port, sessionName);
    try {
      const health = await waitForHealth(
        hub.port,
        (body) => {
          const session = findHealthSession(body, sessionName);
          return Boolean(session) && session.topics.includes('network-up') && session.topics.includes('custom-xyz');
        },
      );
      assert.deepEqual(findHealthSession(health, sessionName)?.topics.sort(), ['custom-xyz', 'network-up']);

      const receive = waitForWebSocketMessage(
        replacement,
        (message) => message.type === 'message' && message.topic === 'custom-xyz' && message.content === 'topic-inherited',
      );
      const send = await httpRequest(hub.port, {
        method: 'POST',
        path: '/send',
        json: { from: uniqueName('sender'), to: '*', topic: 'custom-xyz', content: 'topic-inherited' },
      });
      assert.equal(send.statusCode, 200);

      const delivered = await receive;
      assert.equal(delivered.to, '*');
      assert.equal(delivered.topic, 'custom-xyz');
    } finally {
      await closeWebSocket(replacement);
    }
  } finally {
    await stopHub(hub);
  }
});

test('release-rebind: force=1 在无 pending_rebind 时走僵尸接管，有 pending_rebind 时不会 kill 且最终走 rebind', { timeout: LONG_TIMEOUT }, async () => {
  const zombieHub = await startHub({
    prefix: 'release-rebind-force-zombie',
    heartbeatIntervalMs: 150,
    heartbeatTimeoutMs: 450,
  });
  const zombieSession = uniqueName('force-zombie');
  const original = await connectSession(zombieHub.port, zombieSession, { autoPong: false });

  try {
    await waitForPingCount(original, 1, 2_000);
    const originalClose = waitForClose(original, 2_000);
    const replacement = await connectSession(zombieHub.port, zombieSession, { force: true });

    try {
      const closeEvent = await originalClose;
      assert.equal(closeEvent.code, 1006);

      const send = await httpRequest(zombieHub.port, {
        method: 'POST',
        path: '/send',
        json: { from: uniqueName('sender'), to: zombieSession, content: 'after-force-zombie' },
      });
      assert.equal(send.statusCode, 200);

      const delivered = await waitForWebSocketMessage(
        replacement,
        (message) => message.type === 'message' && message.content === 'after-force-zombie',
      );
      assert.equal(delivered.to, zombieSession);
    } finally {
      await closeWebSocket(replacement);
    }
  } finally {
    await stopHub(zombieHub);
  }

  const rebindHub = await startHub({ prefix: 'release-rebind-force-explicit' });
  const rebindSession = uniqueName('force-explicit');
  const first = await connectSession(rebindHub.port, rebindSession);

  try {
    const prepare = await prepareRebind(rebindHub.port, rebindSession, { ttlSeconds: 5 });
    assert.equal(prepare.statusCode, 200);

    const premature = new WebSocket(buildSessionUrl(rebindHub.port, rebindSession, { force: true }));
    try {
      const closeEvent = await waitForClose(premature, 2_000);
      assert.equal(closeEvent.code, 4001);
      assert.equal(closeEvent.reason, 'name taken');
      assert.equal(first.readyState, WebSocket.OPEN, 'pending_rebind 期间 force=1 不应杀掉旧连接');
    } finally {
      await closeWebSocket(premature);
    }

    await closeWebSocket(first);
    await waitForHealth(
      rebindHub.port,
      (body) => !body.sessions.some((session) => session.name === rebindSession),
    );

    await httpRequest(rebindHub.port, {
      method: 'POST',
      path: '/send',
      json: { from: uniqueName('sender'), to: rebindSession, content: 'after-force-rebind' },
    });

    const replacement = await connectSession(rebindHub.port, rebindSession, { force: true });
    try {
      const inbox = await waitForWebSocketMessage(
        replacement,
        (message) => message.type === 'inbox' && message.messages.some((item) => item.content === 'after-force-rebind'),
      );
      assert.ok(inbox.messages.some((message) => message.content === 'after-force-rebind'));
    } finally {
      await closeWebSocket(replacement);
    }
  } finally {
    await stopHub(rebindHub);
  }
});
