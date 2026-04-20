import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDefaultWatchdogProbes,
  createNetworkWatchdog,
} from '../bin/network-watchdog.mjs';

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

function createHarnessIpcClientStub() {
  const calls = {
    start: 0,
    stop: 0,
    sendMessage: [],
  };

  return {
    calls,
    client: {
      async start() {
        calls.start += 1;
      },
      async stop() {
        calls.stop += 1;
      },
      async sendMessage(payload) {
        calls.sendMessage.push(payload);
        return true;
      },
    },
  };
}

function createLineageStub() {
  return {
    check: () => ({ allowed: true, depth: 0, wakesInWindow: 0 }),
    record() {},
    chain: () => [],
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

function createSessionAliveFetch(body, calls) {
  return async (url) => {
    calls.push(String(url));
    return {
      status: 200,
      json: async () => body,
    };
  };
}

test('watchdog harness: 收到 hard-signal heartbeat 时触发 onHarnessStateChange(down)', async (t) => {
  const clock = createManualNow(Date.parse('2026-04-19T20:05:00.000Z'));
  const transitions = [];
  const ipcClient = createHarnessIpcClientStub();
  const watchdog = createIsolatedWatchdog({
    watchdogPort: 0,
    now: clock.now,
    createWatchdogIpcClientImpl: () => ipcClient.client,
    coldStartGraceMs: 0,
    onHarnessStateChange: (transition) => transitions.push(transition),
    probes: {
      cliProxy: async () => ok(),
      hub: async () => ok(),
      anthropic: async () => ok(),
      dns: async () => ok(),
      harness: async () => ({ ok: true, connected: true, reason: 'ws open' }),
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

test('watchdog harness: degraded heartbeat 不触发 onHarnessStateChange 或 auto handover', async (t) => {
  const clock = createManualNow(Date.parse('2026-04-19T20:05:00.000Z'));
  const transitions = [];
  const handoverCalls = [];
  const ipcClient = createHarnessIpcClientStub();
  const watchdog = createIsolatedWatchdog({
    watchdogPort: 0,
    now: clock.now,
    createWatchdogIpcClientImpl: () => ipcClient.client,
    coldStartGraceMs: 0,
    lineage: createLineageStub(),
    ipcSpawn: async () => ({ spawned: false }),
    handoverConfig: { dryRun: true },
    triggerHarnessSelfHandoverImpl: async (payload) => {
      handoverCalls.push(payload);
      return { triggered: true };
    },
    onHarnessStateChange: (transition) => transitions.push(transition),
    probes: {
      cliProxy: async () => ok(),
      hub: async () => ok(),
      anthropic: async () => ok(),
      dns: async () => ok(),
      harness: async () => ({ ok: true, connected: true, reason: 'ws open' }),
    },
  });
  t.after(async () => {
    await watchdog.stop();
  });

  await watchdog.start({ runImmediately: false });
  const accepted = watchdog.ingestHarnessHeartbeatContent(
    '【harness 2026-04-19T20:05:00.000Z · context-pct】70% | state=critical | next_action=continue',
  );

  assert.equal(accepted, true);
  await watchdog.waitForIdle();
  assert.equal(watchdog.getHarnessState().state, 'degraded');
  assert.deepEqual(transitions, []);
  assert.deepEqual(handoverCalls, []);
});

test('watchdog harness: topic handler 会把 stale heartbeat ts 传给状态机并忽略', async (t) => {
  const clock = createManualNow(Date.parse('2026-04-20T00:10:00.000Z'));
  const transitions = [];
  const ipcClient = createHarnessIpcClientStub();
  const watchdog = createIsolatedWatchdog({
    watchdogPort: 0,
    now: clock.now,
    createWatchdogIpcClientImpl: () => ipcClient.client,
    coldStartGraceMs: 0,
    onHarnessStateChange: (transition) => transitions.push(transition),
    probes: {
      cliProxy: async () => ok(),
      hub: async () => ok(),
      anthropic: async () => ok(),
      dns: async () => ok(),
      harness: async () => ({ ok: true, connected: true, reason: 'ws open' }),
    },
  });
  t.after(async () => {
    await watchdog.stop();
  });

  await watchdog.start({ runImmediately: false });
  const accepted = watchdog.ingestHarnessHeartbeatContent(
    '【harness 2026-04-20T00:08:30.000Z · context-pct】70% | state=critical | next_action=self-handover',
  );

  assert.equal(accepted, true);
  await watchdog.waitForIdle();
  assert.equal(watchdog.getHarnessState().state, 'ok');
  assert.deepEqual(transitions, []);
});

test('watchdog harness: Hub stub session(ws=null, connectedAt=0) 时默认 probe 返回 disconnected, no baseline', async (t) => {
  const calls = [];
  const ipcClient = createHarnessIpcClientStub();
  const defaultProbes = createDefaultWatchdogProbes({
    ipcPort: TEST_IPC_PORT,
    harnessProbeConfig: {
      fetchImpl: createSessionAliveFetch({
        ok: true,
        name: 'harness',
        alive: false,
        connectedAt: 0,
        lastAliveProbe: 10_000,
      }, calls),
      now: () => 10_000,
      sessionName: 'harness',
    },
  });
  const watchdog = createIsolatedWatchdog({
    watchdogPort: 0,
    createWatchdogIpcClientImpl: () => ipcClient.client,
    probes: {
      cliProxy: async () => ok(),
      hub: async () => ok(),
      anthropic: async () => ok(),
      dns: async () => ok(),
      harness: defaultProbes.harness,
    },
  });
  t.after(async () => {
    await watchdog.stop();
  });

  const state = await watchdog.runTick();

  assert.equal(state.harness.state, 'ok');
  assert.equal(state.harness.lastProbe.reason, 'disconnected, no baseline');
  assert.deepEqual(calls, ['http://127.0.0.1:43180/session-alive?name=harness']);
});

test('watchdog harness: Hub session 不存在时默认 probe 返回 disconnected, no baseline', async (t) => {
  const ipcClient = createHarnessIpcClientStub();
  const defaultProbes = createDefaultWatchdogProbes({
    ipcPort: TEST_IPC_PORT,
    harnessProbeConfig: {
      fetchImpl: async () => ({
        status: 200,
        json: async () => ({
          ok: true,
          name: 'harness',
          alive: false,
          connectedAt: null,
          lastAliveProbe: 10_000,
        }),
      }),
      now: () => 10_000,
      sessionName: 'harness',
    },
  });
  const watchdog = createIsolatedWatchdog({
    watchdogPort: 0,
    createWatchdogIpcClientImpl: () => ipcClient.client,
    probes: {
      cliProxy: async () => ok(),
      hub: async () => ok(),
      anthropic: async () => ok(),
      dns: async () => ok(),
      harness: defaultProbes.harness,
    },
  });
  t.after(async () => {
    await watchdog.stop();
  });

  const state = await watchdog.runTick();

  assert.equal(state.harness.state, 'ok');
  assert.equal(state.harness.lastProbe.reason, 'disconnected, no baseline');
});

test('watchdog harness: ws-disconnected-grace-exceeded 时进入 down', async (t) => {
  const transitions = [];
  const ipcClient = createHarnessIpcClientStub();
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
        connected: false,
        error: 'ws-disconnected-grace-exceeded',
        reason: 'ws down beyond grace',
      }),
    },
  });
  t.after(async () => {
    await watchdog.stop();
  });

  const state = await watchdog.runTick();

  assert.equal(state.harness.state, 'down');
  assert.equal(state.harness.lastReason, 'ws-down-grace-exceeded');
  assert.equal(state.harness.lastProbe.error, 'ws-disconnected-grace-exceeded');
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].reason, 'ws-down-grace-exceeded');
});

test('watchdog harness: probe-ok 记活性信号后，grace 内 ws-down-grace-exceeded 可进入 down', async (t) => {
  const clock = createManualNow();
  const ipcClient = createHarnessIpcClientStub();
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
        { ok: true, connected: true, reason: 'ws open' },
        {
          ok: false,
          connected: false,
          error: 'ws-disconnected-grace-exceeded',
          reason: 'ws down beyond grace',
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
  assert.equal(state.harness.lastReason, 'ws-down-grace-exceeded');
  assert.equal(state.harness.lastProbe.error, 'ws-disconnected-grace-exceeded');
});
