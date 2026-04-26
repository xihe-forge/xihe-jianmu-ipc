import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  probeAnthropic,
  probeCliProxy,
  probeDns,
  probeHub,
} from '../lib/network-probes.mjs';

function createClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
      return current;
    },
  };
}

function createPendingRunner({ clock, advanceAfterMs, advanceByMs }) {
  return () => new Promise(() => {
    setTimeout(() => {
      clock.advance(advanceByMs);
    }, advanceAfterMs);
  });
}

function createNetworkError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

test('probeCliProxy: healthz 200 响应视为可达并记录耗时', async () => {
  const clock = createClock(100);
  const calls = [];
  const result = await probeCliProxy({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      clock.advance(25);
      return { status: 200 };
    },
    now: clock.now,
  });

  assert.deepEqual(result, { ok: true, latencyMs: 25 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:8317/healthz');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers, undefined);
  assert.equal(calls[0].options.body, undefined);
});

test('probeCliProxy: healthz 503 返回失败', async () => {
  const clock = createClock(20);
  const result = await probeCliProxy({
    fetchImpl: async () => {
      clock.advance(8);
      return { status: 503 };
    },
    now: clock.now,
  });

  assert.deepEqual(result, {
    ok: false,
    latencyMs: 8,
    error: 'HTTP 503',
  });
});

test('probeCliProxy: fetch 抛错返回失败', async () => {
  const clock = createClock(30);
  const result = await probeCliProxy({
    fetchImpl: async () => {
      clock.advance(5);
      throw new Error('fetch failed');
    },
    now: clock.now,
  });

  assert.deepEqual(result, {
    ok: false,
    latencyMs: 5,
    error: 'fetch failed',
  });
});

test('probeCliProxy: 超时返回失败且记录耗时', async () => {
  const clock = createClock(0);
  const timeoutMs = 30;
  const result = await probeCliProxy({
    timeoutMs,
    fetchImpl: createPendingRunner({
      clock,
      advanceAfterMs: 20,
      advanceByMs: timeoutMs + 1,
    }),
    now: clock.now,
  });

  assert.equal(result.ok, false);
  assert.equal(result.latencyMs, timeoutMs + 1);
  assert.match(result.error, /ETIMEDOUT|timeout/i);
});

test('probeCliProxy: 网络错误返回失败', async () => {
  const clock = createClock(10);
  const result = await probeCliProxy({
    fetchImpl: async () => {
      clock.advance(7);
      throw createNetworkError('ECONNREFUSED', 'connect refused');
    },
    now: clock.now,
  });

  assert.deepEqual(result, {
    ok: false,
    latencyMs: 7,
    error: 'ECONNREFUSED: connect refused',
  });
});

test('probeHub: 200 响应视为成功并尊重端口参数', async () => {
  const clock = createClock(200);
  const calls = [];
  const result = await probeHub({
    port: 43179,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      clock.advance(12);
      return { status: 200 };
    },
    now: clock.now,
  });

  assert.deepEqual(result, { ok: true, latencyMs: 12 });
  assert.equal(calls[0].url, 'http://127.0.0.1:43179/health');
  assert.equal(calls[0].options.method, 'GET');
});

test('probeHub: 超时返回失败且记录耗时', async () => {
  const clock = createClock(0);
  const timeoutMs = 25;
  const result = await probeHub({
    timeoutMs,
    fetchImpl: createPendingRunner({
      clock,
      advanceAfterMs: 15,
      advanceByMs: timeoutMs + 1,
    }),
    now: clock.now,
  });

  assert.equal(result.ok, false);
  assert.equal(result.latencyMs, timeoutMs + 1);
  assert.match(result.error, /ETIMEDOUT|timeout/i);
});

test('probeHub: 非 200 响应视为失败', async () => {
  const clock = createClock(50);
  const result = await probeHub({
    fetchImpl: async () => {
      clock.advance(9);
      return { status: 503 };
    },
    now: clock.now,
  });

  assert.deepEqual(result, {
    ok: false,
    latencyMs: 9,
    error: 'HTTP 503',
  });
});

test('probeAnthropic: 无鉴权 401 视为可达', async () => {
  const clock = createClock(300);
  const calls = [];
  const result = await probeAnthropic({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      clock.advance(18);
      return { status: 401 };
    },
    now: clock.now,
  });

  assert.deepEqual(result, { ok: true, latencyMs: 18 });
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].options.method, 'GET');
});

test('probeAnthropic: 超时返回失败且记录耗时', async () => {
  const clock = createClock(0);
  const timeoutMs = 35;
  const result = await probeAnthropic({
    timeoutMs,
    fetchImpl: createPendingRunner({
      clock,
      advanceAfterMs: 20,
      advanceByMs: timeoutMs + 1,
    }),
    now: clock.now,
  });

  assert.equal(result.ok, false);
  assert.equal(result.latencyMs, timeoutMs + 1);
  assert.match(result.error, /ETIMEDOUT|timeout/i);
});

test('probeAnthropic: 5xx 响应视为失败', async () => {
  const clock = createClock(80);
  const result = await probeAnthropic({
    fetchImpl: async () => {
      clock.advance(14);
      return { status: 502 };
    },
    now: clock.now,
  });

  assert.deepEqual(result, {
    ok: false,
    latencyMs: 14,
    error: 'HTTP 502',
  });
});

test('probeDns: resolve 成功视为成功并记录 host', async () => {
  const clock = createClock(500);
  const hosts = [];
  const result = await probeDns({
    host: 'example.com',
    resolveImpl: async (host) => {
      hosts.push(host);
      clock.advance(11);
      return ['93.184.216.34'];
    },
    now: clock.now,
  });

  assert.deepEqual(result, { ok: true, latencyMs: 11 });
  assert.deepEqual(hosts, ['example.com']);
});

test('probeDns: 超时返回失败且记录耗时', async () => {
  const clock = createClock(0);
  const timeoutMs = 20;
  const result = await probeDns({
    timeoutMs,
    resolveImpl: createPendingRunner({
      clock,
      advanceAfterMs: 10,
      advanceByMs: timeoutMs + 1,
    }),
    now: clock.now,
  });

  assert.equal(result.ok, false);
  assert.equal(result.latencyMs, timeoutMs + 1);
  assert.match(result.error, /ETIMEDOUT|timeout/i);
});

test('probeDns: resolve 失败返回错误信息', async () => {
  const clock = createClock(40);
  const result = await probeDns({
    resolveImpl: async () => {
      clock.advance(6);
      throw createNetworkError('ENOTFOUND', 'getaddrinfo ENOTFOUND github.com');
    },
    now: clock.now,
  });

  assert.deepEqual(result, {
    ok: false,
    latencyMs: 6,
    error: 'ENOTFOUND: getaddrinfo ENOTFOUND github.com',
  });
});
