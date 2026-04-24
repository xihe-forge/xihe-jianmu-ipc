import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChannelNotifier } from '../lib/channel-notification.mjs';

function createHarness(options = {}) {
  const sent = [];
  const stderr = [];
  const traces = [];
  const notifier = createChannelNotifier({
    serverNotify: options.serverNotify ?? ((payload) => {
      sent.push(payload);
      return Promise.resolve();
    }),
    stderr: (message) => stderr.push(message),
    now: () => new Date('2026-04-24T10:20:30+08:00'),
    trace: (event, detail) => traces.push({ event, detail }),
  });
  return { notifier, sent, stderr, traces };
}

async function flushPromises() {
  await new Promise((resolve) => setImmediate(resolve));
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

test('isInitialized exposes factory init state', () => {
  const { notifier } = createHarness();

  assert.equal(notifier.isInitialized(), false);
  notifier.markInitialized();
  assert.equal(notifier.isInitialized(), true);
});

test('trace captures queued flush and send attempts', async () => {
  const { notifier, traces } = createHarness();

  notifier.pushChannelNotification({ id: 'm1', from: 'taiwei', content: 'one' });
  notifier.pushChannelNotification({ id: 'm2', from: 'pc-pet', content: 'two' });
  notifier.markInitialized();
  await flushPromises();

  assert.deepEqual(traces.map((entry) => entry.event), [
    'mcp_initialized_flush_begin',
    'channel_notification_flushed',
    'channel_notification_send_attempt',
    'channel_notification_flushed',
    'channel_notification_send_attempt',
    'channel_notification_send_ok',
    'channel_notification_send_ok',
  ]);
  assert.deepEqual(
    traces.filter((entry) => entry.event === 'channel_notification_flushed').map((entry) => entry.detail.msg_id),
    ['m1', 'm2'],
  );
  assert.equal(traces[0].detail.queued_count, 2);
});

test('trace captures send success path', async () => {
  const { notifier, traces } = createHarness();

  notifier.markInitialized();
  notifier.pushChannelNotification({ id: 'm7', from: 'taiwei', content: 'ok' });
  await flushPromises();

  assert.equal(traces.at(-2).event, 'channel_notification_send_attempt');
  assert.equal(traces.at(-2).detail.msg_id, 'm7');
  assert.equal(traces.at(-2).detail.method, 'notifications/claude/channel');
  assert.equal(traces.at(-1).event, 'channel_notification_send_ok');
});

test('trace captures send failure path', async () => {
  const { notifier, stderr, traces } = createHarness({
    serverNotify: () => Promise.reject(new Error('boom')),
  });

  notifier.markInitialized();
  notifier.pushChannelNotification({ id: 'm8', from: 'taiwei', content: 'fail' });
  await flushPromises();

  assert.equal(traces.at(-2).event, 'channel_notification_send_attempt');
  assert.equal(traces.at(-1).event, 'channel_notification_send_fail');
  assert.equal(traces.at(-1).detail.msg_id, 'm8');
  assert.equal(traces.at(-1).detail.err_message, 'boom');
  assert.match(stderr.at(-1), /failed to push channel notification: boom/);
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
