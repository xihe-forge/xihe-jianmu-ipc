import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  closeWebSocket,
  connectSession,
  httpRequest,
  startHub,
  stopHub,
  TEST_TIMEOUT,
  waitForWebSocketMessage,
} from './helpers/hub-fixture.mjs';

async function getSessions(port) {
  const response = await httpRequest(port, { method: 'GET', path: '/sessions' });
  assert.equal(response.statusCode, 200);
  assert.ok(Array.isArray(response.body));
  return response.body;
}

test('T-ADR-006-V03-WIRING-FIX /sessions returns null pid when register omits pid', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'hub-sessions-pid-null' });
  const ws = await connectSession(hub.port, 'pid-null');
  try {
    const sessions = await getSessions(hub.port);
    assert.equal(sessions.find((session) => session.name === 'pid-null')?.pid, null);
  } finally {
    await closeWebSocket(ws);
    await stopHub(hub);
  }
});

test('T-ADR-006-V03-WIRING-FIX /sessions persists pid from register', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'hub-sessions-pid-value' });
  const ws = await connectSession(hub.port, 'pid-value', { register: { pid: 12345 } });
  try {
    const sessions = await getSessions(hub.port);
    assert.equal(sessions.find((session) => session.name === 'pid-value')?.pid, 12345);
  } finally {
    await closeWebSocket(ws);
    await stopHub(hub);
  }
});

test('T-ADR-010-MOD6 /sessions persists contextUsagePct from register', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'hub-sessions-context-usage' });
  const ws = await connectSession(hub.port, 'context-usage-value', {
    register: { pid: 12345, contextUsagePct: 61.5 },
  });
  try {
    const sessions = await getSessions(hub.port);
    const session = sessions.find((item) => item.name === 'context-usage-value');
    assert.equal(session?.pid, 12345);
    assert.equal(session?.contextUsagePct, 61.5);
  } finally {
    await closeWebSocket(ws);
    await stopHub(hub);
  }
});

test('T-ADR-010-MOD6-KU /sessions keeps contextWindow truth across stale register and update', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'hub-sessions-context-window-truth' });
  const name = 'context-window-truth';
  const cwd = 'D:\\workspace\\ai\\research\\xiheAi\\xihe-jianmu-ipc';
  const ws = await connectSession(hub.port, name, {
    register: { pid: 12345, cwd, contextUsagePct: 0.04 },
  });
  try {
    await waitForWebSocketMessage(ws, (message) => message.type === 'registered' && message.name === name);

    const contextWindow = { used_percentage: 70, max_tokens: 200000 };
    const response = await httpRequest(hub.port, {
      method: 'POST',
      path: '/session/context',
      json: { name, context_window: contextWindow },
    });
    assert.equal(response.statusCode, 204);

    ws.send(JSON.stringify({ type: 'update', name, contextUsagePct: 0.0412 }));
    await waitForWebSocketMessage(ws, (message) => message.type === 'updated' && message.name === name);

    ws.send(JSON.stringify({ type: 'register', name, pid: 12345, cwd, contextUsagePct: 0.0412 }));
    await waitForWebSocketMessage(ws, (message) => message.type === 'registered' && message.name === name);

    const sessions = await getSessions(hub.port);
    const session = sessions.find((item) => item.name === name);
    assert.equal(session?.contextUsagePct, 70);
    assert.deepEqual(session?.contextWindow, contextWindow);
  } finally {
    await closeWebSocket(ws);
    await stopHub(hub);
  }
});

test('T-ADR-010-MOD6-WIRING-V3 /sessions persists cwd from register', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'hub-sessions-cwd-value' });
  const ws = await connectSession(hub.port, 'cwd-value', {
    register: { pid: 12345, cwd: 'D:\\workspace\\ai\\research\\xiheAi\\xihe-jianmu-ipc' },
  });
  try {
    const sessions = await getSessions(hub.port);
    const session = sessions.find((item) => item.name === 'cwd-value');
    assert.equal(session?.pid, 12345);
    assert.equal(session?.cwd, 'D:\\workspace\\ai\\research\\xiheAi\\xihe-jianmu-ipc');
  } finally {
    await closeWebSocket(ws);
    await stopHub(hub);
  }
});

test('T-ADR-010-MOD6-WIRING-V3 /sessions cwd null when not provided', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'hub-sessions-cwd-null' });
  const ws = await connectSession(hub.port, 'cwd-null', { register: { pid: 12345 } });
  try {
    const sessions = await getSessions(hub.port);
    assert.equal(sessions.find((session) => session.name === 'cwd-null')?.cwd, null);
  } finally {
    await closeWebSocket(ws);
    await stopHub(hub);
  }
});

test('T-ADR-006-V03-WIRING-FIX /sessions keeps pid isolated per session', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'hub-sessions-pid-isolated' });
  const first = await connectSession(hub.port, 'pid-a', { register: { pid: 111 } });
  const second = await connectSession(hub.port, 'pid-b', { register: { pid: 222 } });
  try {
    const byName = new Map((await getSessions(hub.port)).map((session) => [session.name, session]));
    assert.equal(byName.get('pid-a')?.pid, 111);
    assert.equal(byName.get('pid-b')?.pid, 222);
  } finally {
    await closeWebSocket(first);
    await closeWebSocket(second);
    await stopHub(hub);
  }
});

test('T-ADR-006-V03-WIRING-FIX disconnect does not mutate another session pid', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'hub-sessions-pid-disconnect' });
  const closed = await connectSession(hub.port, 'pid-closed', { register: { pid: 333 } });
  const survivor = await connectSession(hub.port, 'pid-survivor', { register: { pid: 444 } });
  try {
    await closeWebSocket(closed);
    const sessions = await getSessions(hub.port);
    assert.equal(sessions.find((session) => session.name === 'pid-survivor')?.pid, 444);
  } finally {
    await closeWebSocket(survivor);
    await stopHub(hub);
  }
});
