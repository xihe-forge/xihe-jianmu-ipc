import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  createNetworkWatchdog,
  createWatchdogStatusHandler,
} from '../bin/network-watchdog.mjs';

function ok(latencyMs = 1) {
  return { ok: true, latencyMs };
}

test('watchdog /status: 返回精确字段，state=OK 时 failing 为空数组', async (t) => {
  const watchdog = createNetworkWatchdog({
    watchdogPort: 0,
    internalToken: 'watchdog-token',
    intervalMs: 60_000,
    probes: {
      cliProxy: async () => ok(10),
      hub: async () => ok(11),
      anthropic: async () => ok(12),
      dns: async () => ok(13),
    },
  });
  t.after(async () => {
    await watchdog.stop();
  });

  await watchdog.start({ runImmediately: false });
  await watchdog.runTick();
  const response = await httpRequest(watchdog.getConfig().watchdogPort, {
    method: 'GET',
    path: '/status',
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    Object.keys(response.body).sort(),
    ['failing', 'lastChecks', 'state', 'uptime'],
  );
  assert.equal(response.body.state, 'OK');
  assert.deepEqual(response.body.failing, []);
  assert.deepEqual(
    Object.keys(response.body.lastChecks).sort(),
    ['anthropic', 'cliProxy', 'dns', 'hub'],
  );
  assert.equal(typeof response.body.lastChecks.cliProxy.ts, 'number');
  assert.equal(typeof response.body.uptime, 'number');
});

test('watchdog /status: 未知路径返回 404', async (t) => {
  const watchdog = createNetworkWatchdog({
    watchdogPort: 0,
    internalToken: 'watchdog-token',
    intervalMs: 60_000,
    probes: {
      cliProxy: async () => ok(),
      hub: async () => ok(),
      anthropic: async () => ok(),
      dns: async () => ok(),
    },
  });
  t.after(async () => {
    await watchdog.stop();
  });

  await watchdog.start({ runImmediately: false });
  const response = await httpRequest(watchdog.getConfig().watchdogPort, {
    method: 'GET',
    path: '/unknown',
  });

  assert.equal(response.statusCode, 404);
});

test('watchdog /status: 非 127.0.0.1 访问返回 403', async (t) => {
  const handler = createWatchdogStatusHandler({
    getSnapshot: () => ({
      state: 'OK',
      failing: [],
      lastChecks: {},
    }),
    getUptime: () => 123,
  });
  const server = http.createServer((req, res) => {
    Object.defineProperty(req.socket, 'remoteAddress', {
      configurable: true,
      value: '10.0.0.2',
    });
    handler(req, res);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await closeServer(server);
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  const response = await httpRequest(port, {
    method: 'GET',
    path: '/status',
  });

  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.body, { ok: false, error: 'forbidden' });
});

function httpRequest(port, { method, path }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        agent: false,
        hostname: '127.0.0.1',
        port,
        path,
        headers: {
          Connection: 'close',
        },
        method,
      },
      response => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', chunk => {
          responseBody += chunk;
        });
        response.on('end', () => {
          let parsedBody = null;
          if (responseBody.length > 0) {
            try {
              parsedBody = JSON.parse(responseBody);
            } catch {
              parsedBody = responseBody;
            }
          }

          resolve({
            statusCode: response.statusCode,
            body: parsedBody,
          });
        });
      },
    );

    request.once('error', reject);
    request.end();
  });
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
