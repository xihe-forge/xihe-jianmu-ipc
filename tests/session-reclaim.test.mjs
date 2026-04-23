import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSessionReclaimHandler } from '../lib/session-reclaim.mjs';

function createMockWs({ readyState = 1, autoPong = false } = {}) {
  const ws = new EventEmitter();
  ws.OPEN = 1;
  ws.CLOSING = 2;
  ws.CLOSED = 3;
  ws.readyState = readyState;
  ws.pingCalls = 0;
  ws.terminateCalls = 0;
  ws.ping = () => {
    ws.pingCalls += 1;
    if (autoPong) {
      queueMicrotask(() => ws.emit('pong'));
    }
  };
  ws.terminate = () => {
    ws.terminateCalls += 1;
    ws.readyState = ws.CLOSED;
  };
  return ws;
}

afterEach(() => {
  try {
    mock.timers.reset();
  } catch {}
});

test('createSessionReclaimHandler: name 为空返回 name required', async () => {
  const handler = createSessionReclaimHandler({ sessions: new Map() });

  assert.deepEqual(await handler({ name: '', remoteAddress: '127.0.0.1' }), {
    ok: false,
    reason: 'name required',
  });
});

test('createSessionReclaimHandler: 无占用者时返回 no-holder', async () => {
  const handler = createSessionReclaimHandler({ sessions: new Map() });

  assert.deepEqual(await handler({ name: 'worker-a', remoteAddress: '127.0.0.1' }), {
    ok: false,
    reason: 'no-holder',
  });
});

test('createSessionReclaimHandler: pending rebind 存在时拒绝 reclaim', async () => {
  const handler = createSessionReclaimHandler({
    sessions: new Map([
      [
        'worker-a',
        {
          name: 'worker-a',
          ws: createMockWs({ readyState: 2 }),
          connectedAt: 123,
        },
      ],
    ]),
    findPendingRebind: () => ({ name: 'worker-a' }),
  });

  assert.deepEqual(await handler({ name: 'worker-a', remoteAddress: '127.0.0.1' }), {
    ok: false,
    reason: 'pending-rebind-in-progress',
  });
});

test('createSessionReclaimHandler: 同名 10 秒内重复请求会 rate-limited', async () => {
  let currentTime = 10_000;
  const handler = createSessionReclaimHandler({
    sessions: new Map([
      [
        'worker-a',
        {
          name: 'worker-a',
          ws: createMockWs({ readyState: 2 }),
          connectedAt: 123,
        },
      ],
    ]),
    now: () => currentTime,
  });

  const first = await handler({ name: 'worker-a', remoteAddress: '127.0.0.1' });
  currentTime += 1_000;
  const second = await handler({ name: 'worker-a', remoteAddress: '127.0.0.1' });

  assert.equal(first.ok, true);
  assert.deepEqual(second, {
    ok: false,
    reason: 'rate-limited',
    retryAfterMs: 9_000,
  });
});

test('createSessionReclaimHandler: ws 非 OPEN 时直接 evict，不发 ping', async () => {
  const ws = createMockWs({ readyState: 2 });
  const handler = createSessionReclaimHandler({
    sessions: new Map([
      [
        'worker-a',
        {
          name: 'worker-a',
          ws,
          connectedAt: 456,
        },
      ],
    ]),
  });

  const result = await handler({ name: 'worker-a', remoteAddress: '127.0.0.1' });

  assert.deepEqual(result, {
    ok: true,
    evicted: true,
    previousConnectedAt: 456,
  });
  assert.equal(ws.pingCalls, 0);
  assert.equal(ws.terminateCalls, 1);
});

test('createSessionReclaimHandler: ws OPEN 且 5 秒内 pong 时返回 holder-alive', async () => {
  const ws = createMockWs({ readyState: 1, autoPong: true });
  const handler = createSessionReclaimHandler({
    sessions: new Map([
      [
        'worker-a',
        {
          name: 'worker-a',
          ws,
          connectedAt: 789,
        },
      ],
    ]),
    now: () => 42_424,
  });

  const result = await handler({ name: 'worker-a', remoteAddress: '127.0.0.1' });

  assert.deepEqual(result, {
    ok: false,
    reason: 'holder-alive',
    lastAliveAt: 42_424,
  });
  assert.equal(ws.pingCalls, 1);
  assert.equal(ws.terminateCalls, 0);
});

test('createSessionReclaimHandler: ws OPEN 且 5 秒无 pong 时 evict 并记录 reclaim_evict', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });

  const ws = createMockWs({ readyState: 1 });
  const audits = [];
  const handler = createSessionReclaimHandler({
    sessions: new Map([
      [
        'worker-a',
        {
          name: 'worker-a',
          ws,
          connectedAt: 999,
        },
      ],
    ]),
    audit: (event, payload) => audits.push({ event, payload }),
  });

  const resultPromise = handler({ name: 'worker-a', remoteAddress: '127.0.0.1' });
  await Promise.resolve();
  mock.timers.tick(5_000);
  await Promise.resolve();
  const result = await resultPromise;

  assert.deepEqual(result, {
    ok: true,
    evicted: true,
    previousConnectedAt: 999,
  });
  assert.equal(ws.pingCalls, 1);
  assert.equal(ws.terminateCalls, 1);
  assert.deepEqual(audits, [
    {
      event: 'reclaim_evict',
      payload: {
        name: 'worker-a',
        previousConnectedAt: 999,
        remoteAddress: '127.0.0.1',
      },
    },
  ]);
});
