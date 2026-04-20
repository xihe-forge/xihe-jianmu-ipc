import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNetworkWatchdog } from '../../bin/network-watchdog.mjs';
import { createLineageTracker } from '../../lib/lineage.mjs';

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

function createHarnessIpcClientStub() {
  const calls = {
    start: 0,
    stop: 0,
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
      async sendMessage() {
        return true;
      },
    },
  };
}

test('watchdog cold-start grace: 启动 2 分钟内 ws-down-grace-exceeded 不触发 self-handover，grace 后恢复正常', async (t) => {
  const clock = createManualNow();
  const handoverCalls = [];
  const ipcClient = createHarnessIpcClientStub();
  const watchdog = createNetworkWatchdog({
    watchdogPort: 0,
    internalToken: 'watchdog-token',
    now: clock.now,
    coldStartGraceMs: 120_000,
    createWatchdogIpcClientImpl: () => ipcClient.client,
    lineage: createLineageTracker({ now: clock.now }),
    ipcSpawn: async () => ({ spawned: false }),
    triggerHarnessSelfHandoverImpl: async (payload) => {
      handoverCalls.push(payload);
      return { triggered: true };
    },
    handoverConfig: {
      dryRun: true,
    },
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

  await watchdog.start({ runImmediately: false });

  for (let index = 0; index < 4; index += 1) {
    const state = await watchdog.runTick();
    await watchdog.waitForIdle();
    assert.equal(state.harness.state, 'degraded');
    assert.match(state.harness.lastReason, /^held-by-grace: ws-down-grace-exceeded/);
    assert.equal(handoverCalls.length, 0);
    clock.advance(30_000);
  }

  const postGraceState = await watchdog.runTick();
  await watchdog.waitForIdle();

  assert.equal(ipcClient.calls.start, 1);
  assert.equal(postGraceState.harness.state, 'down');
  assert.equal(postGraceState.harness.lastReason, 'ws-down-grace-exceeded');
  assert.equal(handoverCalls.length, 1);
});
