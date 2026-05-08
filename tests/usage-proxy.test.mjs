import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createUsageProxy, startUsageProxyPrewarm } from '../lib/usage-proxy.mjs';

afterEach(() => {
  try {
    mock.timers.reset();
  } catch {}
});

async function withCredentials(fn) {
  const home = join(tmpdir(), `jianmu-usage-proxy-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const claudeDir = join(home, '.claude');
  await mkdir(claudeDir, { recursive: true });
  await writeFile(
    join(claudeDir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'test-access-token' } }),
    'utf8',
  );

  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('usage proxy caches successful responses for five minutes', async () => {
  await withCredentials(async (home) => {
    let currentNow = Date.parse('2026-05-05T00:00:00.000Z');
    let calls = 0;
    const proxy = createUsageProxy({
      homeDir: () => home,
      now: () => currentNow,
      fetchImpl: async (url, options) => {
        calls += 1;
        assert.equal(url, 'https://api.anthropic.com/api/oauth/usage');
        assert.equal(options.headers.Authorization, 'Bearer test-access-token');
        assert.equal(options.headers['anthropic-beta'], 'oauth-2025-04-20');
        assert.equal(options.headers['User-Agent'], 'jianmu-ipc-usage-proxy/1.0');
        return {
          ok: true,
          json: async () => ({
            five_hour: { utilization: 12.4, resets_at: '2026-05-05T05:00:00Z' },
            seven_day: { utilization: 34.6, resets_at: '2026-05-12T00:00:00Z' },
          }),
        };
      },
    });

    const first = await proxy.getUsage();
    currentNow += 60_000;
    const second = await proxy.getUsage();

    assert.equal(calls, 1);
    assert.equal(first.source, 'jianmu-fresh');
    assert.equal(second.source, 'jianmu-cache');
    assert.equal(second.five_hour.utilization, 12.4);
  });
});

test('usage proxy shares one in-flight anthropic request across 19 concurrent callers', async () => {
  await withCredentials(async (home) => {
    let calls = 0;
    let markFetchEntered;
    let releaseFetch;
    const fetchEntered = new Promise((resolve) => {
      markFetchEntered = resolve;
    });
    const fetchReleased = new Promise((resolve) => {
      releaseFetch = resolve;
    });
    const proxy = createUsageProxy({
      homeDir: () => home,
      fetchImpl: async () => {
        calls += 1;
        markFetchEntered();
        await fetchReleased;
        return {
          ok: true,
          json: async () => ({
            five_hour: { utilization: 20, resets_at: '2026-05-05T05:00:00Z' },
            seven_day: { utilization: 40, resets_at: '2026-05-12T00:00:00Z' },
          }),
        };
      },
    });

    const requests = Array.from({ length: 19 }, () => proxy.getUsage());
    await fetchEntered;
    assert.equal(calls, 1);

    releaseFetch();
    const results = await Promise.all(requests);

    assert.equal(calls, 1);
    assert.equal(results.length, 19);
    assert.ok(results.every((result) => result.ok === true));
  });
});

test('usage proxy caches failures for thirty seconds to avoid retry storms', async () => {
  await withCredentials(async (home) => {
    let currentNow = Date.parse('2026-05-05T00:00:00.000Z');
    let calls = 0;
    const proxy = createUsageProxy({
      homeDir: () => home,
      now: () => currentNow,
      fetchImpl: async () => {
        calls += 1;
        return { ok: false, status: 429 };
      },
    });

    const first = await proxy.getUsage();
    currentNow += 10_000;
    const second = await proxy.getUsage();
    currentNow += 21_000;
    const third = await proxy.getUsage();

    assert.equal(first.ok, false);
    assert.equal(second.ok, false);
    assert.equal(third.ok, false);
    assert.equal(first.error, 'http-429');
    assert.equal(calls, 2);
  });
});

test('usage proxy prewarm calls getUsage immediately and once per interval', () => {
  const startedAt = Date.parse('2026-05-05T00:00:00.000Z');
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: startedAt });

  const calls = [];
  const handle = startUsageProxyPrewarm(1_000, {
    getUsage: () => {
      calls.push(Date.now());
    },
  });

  assert.deepEqual(calls, [startedAt]);
  mock.timers.tick(1_000);
  assert.deepEqual(calls, [startedAt, startedAt + 1_000]);

  handle.stop();
});

test('usage proxy prewarm stop clears interval', () => {
  mock.timers.enable({ apis: ['setInterval'] });

  let calls = 0;
  const handle = startUsageProxyPrewarm(1_000, {
    getUsage: () => {
      calls += 1;
    },
  });

  assert.equal(calls, 1);
  handle.stop();
  mock.timers.tick(3_000);
  assert.equal(calls, 1);
});

test('usage proxy prewarm swallows getUsage errors', async () => {
  mock.timers.enable({ apis: ['setInterval'] });

  let calls = 0;
  let handle;
  assert.doesNotThrow(() => {
    handle = startUsageProxyPrewarm(1_000, {
      getUsage: async () => {
        calls += 1;
        throw new Error('usage unavailable');
      },
    });
  });

  await Promise.resolve();
  mock.timers.tick(1_000);
  await Promise.resolve();

  assert.equal(calls, 2);
  handle.stop();
});
