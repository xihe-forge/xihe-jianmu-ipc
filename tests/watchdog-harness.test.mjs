import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNetworkWatchdog } from '../bin/network-watchdog.mjs';

const TEST_IPC_PORT = 43180;

function ok(latencyMs = 1) {
  return { ok: true, latencyMs };
}

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

function createSequenceProbe(sequence) {
  let index = 0;
  return async () => {
    const current = sequence[Math.min(index, sequence.length - 1)];
    index += 1;
    return typeof current === 'function' ? current() : current;
  };
}

function createHarnessIpcClientStub({ pongSequence = [] } = {}) {
  const calls = {
    start: 0,
    stop: 0,
    sendPing: [],
    waitForPong: [],
  };
  let index = 0;

  return {
    calls,
    client: {
      async start() {
        calls.start += 1;
      },
      async stop() {
        calls.stop += 1;
      },
      async sendPing() {
        calls.sendPing.push('ping');
        return true;
      },
      async waitForPong({ timeoutMs }) {
        calls.waitForPong.push(timeoutMs);
        const current = pongSequence[Math.min(index, Math.max(pongSequence.length - 1, 0))] ?? false;
        index += 1;
        return current;
      },
    },
  };
}

function failOnUnexpectedFetch(url) {
  throw new Error(`unexpected watchdog harness fetch: ${String(url)}`);
}

function createIsolatedWatchdog(options = {}) {
  return createNetworkWatchdog({
    ipcPort: TEST_IPC_PORT,
    internalToken: 'watchdog-token',
    fetchImpl: failOnUnexpectedFetch,
    ...options,
  });
}

test('watchdog harness: 收到 hard-signal heartbeat 时触发 onHarnessStateChange(down)', async (t) => {
  const transitions = [];
  const ipcClient = createHarnessIpcClientStub();
  const watchdog = createIsolatedWatchdog({
    watchdogPort: 0,
    createWatchdogIpcClientImpl: () => ipcClient.client,
    coldStartGraceMs: 0,
    onHarnessStateChange: (transition) => transitions.push(transition),
    probes: {
      cliProxy: async () => ok(),
      hub: async () => ok(),
      anthropic: async () => ok(),
      dns: async () => ok(),
      harness: async () => ({ ok: true, connected: true, reason: 'online and active' }),
    },
  });
  t.after(async () => {
    await watchdog.stop();
  });

  await watchdog.start({ runImmediately: false });
  const accepted = watchdog.ingestHarnessHeartbeatContent(
    '【harness 2026-04-19T20:05:00.000Z · context-pct】70% | state=critical | next_action=self-handover',
  );

  assert.equal(accepted, true);
  assert.equal(ipcClient.calls.start, 1);
  assert.equal(watchdog.getHarnessState().state, 'down');
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].state, 'down');
  assert.equal(transitions[0].reason, 'hard-signal');
  assert.deepEqual(transitions[0].context, {
    pct: 70,
    nextAction: 'self-handover',
  });
});

test('watchdog harness: silent probe + 3 次 ping 无 pong 时进入 down', async (t) => {
  const transitions = [];
  const ipcClient = createHarnessIpcClientStub({
    pongSequence: [false, false, false],
  });
  const watchdog = createIsolatedWatchdog({
    createWatchdogIpcClientImpl: () => ipcClient.client,
    coldStartGraceMs: 0,
    onHarnessStateChange: (transition) => transitions.push(transition),
    probes: {
      cliProxy: async () => ok(),
      hub: async () => ok(),
      anthropic: async () => ok(),
      dns: async () => ok(),
      harness: async () => ({
        ok: false,
        connected: true,
        error: 'silent',
        reason: 'online but silent',
        requiresPing: true,
      }),
    },
  });
  t.after(async () => {
    await watchdog.stop();
  });

  const state = await watchdog.runTick();

  assert.equal(state.harness.state, 'down');
  assert.equal(state.harness.lastReason, 'soft-B-silent');
  assert.equal(state.harness.lastProbe.error, 'silent-confirmed');
  assert.equal(ipcClient.calls.sendPing.length, 3);
  assert.deepEqual(ipcClient.calls.waitForPong, [30_000, 30_000, 30_000]);
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].state, 'down');
  assert.equal(transitions[0].reason, 'soft-B-silent');
});

test('watchdog harness: soft signal 收到 pong 后保持 ok', async (t) => {
  const ipcClient = createHarnessIpcClientStub({
    pongSequence: [true],
  });
  const watchdog = createIsolatedWatchdog({
    createWatchdogIpcClientImpl: () => ipcClient.client,
    probes: {
      cliProxy: async () => ok(),
      hub: async () => ok(),
      anthropic: async () => ok(),
      dns: async () => ok(),
      harness: async () => ({
        ok: false,
        connected: false,
        error: 'disconnected-grace-exceeded',
        reason: 'disconnected beyond grace',
        requiresPing: true,
      }),
    },
  });
  t.after(async () => {
    await watchdog.stop();
  });

  const state = await watchdog.runTick();

  assert.equal(state.harness.state, 'ok');
  assert.equal(state.harness.lastProbe.reason, 'soft signal but responded');
  assert.equal(state.harness.lastProbe.failedPings, 0);
  assert.equal(ipcClient.calls.sendPing.length, 1);
});

test('watchdog harness: probe-ok 记活性信号后，grace 内 silent-confirmed 可进入 down', async (t) => {
  const clock = createManualNow();
  const ipcClient = createHarnessIpcClientStub({
    pongSequence: [false, false, false],
  });
  const watchdog = createIsolatedWatchdog({
    now: clock.now,
    coldStartGraceMs: 120_000,
    createWatchdogIpcClientImpl: () => ipcClient.client,
    probes: {
      cliProxy: async () => ok(),
      hub: async () => ok(),
      anthropic: async () => ok(),
      dns: async () => ok(),
      harness: createSequenceProbe([
        { ok: true, connected: true, reason: 'online and active' },
        {
          ok: false,
          connected: true,
          error: 'silent',
          reason: 'online but silent',
          requiresPing: true,
        },
      ]),
    },
  });
  t.after(async () => {
    await watchdog.stop();
  });

  await watchdog.runTick();
  clock.advance(30_000);
  const state = await watchdog.runTick();

  assert.equal(state.harness.state, 'down');
  assert.equal(state.harness.lastReason, 'soft-B-silent');
  assert.equal(state.harness.lastProbe.error, 'silent-confirmed');
});

test('watchdog harness: pong 记活性信号后，grace 内后续 silent-confirmed 可进入 down', async (t) => {
  const clock = createManualNow();
  const ipcClient = createHarnessIpcClientStub({
    pongSequence: [true, false, false, false],
  });
  const watchdog = createIsolatedWatchdog({
    now: clock.now,
    coldStartGraceMs: 120_000,
    createWatchdogIpcClientImpl: () => ipcClient.client,
    probes: {
      cliProxy: async () => ok(),
      hub: async () => ok(),
      anthropic: async () => ok(),
      dns: async () => ok(),
      harness: createSequenceProbe([
        {
          ok: false,
          connected: true,
          error: 'silent',
          reason: 'online but silent',
          requiresPing: true,
        },
        {
          ok: false,
          connected: true,
          error: 'silent',
          reason: 'online but silent',
          requiresPing: true,
        },
      ]),
    },
  });
  t.after(async () => {
    await watchdog.stop();
  });

  const firstState = await watchdog.runTick();
  assert.equal(firstState.harness.state, 'ok');
  assert.equal(firstState.harness.lastProbe.reason, 'soft signal but responded');

  clock.advance(30_000);
  const secondState = await watchdog.runTick();

  assert.equal(secondState.harness.state, 'down');
  assert.equal(secondState.harness.lastReason, 'soft-B-silent');
  assert.equal(secondState.harness.lastProbe.error, 'silent-confirmed');
  assert.equal(ipcClient.calls.sendPing.length, 4);
});
