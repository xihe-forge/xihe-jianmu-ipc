import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TEST_TIMEOUT,
  closeWebSocket,
  connectSession,
  readAuditEntries,
  startHub,
  stopHub,
  waitForWebSocketMessage,
  sleep,
} from '../helpers/hub-fixture.mjs';

function unique(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

async function waitForAudit(predicate, startIndex, timeout = 3_000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const entry = readAuditEntries().slice(startIndex).find(predicate);
    if (entry) return entry;
    await sleep(25);
  }

  throw new Error('waiting for audit entry timed out');
}

test('hub ack: records ack_received with original sender and confirmer', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'hub-ack-received' });
  const senderName = unique('ack-sender');
  const receiverName = unique('ack-receiver');
  const messageId = `msg_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const auditStart = readAuditEntries().length;
  const sender = await connectSession(hub.port, senderName);
  const receiver = await connectSession(hub.port, receiverName);

  try {
    const deliveredPromise = waitForWebSocketMessage(
      receiver,
      (message) => message.type === 'message' && message.id === messageId,
    );
    sender.send(JSON.stringify({
      id: messageId,
      type: 'message',
      from: senderName,
      to: receiverName,
      content: 'ack audit test',
    }));

    const delivered = await deliveredPromise;
    assert.equal(delivered.from, senderName);

    const ackNotifyPromise = waitForWebSocketMessage(
      sender,
      (message) => message.type === 'ack' && message.messageId === messageId,
    );
    receiver.send(JSON.stringify({ type: 'ack', messageId }));

    const ackNotify = await ackNotifyPromise;
    assert.equal(ackNotify.confirmedBy, receiverName);

    const ackAudit = await waitForAudit(
      (entry) => entry.event === 'ack_received' && entry.message_id === messageId,
      auditStart,
    );
    assert.equal(ackAudit.confirmed_by, receiverName);
    assert.equal(ackAudit.original_sender, senderName);
    assert.equal(typeof ackAudit.rtt_ms, 'number');
    assert.ok(ackAudit.rtt_ms >= 0);
  } finally {
    await closeWebSocket(receiver);
    await closeWebSocket(sender);
    await stopHub(hub);
  }
});

test('hub ack: records ack_received when pending entry is missing', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'hub-ack-missing-pending' });
  const confirmerName = unique('ack-confirmer');
  const messageId = `missing_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const auditStart = readAuditEntries().length;
  const confirmer = await connectSession(hub.port, confirmerName);

  try {
    confirmer.send(JSON.stringify({ type: 'ack', messageId }));

    const ackAudit = await waitForAudit(
      (entry) => entry.event === 'ack_received' && entry.message_id === messageId,
      auditStart,
    );
    assert.equal(ackAudit.confirmed_by, confirmerName);
    assert.equal(ackAudit.original_sender, null);
    assert.equal(ackAudit.rtt_ms, null);
  } finally {
    await closeWebSocket(confirmer);
    await stopHub(hub);
  }
});
