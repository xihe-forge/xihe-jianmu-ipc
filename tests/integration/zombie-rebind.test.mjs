import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import {
  TEST_TIMEOUT,
  buildSessionUrl,
  closeWebSocket,
  connectSession,
  httpRequest,
  readAuditEntries,
  startHub,
  stopHub,
  waitForClose,
  waitForPingCount,
  waitForWebSocketMessage,
} from '../helpers/hub-fixture.mjs';

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

test('zombie rebind: existing ws isAlive=false 时新连接接管并终止旧连接', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({
    prefix: 'zombie-rebind-zombie',
    heartbeatIntervalMs: 150,
    heartbeatTimeoutMs: 450,
  });
  const sessionName = uniqueName('zombie');
  const auditStart = readAuditEntries().length;
  const original = await connectSession(hub.port, sessionName, { autoPong: false });

  try {
    await waitForPingCount(original, 1, 2_000);
    const originalClose = waitForClose(original, 2_000);
    const replacement = await connectSession(hub.port, sessionName);

    try {
      const closeEvent = await originalClose;
      assert.equal(closeEvent.code, 1006);

      await httpRequest(hub.port, {
        method: 'POST',
        path: '/send',
        json: { from: uniqueName('sender'), to: sessionName, content: 'after-zombie-rebind' },
      });
      const delivered = await waitForWebSocketMessage(
        replacement,
        (message) => message.type === 'message' && message.content === 'after-zombie-rebind',
      );
      assert.equal(delivered.to, sessionName);

      const audits = readAuditEntries()
        .slice(auditStart)
        .filter((entry) => entry.event === 'zombie_rebind' && entry.name === sessionName);
      assert.equal(audits.length, 1);
    } finally {
      await closeWebSocket(replacement);
    }
  } finally {
    await stopHub(hub);
  }
});

test('zombie rebind: existing ws 正常存活时同名新连接仍返回 4001', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'zombie-rebind-name-taken' });
  const sessionName = uniqueName('name-taken');
  const original = await connectSession(hub.port, sessionName);

  try {
    const duplicate = new WebSocket(buildSessionUrl(hub.port, sessionName));
    try {
      const closeEvent = await waitForClose(duplicate);
      assert.equal(closeEvent.code, 4001);
      assert.equal(closeEvent.reason, 'name taken');

      await httpRequest(hub.port, {
        method: 'POST',
        path: '/send',
        json: { from: uniqueName('sender'), to: sessionName, content: 'still-owned-by-original' },
      });
      const delivered = await waitForWebSocketMessage(
        original,
        (message) => message.type === 'message' && message.content === 'still-owned-by-original',
      );
      assert.equal(delivered.to, sessionName);
    } finally {
      await closeWebSocket(duplicate);
    }
  } finally {
    await closeWebSocket(original);
    await stopHub(hub);
  }
});

test('zombie rebind: force=1 时旧连接被终止，新连接接管并记录 audit', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'zombie-rebind-force' });
  const sessionName = uniqueName('force');
  const auditStart = readAuditEntries().length;
  const original = await connectSession(hub.port, sessionName);

  try {
    const originalClose = waitForClose(original, 2_000);
    const replacement = await connectSession(hub.port, sessionName, { force: true });

    try {
      const closeEvent = await originalClose;
      assert.equal(closeEvent.code, 1006);

      await httpRequest(hub.port, {
        method: 'POST',
        path: '/send',
        json: { from: uniqueName('sender'), to: sessionName, content: 'after-force-rebind' },
      });
      const delivered = await waitForWebSocketMessage(
        replacement,
        (message) => message.type === 'message' && message.content === 'after-force-rebind',
      );
      assert.equal(delivered.to, sessionName);

      const audits = readAuditEntries()
        .slice(auditStart)
        .filter((entry) => entry.event === 'force_rebind' && entry.name === sessionName);
      assert.equal(audits.length, 1);
    } finally {
      await closeWebSocket(replacement);
    }
  } finally {
    await stopHub(hub);
  }
});
