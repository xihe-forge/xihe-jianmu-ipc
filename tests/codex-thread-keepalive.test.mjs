import { EventEmitter } from 'node:events';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createThreadKeepalive } from '../lib/codex-thread-keepalive.mjs';

const DEFAULT_INTERVAL_MS = 25 * 60 * 1000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createMockClient({ threadRead, threadStatus } = {}) {
  const emitter = new EventEmitter();
  const calls = [];
  const client = {
    on(eventName, handler) {
      emitter.on(eventName, handler);
      return client;
    },
    off(eventName, handler) {
      emitter.off(eventName, handler);
      return client;
    },
    emitNotification(message) {
      emitter.emit('notification', message);
    },
  };
  if (threadRead !== false) {
    client.threadRead = async (threadId) => {
      calls.push({ method: 'threadRead', threadId });
      if (threadRead) return await threadRead(threadId);
      return { thread: { id: threadId, status: { type: 'idle' } } };
    };
  }
  if (threadStatus) {
    client.threadStatus = (threadId) => {
      calls.push({ method: 'threadStatus', threadId });
      return threadStatus(threadId);
    };
  }
  return { client, calls };
}

describe('codex thread keepalive', () => {
  test('start() schedules a timer and exposes the default 25m interval', () => {
    const { client } = createMockClient();
    const keepalive = createThreadKeepalive({ client, threadId: 't1', sessionName: 's1' });

    assert.equal(keepalive.intervalMs, DEFAULT_INTERVAL_MS);
    assert.equal(keepalive.start(), keepalive);
    assert.equal(keepalive.isAlive(), true);

    keepalive.stop();
  });

  test('stop() clears the timer', () => {
    const { client } = createMockClient();
    const keepalive = createThreadKeepalive({
      client,
      threadId: 't1',
      sessionName: 's1',
      intervalMs: 100,
    });

    keepalive.start();
    const result = keepalive.stop();

    assert.equal(result.stopped, true);
    assert.equal(keepalive.isAlive(), false);
  });

  test('interval ping calls client.threadRead(threadId)', async () => {
    const { client, calls } = createMockClient();
    const keepalive = createThreadKeepalive({
      client,
      threadId: 't-read',
      sessionName: 's-read',
      intervalMs: 20,
    });

    keepalive.start();
    await delay(45);

    assert.equal(calls.filter((call) => call.method === 'threadRead').length, 1);
    assert.equal(calls[0].threadId, 't-read');
    keepalive.stop();
  });

  test('threadRead error emits closed and auto-stops', async () => {
    const { client } = createMockClient({
      threadRead: async () => {
        throw new Error('thread not found');
      },
    });
    const keepalive = createThreadKeepalive({
      client,
      threadId: 't-gone',
      sessionName: 's-gone',
      intervalMs: 20,
    });
    const closed = new Promise((resolve) => keepalive.once('closed', resolve));

    keepalive.start();
    const event = await closed;

    assert.equal(event.threadId, 't-gone');
    assert.equal(event.reason, 'ping-error');
    assert.equal(keepalive.isAlive(), false);
  });

  test('thread/closed notification auto-stops matching thread', async () => {
    const { client } = createMockClient();
    const keepalive = createThreadKeepalive({
      client,
      threadId: 't-close',
      sessionName: 's-close',
      intervalMs: 100,
    });
    const closed = new Promise((resolve) => keepalive.once('closed', resolve));

    keepalive.start();
    client.emitNotification({ method: 'thread/closed', params: { threadId: 't-close' } });
    const event = await closed;

    assert.equal(event.reason, 'notification');
    assert.equal(keepalive.isAlive(), false);
  });

  test('missing threadRead falls back to threadStatus with a short test interval', async () => {
    const { client, calls } = createMockClient({
      threadRead: false,
      threadStatus: (threadId) => ({ threadId, status: { type: 'idle' }, activeTurnId: null }),
    });
    const keepalive = createThreadKeepalive({
      client,
      threadId: 't-status',
      sessionName: 's-status',
      intervalMs: 20,
    });

    keepalive.start();
    await delay(45);

    assert.equal(calls.filter((call) => call.method === 'threadStatus').length, 1);
    assert.equal(keepalive.isAlive(), true);
    keepalive.stop();
  });
});
