import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import {
  TEST_TIMEOUT,
  buildSessionUrl,
  closeWebSocket,
  connectSession,
  httpRequest,
  startHub,
  stopHub,
  waitForClose,
  waitForWebSocketMessage,
} from '../helpers/hub-fixture.mjs';

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

test('Hub register: rejects PID fallback and invalid session names', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'naming-register' });

  try {
    const pidName = `session-${process.pid}`;
    const pidWs = new WebSocket(buildSessionUrl(hub.port, pidName));
    const pidClose = await waitForClose(pidWs);
    assert.equal(pidClose.code, 4000);
    assert.match(pidClose.reason, /PID-based session names are not allowed/);

    const invalidWs = new WebSocket(buildSessionUrl(hub.port, 'Bad_Name'));
    const invalidClose = await waitForClose(invalidWs);
    assert.equal(invalidClose.code, 4000);
    assert.match(invalidClose.reason, /session name must match/);
  } finally {
    await stopHub(hub);
  }
});

test('POST /registry/register: rejects PID fallback and invalid session names', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'naming-registry' });

  try {
    const pidResponse = await httpRequest(hub.port, {
      method: 'POST',
      path: '/registry/register',
      json: {
        name: `session-${process.pid}`,
        role: 'worker',
        projects: ['alpha'],
      },
    });
    assert.equal(pidResponse.statusCode, 400);
    assert.deepEqual(pidResponse.body, {
      ok: false,
      error: 'PID-based session names are not allowed',
    });

    const invalidResponse = await httpRequest(hub.port, {
      method: 'POST',
      path: '/registry/register',
      json: {
        name: 'AB_C',
        role: 'worker',
        projects: ['alpha'],
      },
    });
    assert.equal(invalidResponse.statusCode, 400);
    assert.deepEqual(invalidResponse.body, {
      ok: false,
      error: 'session name must match [a-z0-9_-]+',
    });
  } finally {
    await stopHub(hub);
  }
});

test('GET /sessions: returns startupSource, startedAt, and label', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'naming-sessions' });
  const sessionName = uniqueName('metadata');
  const startedAt = Date.now() - 1000;
  const ws = await connectSession(hub.port, sessionName, {
    register: {
      startupSource: 'explicit-env',
      startedAt,
      label: 'Metadata Worker',
    },
  });

  try {
    const response = await httpRequest(hub.port, { method: 'GET', path: '/sessions' });
    assert.equal(response.statusCode, 200);
    const session = response.body.find((item) => item.name === sessionName);
    assert.ok(session, JSON.stringify(response.body));
    assert.equal(session.startupSource, 'explicit-env');
    assert.equal(session.startedAt, startedAt);
    assert.equal(session.label, 'Metadata Worker');
  } finally {
    await closeWebSocket(ws);
    await stopHub(hub);
  }
});

test('routeMessage: canonicalizes WS sender name and preserves from_pid/from_name in replay and recent backlog', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'naming-from' });
  const senderName = uniqueName('test1');
  const targetName = uniqueName('audit-target');
  const senderPid = 137736;
  const msgId = uniqueName('msg');
  let sender = null;
  let target = null;

  try {
    sender = await connectSession(hub.port, senderName, {
      register: { pid: senderPid },
    });

    sender.send(
      JSON.stringify({
        id: msgId,
        type: 'message',
        from: `session-${senderPid}`,
        to: targetName,
        content: 'audit-trail-body',
        contentType: 'text',
        topic: null,
        ts: Date.now(),
      }),
    );

    target = await connectSession(hub.port, targetName);
    const inbox = await waitForWebSocketMessage(
      target,
      (message) => message.type === 'inbox' && message.messages.some((item) => item.id === msgId),
    );
    const replayed = inbox.messages.find((item) => item.id === msgId);

    assert.equal(replayed.from, senderName);
    assert.equal(replayed.from_name, senderName);
    assert.equal(replayed.from_pid, senderPid);

    const recent = await httpRequest(hub.port, {
      method: 'GET',
      path: `/recent-messages?name=${encodeURIComponent(targetName)}&limit=10`,
    });
    const row = recent.body.messages.find((item) => item.id === msgId);
    assert.ok(row, JSON.stringify(recent.body));
    assert.equal(row.from, senderName);
    assert.equal(row.from_name, senderName);
    assert.equal(row.from_pid, senderPid);
  } finally {
    await closeWebSocket(target);
    await closeWebSocket(sender);
    await stopHub(hub);
  }
});

test('same-name codex duplicate is rejected and routing stays on the original session', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'naming-same-codex' });
  const sessionName = uniqueName('codex-same');
  const senderName = uniqueName('codex-sender');
  let original = null;
  let sender = null;

  try {
    original = await connectSession(hub.port, sessionName, {
      register: { runtime: 'codex', pid: 11111 },
    });

    const duplicate = new WebSocket(buildSessionUrl(hub.port, sessionName));
    const duplicateClose = await waitForClose(duplicate);
    assert.equal(duplicateClose.code, 4001);
    assert.equal(duplicateClose.reason, 'name taken');

    sender = await connectSession(hub.port, senderName);
    sender.send(
      JSON.stringify({
        id: uniqueName('same-route'),
        type: 'message',
        from: senderName,
        to: sessionName,
        content: 'route-to-original',
        ts: Date.now(),
      }),
    );

    const delivered = await waitForWebSocketMessage(
      original,
      (message) => message.type === 'message' && message.content === 'route-to-original',
    );
    assert.equal(delivered.to, sessionName);
    assert.equal(delivered.from, senderName);
  } finally {
    await closeWebSocket(sender);
    await closeWebSocket(original);
    await stopHub(hub);
  }
});
