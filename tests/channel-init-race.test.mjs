import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChannelNotifier } from '../lib/channel-notification.mjs';

function createHarness() {
  const sent = [];
  const stderr = [];
  const notifier = createChannelNotifier({
    serverNotify: (payload) => {
      sent.push(payload);
      return Promise.resolve();
    },
    stderr: (message) => stderr.push(message),
    now: () => new Date('2026-04-24T10:20:30+08:00'),
  });
  return { notifier, sent, stderr };
}

test('pre-init channel notifications are queued without sending', () => {
  const { notifier, sent } = createHarness();

  notifier.pushChannelNotification({ id: 'm1', from: 'taiwei', topic: 'ops', content: 'one' });
  notifier.pushChannelNotification({ id: 'm2', from: 'pc-pet', topic: 'ops', content: 'two' });
  notifier.pushChannelNotification({ id: 'm3', from: 'jianmu-pm', content: 'three' });

  assert.equal(notifier._state.mcpInitialized, false);
  assert.equal(notifier._state.pendingChannelPayloads.length, 3);
  assert.equal(sent.length, 0);
});

test('markInitialized flushes queued notifications in order', () => {
  const { notifier, sent } = createHarness();

  notifier.pushChannelNotification({ id: 'm1', from: 'taiwei', content: 'one' });
  notifier.pushChannelNotification({ id: 'm2', from: 'pc-pet', content: 'two' });
  notifier.pushChannelNotification({ id: 'm3', from: 'jianmu-pm', content: 'three' });
  notifier.markInitialized();

  assert.equal(notifier._state.mcpInitialized, true);
  assert.equal(notifier._state.pendingChannelPayloads.length, 0);
  assert.deepEqual(sent.map((payload) => payload.params.meta.message_id), ['m1', 'm2', 'm3']);
});

test('post-init channel notifications send immediately', () => {
  const { notifier, sent } = createHarness();

  notifier.markInitialized();
  notifier.pushChannelNotification({ id: 'm4', from: 'taiwei', content: 'after init' });

  assert.equal(notifier._state.pendingChannelPayloads.length, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].params.meta.message_id, 'm4');
});

test('channel notification payload preserves content and metadata shape', () => {
  const { notifier } = createHarness();

  notifier.pushChannelNotification({ id: 'm5', from: 'taiwei', topic: 'race', content: 'hello' });
  const payload = notifier._state.pendingChannelPayloads[0];

  assert.equal(payload.method, 'notifications/claude/channel');
  assert.match(payload.params.content, /^\[2026\/4\/24 10:20:30 from: taiwei \[race\]\]\nhello$/);
  assert.deepEqual(payload.params.meta, {
    from: 'taiwei',
    message_id: 'm5',
    topic: 'race',
  });
});

test('channel notification defaults unknown sender and json body', () => {
  const { notifier } = createHarness();

  notifier.pushChannelNotification({ id: 'm6', ok: true });
  const payload = notifier._state.pendingChannelPayloads[0];

  assert.match(payload.params.content, /^\[2026\/4\/24 10:20:30 from: unknown\]\n/);
  assert.equal(payload.params.content.endsWith('{"id":"m6","ok":true}'), true);
  assert.deepEqual(payload.params.meta, {
    from: 'unknown',
    message_id: 'm6',
    topic: '',
  });
});
