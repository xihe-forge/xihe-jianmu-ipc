import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InvalidInjectItemSchemaError,
  createAppServerClient,
  formatInjectItem,
} from '../lib/codex-app-server-client.mjs';

function createMockChild(handler) {
  const child = new EventEmitter();
  const requests = [];
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = {
    write(data) {
      const request = JSON.parse(String(data).trim());
      requests.push(request);
      const responses = handler(request, requests.length);
      for (const response of Array.isArray(responses) ? responses : [responses]) {
        if (response) child.stdout.write(`${JSON.stringify(response)}\n`);
      }
      return true;
    },
    end() {},
  };
  child.kill = () => {
    child.emit('exit', 0, null);
  };
  return { child, requests };
}

function createClient(handler, options = {}) {
  const { child, requests } = createMockChild(handler);
  const traces = [];
  const client = createAppServerClient({
    child,
    retryDelaysMs: [0, 0, 0],
    requestTimeoutMs: 1000,
    trace: (line) => traces.push(line),
    ...options,
  });
  return { client, requests, child, traces };
}

describe('codex App Server JSON-RPC client', () => {
  test('initialize handshake uses id=0 and clientInfo.name', async () => {
    const { client, requests } = createClient((request) => ({
      id: request.id,
      result: { codexHome: 'C:/Users/test/.codex' },
    }));

    await client.initialize({ clientInfo: { name: 'xihe-ipc-test', version: '0.1.0' } });

    assert.equal(requests[0].id, 0);
    assert.equal(requests[0].method, 'initialize');
    assert.equal(requests[0].params.clientInfo.name, 'xihe-ipc-test');
  });

  test('threadStart returns threadId from thread/start response', async () => {
    const { client, requests } = createClient((request) => ({
      id: request.id,
      result: { thread: { id: 'thread-1', status: { type: 'idle' } } },
    }));

    const result = await client.threadStart({ cwd: 'D:/workspace/project' });

    assert.equal(requests[0].method, 'thread/start');
    assert.equal(result.threadId, 'thread-1');
  });

  test('turnStart and turnSteer send expectedTurnId', async () => {
    const { client, requests } = createClient((request) => {
      if (request.method === 'turn/start') {
        return { id: request.id, result: { turn: { id: 'turn-1' } } };
      }
      return { id: request.id, result: { turnId: request.params.expectedTurnId } };
    });

    const started = await client.turnStart('thread-1', 'start marker');
    await client.turnSteer('thread-1', started.turnId, 'steer marker');

    assert.equal(requests[0].method, 'turn/start');
    assert.equal(requests[1].method, 'turn/steer');
    assert.equal(requests[1].params.threadId, 'thread-1');
    assert.equal(requests[1].params.expectedTurnId, 'turn-1');
  });

  test('threadInjectItems sends schema 4 item payload and traces full request', async () => {
    const { client, requests, traces } = createClient((request) => ({ id: request.id, result: {} }));
    const item = formatInjectItem('[IPC-INJECT] hello');

    await client.threadInjectItems('thread-1', [item]);

    assert.equal(requests[0].method, 'thread/inject_items');
    assert.deepEqual(requests[0].params.items[0], {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '[IPC-INJECT] hello' }],
    });
    assert.ok(traces.some((line) => line.includes('"thread/inject_items"')));
    assert.ok(traces.some((line) => line.includes('[IPC-INJECT] hello')));
  });

  test('threadInjectItems rejects schema 1/2/3 before JSON-RPC send', async () => {
    const { client, requests } = createClient((request) => ({ id: request.id, result: {} }));
    const invalidItems = [
      { type: 'user_message', content: 'schema 1' },
      { type: 'user_message', content: [{ type: 'text', text: 'schema 2' }] },
      { role: 'user', content: 'schema 3' },
    ];

    for (const item of invalidItems) {
      await assert.rejects(
        () => client.threadInjectItems('thread-1', [item]),
        InvalidInjectItemSchemaError,
      );
    }

    assert.equal(requests.length, 0);
  });

  test('JSON-RPC error -32001 retries three times with exponential backoff', async () => {
    const { client, requests } = createClient((request, count) => {
      if (count < 4) {
        return { id: request.id, error: { code: -32001, message: 'backpressure' } };
      }
      return { id: request.id, result: { ok: true } };
    });

    const result = await client.threadInjectItems('thread-1', [formatInjectItem('retry marker')]);

    assert.deepEqual(result, { ok: true });
    assert.equal(requests.length, 4);
    assert.ok(requests.every((request) => request.id === requests[0].id));
  });

  test('notification handler receives turn and item notifications', async () => {
    const notifications = [];
    const { client, child } = createClient((request) => ({ id: request.id, result: {} }));
    client.on('notification', (message) => notifications.push(message.method));

    child.stdout.write(`${JSON.stringify({ method: 'turn/started', params: { threadId: 't', turn: { id: 'u' } } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 't', turnId: 'u', delta: 'hi' } })}\n`);
    child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'u' } } })}\n`);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(notifications, [
      'turn/started',
      'item/agentMessage/delta',
      'turn/completed',
    ]);
    assert.equal(client.threadStatus('t').activeTurnId, null);
  });
});
