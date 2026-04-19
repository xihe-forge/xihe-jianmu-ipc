import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  TEST_TIMEOUT,
  closeWebSocket,
  connectSession,
  httpRequest,
  startHub,
  stopHub,
  waitForWebSocketMessage,
} from '../helpers/hub-fixture.mjs';

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

function readPendingRebind(dbPath, name) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(`
      SELECT name, last_topics, buffered_messages, released_at, ttl_seconds, next_session_hint
      FROM pending_rebind
      WHERE name = @name
    `).get({ name });
  } finally {
    db.close();
  }
}

test('POST /prepare-rebind: 在线 session 可成功创建 pending_rebind 并继承当前 topics', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'prepare-rebind-success' });
  const sessionName = uniqueName('prepare-success');
  const ws = await connectSession(hub.port, sessionName);

  try {
    await subscribeToTopic(ws, 'foo');
    await subscribeToTopic(ws, 'bar');

    const response = await httpRequest(hub.port, {
      method: 'POST',
      path: '/prepare-rebind',
      json: { name: sessionName },
      headers: { 'X-IPC-Session': sessionName },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      ok: true,
      will_release_at: response.body.will_release_at,
      ttl_seconds: 5,
    });

    const row = readPendingRebind(hub.dbPath, sessionName);
    assert.equal(row.name, sessionName);
    assert.equal(row.ttl_seconds, 5);
    assert.deepEqual(JSON.parse(row.last_topics), ['foo', 'bar']);
    assert.deepEqual(JSON.parse(row.buffered_messages), []);
    assert.equal(response.body.will_release_at, row.released_at + row.ttl_seconds * 1000);
  } finally {
    await closeWebSocket(ws);
    await stopHub(hub);
  }
});

test('POST /prepare-rebind: 未在线 session 返回 403', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'prepare-rebind-offline' });

  try {
    const response = await httpRequest(hub.port, {
      method: 'POST',
      path: '/prepare-rebind',
      json: { name: uniqueName('missing-session') },
    });

    assert.equal(response.statusCode, 403);
    assert.deepEqual(response.body, { ok: false, error: 'session not connected' });
  } finally {
    await stopHub(hub);
  }
});

test('POST /prepare-rebind: 同名未过期重复请求返回 409', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'prepare-rebind-duplicate' });
  const sessionName = uniqueName('prepare-duplicate');
  const ws = await connectSession(hub.port, sessionName);

  try {
    const first = await httpRequest(hub.port, {
      method: 'POST',
      path: '/prepare-rebind',
      json: { name: sessionName, ttl_seconds: 9 },
      headers: { 'X-IPC-Session': sessionName },
    });
    assert.equal(first.statusCode, 200);

    const second = await httpRequest(hub.port, {
      method: 'POST',
      path: '/prepare-rebind',
      json: { name: sessionName, ttl_seconds: 9 },
      headers: { 'X-IPC-Session': sessionName },
    });

    assert.equal(second.statusCode, 409);
    assert.deepEqual(second.body, {
      ok: false,
      error: 'rebind already pending',
      will_release_at: first.body.will_release_at,
    });
  } finally {
    await closeWebSocket(ws);
    await stopHub(hub);
  }
});

test('POST /prepare-rebind: ttl_seconds 超过 60 返回 400', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'prepare-rebind-ttl' });
  const sessionName = uniqueName('prepare-ttl');
  const ws = await connectSession(hub.port, sessionName);

  try {
    const response = await httpRequest(hub.port, {
      method: 'POST',
      path: '/prepare-rebind',
      json: { name: sessionName, ttl_seconds: 61 },
      headers: { 'X-IPC-Session': sessionName },
    });

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.body, { ok: false, error: 'ttl_seconds max 60' });
  } finally {
    await closeWebSocket(ws);
    await stopHub(hub);
  }
});

test('POST /prepare-rebind: 启用共享 AUTH_TOKEN 时要求 Bearer', { timeout: TEST_TIMEOUT }, async () => {
  const token = 'prepare-shared-token';
  const hub = await startHub({
    prefix: 'prepare-rebind-auth',
    env: { IPC_AUTH_TOKEN: token },
  });
  const sessionName = uniqueName('prepare-auth');
  const ws = await connectSession(hub.port, sessionName, { token });

  try {
    const unauthorized = await httpRequest(hub.port, {
      method: 'POST',
      path: '/prepare-rebind',
      json: { name: sessionName },
      headers: { 'X-IPC-Session': sessionName },
    });
    assert.equal(unauthorized.statusCode, 401);
    assert.deepEqual(unauthorized.body, { error: 'unauthorized' });

    const authorized = await httpRequest(hub.port, {
      method: 'POST',
      path: '/prepare-rebind',
      json: { name: sessionName },
      headers: {
        'X-IPC-Session': sessionName,
        Authorization: `Bearer ${token}`,
      },
    });
    assert.equal(authorized.statusCode, 200);
    assert.equal(authorized.body.ok, true);
  } finally {
    await closeWebSocket(ws);
    await stopHub(hub);
  }
});
