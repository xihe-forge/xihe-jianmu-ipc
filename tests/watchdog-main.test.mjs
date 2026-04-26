import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWatchdogIpcClient,
  createNetworkWatchdog,
  WATCHDOG_RETRY_DELAYS_MS,
} from '../bin/network-watchdog.mjs';

const TEST_IPC_PORT = 43179;
const TEST_INTERNAL_EVENT_URL = `http://127.0.0.1:${TEST_IPC_PORT}/internal/network-event`;

function ok(latencyMs = 1) {
  return { ok: true, latencyMs };
}

function fail(error = 'unavailable', latencyMs = 1) {
  return { ok: false, latencyMs, error };
}

function createSequenceProbe(sequence) {
  let index = 0;
  return async () => {
    const current = sequence[Math.min(index, sequence.length - 1)];
    index += 1;
    return typeof current === 'function' ? current() : current;
  };
}

function createTickNow(start = 0, step = 1_000) {
  let current = start;
  return () => {
    current += step;
    return current;
  };
}

function createIpcClientStub() {
  return {
    async start() {},
    async stop() {},
    async sendMessage() {
      return true;
    },
  };
}

function createIsolatedWatchdog(options = {}) {
  return createNetworkWatchdog({
    ipcPort: TEST_IPC_PORT,
    internalToken: 'watchdog-token',
    createWatchdogIpcClientImpl: () => createIpcClientStub(),
    ...options,
  });
}

test('createNetworkWatchdog: 进入 down 时会 POST /internal/network-event', async () => {
  const capture = createFetchCapture();
  const watchdog = createIsolatedWatchdog({
    fetchImpl: capture.fetchImpl,
    probes: {
      cliProxy: async () => fail('HTTP 503'),
      hub: async () => fail('HTTP 503'),
      anthropic: async () => ok(),
      dns: async () => ok(),
    },
  });

  const state = await watchdog.runTick();
  await watchdog.waitForIdle();

  assert.equal(state.state, 'down');
  assert.equal(capture.requests.length, 1);
  assert.equal(capture.requests[0].method, 'POST');
  assert.equal(capture.requests[0].url, TEST_INTERNAL_EVENT_URL);
  assert.equal(capture.requests[0].headers['x-internal-token'], 'watchdog-token');
  assert.deepEqual(capture.requests[0].body, {
    event: 'network-down',
    failing: ['cliProxy', 'hub'],
    since: capture.requests[0].body.ts,
    triggeredBy: 'watchdog',
    ts: capture.requests[0].body.ts,
  });
});

test('createNetworkWatchdog: down 恢复到 OK 时会发送 network-up', async () => {
  const capture = createFetchCapture();
  const watchdog = createIsolatedWatchdog({
    fetchImpl: capture.fetchImpl,
    now: createTickNow(),
    probes: {
      cliProxy: createSequenceProbe([fail('HTTP 503'), ok(), ok(), ok()]),
      hub: createSequenceProbe([fail('HTTP 503'), ok(), ok(), ok()]),
      anthropic: createSequenceProbe([ok(), ok(), ok(), ok()]),
      dns: createSequenceProbe([ok(), ok(), ok(), ok()]),
    },
  });

  await watchdog.runTick();
  await watchdog.waitForIdle();
  await watchdog.runTick();
  await watchdog.waitForIdle();
  await watchdog.runTick();
  await watchdog.waitForIdle();
  const finalState = await watchdog.runTick();
  await watchdog.waitForIdle();

  assert.equal(finalState.state, 'OK');
  assert.equal(capture.requests.length, 2);
  assert.deepEqual(capture.requests[0].body, {
    event: 'network-down',
    failing: ['cliProxy', 'hub'],
    since: 2000,
    triggeredBy: 'watchdog',
    ts: 2000,
  });
  assert.deepEqual(capture.requests[1].body, {
    event: 'network-up',
    recoveredAfter: 3000,
    triggeredBy: 'watchdog',
    ts: 5000,
  });
});

test('createNetworkWatchdog: HTTP 首发加 3 次重试失败后记 stderr，后续 tick 仍继续', async () => {
  const logs = [];
  const delays = [];
  let fetchCount = 0;
  const watchdog = createIsolatedWatchdog({
    stderr: (line) => logs.push(line),
    now: createTickNow(),
    waitImpl: async (delayMs) => {
      delays.push(delayMs);
    },
    fetchImpl: async () => {
      fetchCount += 1;
      if (fetchCount <= WATCHDOG_RETRY_DELAYS_MS.length + 1) {
        throw new Error(`boom-${fetchCount}`);
      }
      return { status: 200 };
    },
    probes: {
      cliProxy: createSequenceProbe([fail('HTTP 503'), ok(), ok(), ok()]),
      hub: createSequenceProbe([fail('HTTP 503'), ok(), ok(), ok()]),
      anthropic: createSequenceProbe([ok(), ok(), ok(), ok()]),
      dns: createSequenceProbe([ok(), ok(), ok(), ok()]),
    },
  });

  await watchdog.runTick();
  await watchdog.waitForIdle();
  await watchdog.runTick();
  await watchdog.waitForIdle();
  await watchdog.runTick();
  await watchdog.waitForIdle();
  const finalState = await watchdog.runTick();
  await watchdog.waitForIdle();

  assert.equal(finalState.state, 'OK');
  assert.equal(fetchCount, WATCHDOG_RETRY_DELAYS_MS.length + 2);
  assert.deepEqual(delays, WATCHDOG_RETRY_DELAYS_MS);
  assert.ok(
    logs.some((line) => line.includes('failed to POST /internal/network-event after 4 attempt(s)')),
    '应记录重试耗尽后的 stderr',
  );
});

test('createWatchdogIpcClient: sendMessage 走 POST /send 并带上 from/topic', async () => {
  const capture = createFetchCapture();
  const client = createWatchdogIpcClient({
    ipcPort: TEST_IPC_PORT,
    sessionName: 'network-watchdog',
    hubAuthToken: 'watchdog-token',
    fetchImpl: capture.fetchImpl,
  });

  const accepted = await client.sendMessage({
    to: 'tech-worker',
    topic: 'run-check-sh',
    content: 'trigger check.sh',
  });

  assert.equal(accepted, true);
  assert.equal(capture.requests.length, 1);
  assert.equal(capture.requests[0].method, 'POST');
  assert.equal(capture.requests[0].url, `http://127.0.0.1:${TEST_IPC_PORT}/send`);
  assert.equal(capture.requests[0].headers.authorization, 'Bearer watchdog-token');
  assert.deepEqual(capture.requests[0].body, {
    from: 'network-watchdog',
    to: 'tech-worker',
    topic: 'run-check-sh',
    content: 'trigger check.sh',
  });
});

test('createNetworkWatchdog: handover tick 60s 内重复调用返回 tick-interval skip', async () => {
  const capture = createFetchCapture({
    [`http://127.0.0.1:${TEST_IPC_PORT}/sessions`]: [
      { name: 'jianmu-pm', contextUsagePct: 10 },
    ],
  });
  const clock = createManualNow(60_000);
  const watchdog = createIsolatedWatchdog({
    fetchImpl: capture.fetchImpl,
    now: clock.now,
    ipcSpawn: async () => ({ spawned: true }),
    handoverEnabled: true,
    handoverTickIntervalMs: 60_000,
    probes: {
      cliProxy: async () => ok(),
      hub: async () => ok(),
      anthropic: async () => ok(),
      dns: async () => ok(),
    },
  });

  await watchdog.runTick();
  await watchdog.runTick();

  assert.equal(capture.requests.filter((request) => request.url.endsWith('/sessions')).length, 1);
  assert.deepEqual(watchdog.getLastHandoverTickResult(), {
    detected: [],
    skipped: [{ reason: 'tick-interval' }],
  });

  clock.advance(60_000);
  await watchdog.runTick();

  assert.equal(capture.requests.filter((request) => request.url.endsWith('/sessions')).length, 2);
});

test('createNetworkWatchdog: handover tick reads transcript independent of Hub contextUsagePct', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-transcript-'));
  try {
    const transcriptPath = join(dir, 'session.jsonl');
    writeFileSync(transcriptPath, 'x'.repeat(408_000));
    const logs = [];
    const spawned = [];
    const capture = createFetchCapture({
      [`http://127.0.0.1:${TEST_IPC_PORT}/sessions`]: [
        { name: 'jianmu-pm', pid: 1777 },
      ],
      [`http://127.0.0.1:${TEST_IPC_PORT}/recent-messages?name=jianmu-pm&since=3600000&limit=50`]: {
        messages: [{ from: 'jianmu-pm', topic: 'status', content: 'drained ipc' }],
      },
    });
    const watchdog = createIsolatedWatchdog({
      fetchImpl: capture.fetchImpl,
      stderr: (line) => logs.push(line),
      now: () => 1_000_000,
      ipcSpawn: async (args) => {
        spawned.push(args);
        return { spawned: true };
      },
      handoverEnabled: true,
      handoverTickIntervalMs: 0,
      handoverConfig: { handoverDir: dir, handoverRepoPath: dir },
      getSessionStateImpl: (pid) => (pid === 1777 ? { pid, transcriptPath } : null),
      probes: {
        cliProxy: async () => ok(),
        hub: async () => ok(),
        anthropic: async () => ok(),
        dns: async () => ok(),
      },
    });

    await watchdog.runTick();
    const result = watchdog.getLastHandoverTickResult();

    assert.equal(result.detected.length, 1);
    assert.equal(result.detected[0].name, 'jianmu-pm');
    assert.equal(result.detected[0].pct, 51);
    assert.equal(spawned.length, 1);
    assert.match(spawned[0].task, /Self-handover doc:/);
    assert.match(spawned[0].task, /Recent IPC drain summary:/);
    assert.ok(logs.some((line) => line.includes('estimateContextPct transcript session=jianmu-pm pid=1777 pct=51')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createManualNow(start = 0) {
  let current = start;
  return {
    now: () => current,
    advance: (deltaMs) => {
      current += deltaMs;
      return current;
    },
  };
}

function createFetchCapture(routes = {}) {
  const requests = [];

  return {
    requests,
    fetchImpl: async (url, init = {}) => {
      const stringUrl = String(url);
      requests.push({
        method: init.method ?? 'GET',
        url: stringUrl,
        headers: normalizeHeaders(init.headers),
        body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      });
      return {
        status: 200,
        json: async () => routes[stringUrl] ?? {},
      };
    },
  };
}

function normalizeHeaders(headers) {
  const normalized = {};
  if (!headers) {
    return normalized;
  }

  for (const [key, value] of Object.entries(headers)) {
    normalized[String(key).toLowerCase()] = String(value);
  }

  return normalized;
}
