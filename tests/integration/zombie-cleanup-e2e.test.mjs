import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNetworkWatchdog } from '../../bin/network-watchdog.mjs';
import {
  closeWebSocket,
  connectSession,
  httpRequest,
  startHub,
  stopHub,
  TEST_TIMEOUT,
  waitForClose,
} from '../helpers/hub-fixture.mjs';

function ok() {
  return { ok: true, latencyMs: 1 };
}

function makeWatchdog({ port, deadPid }) {
  return createNetworkWatchdog({
    ipcPort: port,
    internalToken: 'zombie-cleanup-token',
    probes: {
      cliProxy: async () => ok(),
      hub: async () => ok(),
      anthropic: async () => ok(),
      dns: async () => ok(),
    },
    createWatchdogIpcClientImpl: () => ({
      async start() {},
      async stop() {},
      async sendMessage() {
        return true;
      },
    }),
    stuckDetectorEnabled: false,
    handoverEnabled: false,
    rateLimitCritiqueEnabled: false,
    zombiePidDetectorEnabled: true,
    zombiePidDetectorTickIntervalMs: 0,
    zombiePidDetectorInitialLastTickAt: 0,
    zombiePidDetectorDryRun: false,
    zombiePidDetectorIsPidAlive: (pid) => pid !== deadPid,
    stderr: () => {},
  });
}

async function getSessions(port, path = '/sessions') {
  const response = await httpRequest(port, { method: 'GET', path });
  assert.equal(response.statusCode, 200);
  assert.ok(Array.isArray(response.body));
  return response.body;
}

test('K.D zombie cleanup e2e: watchdog evicts dead subprocess session and /sessions filters anonymous', { timeout: TEST_TIMEOUT + 10_000 }, async () => {
  const hub = await startHub({ prefix: 'zombie-cleanup-e2e' });
  const deadPid = 9_999_991;
  const anonymousName = `session-kd-zombie-${Date.now()}`;
  const explicitName = `kd-explicit-${Date.now()}`;
  let anonymousWs = null;
  let explicitWs = null;

  try {
    explicitWs = await connectSession(hub.port, explicitName, {
      register: { pid: process.pid, subprocess: false },
    });
    anonymousWs = await connectSession(hub.port, anonymousName, {
      autoPong: false,
      register: { pid: deadPid, subprocess: true },
    });

    const defaultSessionsBefore = await getSessions(hub.port);
    assert.ok(defaultSessionsBefore.some((session) => session.name === explicitName));
    assert.equal(defaultSessionsBefore.some((session) => session.name === anonymousName), false);

    const allSessionsBefore = await getSessions(hub.port, '/sessions?include_anonymous=1');
    assert.equal(allSessionsBefore.find((session) => session.name === anonymousName)?.subprocess, true);

    const closePromise = waitForClose(anonymousWs, 8_000);
    const watchdog = makeWatchdog({ port: hub.port, deadPid });
    await watchdog.runTick();
    await closePromise;

    const defaultSessionsAfter = await getSessions(hub.port);
    assert.equal(defaultSessionsAfter.some((session) => session.name === anonymousName), false);

    const allSessionsAfter = await getSessions(hub.port, '/sessions?include_anonymous=1');
    assert.equal(allSessionsAfter.some((session) => session.name === anonymousName), false);
  } finally {
    await closeWebSocket(anonymousWs);
    await closeWebSocket(explicitWs);
    await stopHub(hub);
  }
});
