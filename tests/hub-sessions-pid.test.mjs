import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  closeWebSocket,
  connectSession,
  httpRequest,
  startHub,
  stopHub,
  TEST_TIMEOUT,
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
