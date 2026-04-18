import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  createNetworkWatchdog,
  WATCHDOG_RETRY_DELAYS_MS,
} from '../bin/network-watchdog.mjs';

const openServers = new Set();

afterEach(async () => {
  await Promise.allSettled([...openServers].map(closeServer));
  openServers.clear();
});

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

test('createNetworkWatchdog: 进入 down 时会 POST /internal/network-event', async () => {
  const capture = await startCaptureServer();
  const watchdog = createNetworkWatchdog({
    ipcPort: capture.port,
    internalToken: 'watchdog-token',
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
  assert.equal(capture.requests[0].url, '/internal/network-event');
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
  const capture = await startCaptureServer();
  const watchdog = createNetworkWatchdog({
    ipcPort: capture.port,
    internalToken: 'watchdog-token',
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
    since: 1000,
    triggeredBy: 'watchdog',
    ts: 1000,
  });
  assert.deepEqual(capture.requests[1].body, {
    event: 'network-up',
    recoveredAfter: 3000,
    triggeredBy: 'watchdog',
    ts: 4000,
  });
});

test('createNetworkWatchdog: HTTP 首发加 3 次重试失败后记 stderr，后续 tick 仍继续', async () => {
  const logs = [];
  const delays = [];
  let fetchCount = 0;
  const watchdog = createNetworkWatchdog({
    ipcPort: 3179,
    internalToken: 'watchdog-token',
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

async function startCaptureServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: JSON.parse(body),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  openServers.add(server);
  const address = server.address();
  return {
    port: typeof address === 'object' && address ? address.port : null,
    requests,
  };
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
