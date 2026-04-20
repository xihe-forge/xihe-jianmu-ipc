import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  closeWebSocket,
  connectSession,
  httpRequest,
  startHub,
  stopHub,
} from '../helpers/hub-fixture.mjs';

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

test('GET /session-alive: 在线 session 返回 alive=true', async () => {
  const hub = await startHub({ prefix: 'session-alive-online' });
  const sessionName = uniqueName('alive-online');
  const ws = await connectSession(hub.port, sessionName);

  try {
    const response = await httpRequest(hub.port, {
      method: 'GET',
      path: `/session-alive?name=${encodeURIComponent(sessionName)}`,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.name, sessionName);
    assert.equal(response.body.alive, true);
    assert.equal(typeof response.body.connectedAt, 'number');
    assert.equal(typeof response.body.lastAliveProbe, 'number');
  } finally {
    await closeWebSocket(ws);
    await stopHub(hub);
  }
});

test('GET /session-alive: 已断开的真实 session 返回 alive=false 且保留 connectedAt', async () => {
  const hub = await startHub({ prefix: 'session-alive-offline' });
  const sessionName = uniqueName('alive-offline');
  const ws = await connectSession(hub.port, sessionName);

  try {
    await closeWebSocket(ws);

    const response = await httpRequest(hub.port, {
      method: 'GET',
      path: `/session-alive?name=${encodeURIComponent(sessionName)}`,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.name, sessionName);
    assert.equal(response.body.alive, false);
    assert.equal(typeof response.body.connectedAt, 'number');
    assert.ok(response.body.connectedAt > 0);
  } finally {
    await stopHub(hub);
  }
});

test('GET /session-alive: stub session(ws=null) 返回 alive=false', async () => {
  const hub = await startHub({ prefix: 'session-alive-stub' });
  const sessionName = uniqueName('alive-stub');

  try {
    await httpRequest(hub.port, {
      method: 'POST',
      path: '/send',
      json: {
        from: uniqueName('sender'),
        to: sessionName,
        content: 'create stub',
      },
    });

    const response = await httpRequest(hub.port, {
      method: 'GET',
      path: `/session-alive?name=${encodeURIComponent(sessionName)}`,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.name, sessionName);
    assert.equal(response.body.alive, false);
    assert.equal(response.body.connectedAt, 0);
  } finally {
    await stopHub(hub);
  }
});

test('GET /session-alive: 不存在的 session 返回 alive=false 且 connectedAt=null', async () => {
  const hub = await startHub({ prefix: 'session-alive-nonexistent' });
  const sessionName = uniqueName('alive-missing');

  try {
    const response = await httpRequest(hub.port, {
      method: 'GET',
      path: `/session-alive?name=${encodeURIComponent(sessionName)}`,
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      ok: true,
      name: sessionName,
      alive: false,
      connectedAt: null,
      lastAliveProbe: response.body.lastAliveProbe,
    });
    assert.equal(typeof response.body.lastAliveProbe, 'number');
  } finally {
    await stopHub(hub);
  }
});

test('GET /session-alive: 未启用 AUTH_TOKEN 时允许匿名访问', async () => {
  const hub = await startHub({ prefix: 'session-alive-auth-open' });

  try {
    const response = await httpRequest(hub.port, {
      method: 'GET',
      path: `/session-alive?name=${encodeURIComponent(uniqueName('open-access'))}`,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true);
  } finally {
    await stopHub(hub);
  }
});

test('GET /session-alive: 启用 AUTH_TOKEN 时缺 Bearer 返回 401', async () => {
  const hub = await startHub({
    prefix: 'session-alive-auth-missing',
    env: { IPC_AUTH_TOKEN: 'shared-secret' },
  });

  try {
    const response = await httpRequest(hub.port, {
      method: 'GET',
      path: `/session-alive?name=${encodeURIComponent(uniqueName('missing-auth'))}`,
    });

    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.body, { error: 'unauthorized' });
  } finally {
    await stopHub(hub);
  }
});

test('GET /session-alive: 启用 AUTH_TOKEN 时错 Bearer 返回 401', async () => {
  const hub = await startHub({
    prefix: 'session-alive-auth-wrong',
    env: { IPC_AUTH_TOKEN: 'shared-secret' },
  });

  try {
    const response = await httpRequest(hub.port, {
      method: 'GET',
      path: `/session-alive?name=${encodeURIComponent(uniqueName('wrong-auth'))}`,
      headers: {
        Authorization: 'Bearer wrong-secret',
      },
    });

    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.body, { error: 'unauthorized' });
  } finally {
    await stopHub(hub);
  }
});

test('GET /session-alive: 启用 AUTH_TOKEN 时正确 Bearer 返回 200', async () => {
  const token = 'shared-secret';
  const hub = await startHub({
    prefix: 'session-alive-auth-ok',
    env: { IPC_AUTH_TOKEN: token },
  });
  const sessionName = uniqueName('auth-ok');
  const ws = await connectSession(hub.port, sessionName, { token });

  try {
    const response = await httpRequest(hub.port, {
      method: 'GET',
      path: `/session-alive?name=${encodeURIComponent(sessionName)}`,
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.name, sessionName);
    assert.equal(response.body.alive, true);
  } finally {
    await closeWebSocket(ws);
    await stopHub(hub);
  }
});
