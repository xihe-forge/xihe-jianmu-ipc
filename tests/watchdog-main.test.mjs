import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWatchdogIpcClient,
  createNetworkWatchdog,
  startWatchdog,
  RATE_LIMIT_CRITIQUE_DEDUP_MS,
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
    rateLimitCritiqueEnabled: false,
    ...options,
  });
}

function createSpawnMock({ stdout = '{"suspects_found":1,"killed":[123]}', code = 0 } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      child.stdout.emit('data', stdout);
      child.emit('close', code);
    });
    return child;
  };
  return { calls, spawnImpl };
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

test('createNetworkWatchdog: handover tick reads Hub contextUsagePct and dry-runs spawn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-hub-pct-'));
  try {
    initCleanGitDir(dir);
    const logs = [];
    const spawned = [];
    const capture = createFetchCapture({
      [`http://127.0.0.1:${TEST_IPC_PORT}/sessions`]: [
        { name: 'jianmu-pm', pid: 1777, contextUsagePct: 95, cwd: dir, pendingOutgoing: 0 },
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
    assert.equal(result.detected[0].pct, 95);
    assert.equal(result.detected[0].dryRun, true);
    assert.equal(spawned.length, 0);
    assert.ok(logs.some((line) => line.includes('estimateContextPct hub session=jianmu-pm pid=1777 pct=95')));
    assert.ok(logs.some((line) => line.includes('pre-spawn-review dry-run')));
    assert.ok(capture.requests.some((request) => request.url.endsWith('/send') && request.body?.topic === 'pre-spawn-review'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createNetworkWatchdog: handover tick prefers contextWindow.used_percentage over stale contextUsagePct', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-hub-context-window-pct-'));
  try {
    initCleanGitDir(dir);
    const logs = [];
    const capture = createFetchCapture({
      [`http://127.0.0.1:${TEST_IPC_PORT}/sessions`]: [
        {
          name: 'jianmu-pm',
          pid: 1777,
          contextUsagePct: 0.04,
          contextWindow: { used_percentage: 95, max_tokens: 200000 },
          cwd: dir,
          pendingOutgoing: 0,
        },
      ],
      [`http://127.0.0.1:${TEST_IPC_PORT}/recent-messages?name=jianmu-pm&since=3600000&limit=50`]: {
        messages: [],
      },
    });
    const watchdog = createIsolatedWatchdog({
      fetchImpl: capture.fetchImpl,
      stderr: (line) => logs.push(line),
      now: () => 1_000_000,
      ipcSpawn: async () => ({ spawned: true }),
      handoverEnabled: true,
      handoverTickIntervalMs: 0,
      handoverConfig: { handoverDir: dir, handoverRepoPath: dir },
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
    assert.equal(result.detected[0].pct, 95);
    assert.ok(logs.some((line) => line.includes('estimateContextPct hub session=jianmu-pm pid=1777 pct=95')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createNetworkWatchdog: default handover threshold is 50%', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-threshold-'));
  try {
    initCleanGitDir(dir);
    const capture = createFetchCapture({
      [`http://127.0.0.1:${TEST_IPC_PORT}/sessions`]: [
        { name: 'jianmu-pm', pid: 1777, contextUsagePct: 49, cwd: dir, pendingOutgoing: 0 },
      ],
    });
    const watchdog = createIsolatedWatchdog({
      fetchImpl: capture.fetchImpl,
      now: () => 1_000_000,
      ipcSpawn: async () => ({ spawned: true }),
      handoverEnabled: true,
      handoverTickIntervalMs: 0,
      handoverConfig: { handoverDir: dir, handoverRepoPath: dir },
      probes: {
        cliProxy: async () => ok(),
        hub: async () => ok(),
        anthropic: async () => ok(),
        dns: async () => ok(),
      },
    });

    await watchdog.runTick();
    const result = watchdog.getLastHandoverTickResult();

    assert.equal(result.detected.length, 0);
    assert.equal(result.skipped.find((item) => item.name === 'jianmu-pm')?.skipped, 'under-threshold');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createNetworkWatchdog: handover requires pending=0, clean git, and no in-flight codex task', async () => {
  const cases = [
    {
      name: 'pending-ipc',
      sessionPatch: { pendingOutgoing: 1 },
      setup: initCleanGitDir,
    },
    {
      name: 'dirty-git',
      sessionPatch: { pendingOutgoing: 0 },
      setup: (dir) => {
        initCleanGitDir(dir);
        execFileSync('git', ['config', 'user.name', 'Xihe'], { cwd: dir, stdio: 'ignore' });
        execFileSync('git', ['config', 'user.email', 'xihe-ai@lumidrivetech.com'], { cwd: dir, stdio: 'ignore' });
        writeFileSync(join(dir, 'README.md'), 'clean');
        execFileSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'ignore' });
        execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
        writeFileSync(join(dir, 'README.md'), 'dirty');
      },
    },
    {
      name: 'running-codex',
      sessionPatch: { pendingOutgoing: 0 },
      setup: (dir) => {
        initCleanGitDir(dir);
        const reportsDir = join(dir, 'reports', 'codex-runs');
        mkdirSync(reportsDir, { recursive: true });
        writeFileSync(join(reportsDir, 'run.json'), JSON.stringify({ status: 'running' }));
      },
    },
  ];

  for (const testCase of cases) {
    const dir = mkdtempSync(join(tmpdir(), `watchdog-${testCase.name}-`));
    try {
      testCase.setup(dir);
      const capture = createFetchCapture({
        [`http://127.0.0.1:${TEST_IPC_PORT}/sessions`]: [
          {
            name: testCase.name,
            pid: 1777,
            contextUsagePct: 95,
            cwd: dir,
            ...testCase.sessionPatch,
          },
        ],
      });
      const watchdog = createIsolatedWatchdog({
        fetchImpl: capture.fetchImpl,
        now: () => 1_000_000,
        ipcSpawn: async () => ({ spawned: true }),
        handoverEnabled: true,
        handoverTickIntervalMs: 0,
        handoverConfig: { handoverDir: dir, handoverRepoPath: dir },
        probes: {
          cliProxy: async () => ok(),
          hub: async () => ok(),
          anthropic: async () => ok(),
          dns: async () => ok(),
        },
      });

      await watchdog.runTick();
      const result = watchdog.getLastHandoverTickResult();

      assert.equal(result.detected.length, 0, testCase.name);
      assert.equal(result.skipped.find((item) => item.name === testCase.name)?.skipped, 'task-in-progress', testCase.name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('startWatchdog: boot default runs atomic handover as real swap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-boot-real-swap-'));
  try {
    initCleanGitDir(dir);
    const spawned = [];
    const capture = createFetchCapture({
      [`http://127.0.0.1:${TEST_IPC_PORT}/sessions`]: [
        { name: 'jianmu-pm', pid: 1777, contextUsagePct: 95, cwd: dir, pendingOutgoing: 0 },
      ],
      [`http://127.0.0.1:${TEST_IPC_PORT}/recent-messages?name=jianmu-pm&since=3600000&limit=50`]: {
        messages: [{ from: 'jianmu-pm', topic: 'status', content: 'drained ipc' }],
      },
    });
    const watchdog = await startWatchdog({
      ipcPort: TEST_IPC_PORT,
      watchdogPort: 43180,
      intervalMs: 60_000,
      internalToken: 'watchdog-token',
      fetchImpl: capture.fetchImpl,
      createWatchdogIpcClientImpl: () => createIpcClientStub(),
      createServerImpl: createServerStub,
      setTimeoutImpl: () => null,
      clearTimeoutImpl: () => {},
      now: () => 1_000_000,
      ipcSpawn: async (args) => {
        spawned.push(args);
        return { spawned: true };
      },
      stuckDetectorEnabled: false,
      rateLimitCritiqueEnabled: false,
      handoverEnabled: true,
      handoverTickIntervalMs: 0,
      handoverConfig: { handoverDir: dir, handoverRepoPath: dir },
      probes: {
        cliProxy: async () => ok(),
        hub: async () => ok(),
        anthropic: async () => ok(),
        dns: async () => ok(),
      },
    });

    try {
      await waitFor(() => spawned.length === 1);
      const result = watchdog.getLastHandoverTickResult();

      assert.equal(result.detected.length, 1);
      assert.equal(result.detected[0].name, 'jianmu-pm');
      assert.equal(result.detected[0].dryRun, undefined);
      assert.equal(spawned[0].name, 'jianmu-pm');
      assert.ok(capture.requests.some((request) => request.url.endsWith('/prepare-rebind')));
      assert.equal(capture.requests.some((request) => request.url.endsWith('/send') && request.body?.topic === 'pre-spawn-review'), false);
    } finally {
      await watchdog.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startWatchdog: WATCHDOG_HANDOVER_DRY_RUN=true keeps boot handover in dry-run', async () => {
  const previous = process.env.WATCHDOG_HANDOVER_DRY_RUN;
  process.env.WATCHDOG_HANDOVER_DRY_RUN = 'true';
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-boot-dry-run-'));
  try {
    initCleanGitDir(dir);
    const spawned = [];
    const capture = createFetchCapture({
      [`http://127.0.0.1:${TEST_IPC_PORT}/sessions`]: [
        { name: 'jianmu-pm', pid: 1777, contextUsagePct: 95, cwd: dir, pendingOutgoing: 0 },
      ],
      [`http://127.0.0.1:${TEST_IPC_PORT}/recent-messages?name=jianmu-pm&since=3600000&limit=50`]: {
        messages: [{ from: 'jianmu-pm', topic: 'status', content: 'drained ipc' }],
      },
    });
    const watchdog = await startWatchdog({
      ipcPort: TEST_IPC_PORT,
      watchdogPort: 43180,
      intervalMs: 60_000,
      internalToken: 'watchdog-token',
      fetchImpl: capture.fetchImpl,
      createWatchdogIpcClientImpl: () => createIpcClientStub(),
      createServerImpl: createServerStub,
      setTimeoutImpl: () => null,
      clearTimeoutImpl: () => {},
      now: () => 1_000_000,
      ipcSpawn: async (args) => {
        spawned.push(args);
        return { spawned: true };
      },
      stuckDetectorEnabled: false,
      rateLimitCritiqueEnabled: false,
      handoverEnabled: true,
      handoverTickIntervalMs: 0,
      handoverConfig: { handoverDir: dir, handoverRepoPath: dir },
      probes: {
        cliProxy: async () => ok(),
        hub: async () => ok(),
        anthropic: async () => ok(),
        dns: async () => ok(),
      },
    });

    try {
      await waitFor(() => capture.requests.some((request) => request.url.endsWith('/send') && request.body?.topic === 'pre-spawn-review'));
      const result = watchdog.getLastHandoverTickResult();

      assert.equal(result.detected.length, 1);
      assert.equal(result.detected[0].name, 'jianmu-pm');
      assert.equal(result.detected[0].dryRun, true);
      assert.equal(spawned.length, 0);
      assert.equal(capture.requests.some((request) => request.url.endsWith('/prepare-rebind')), false);
    } finally {
      await watchdog.stop();
    }
  } finally {
    if (previous === undefined) {
      delete process.env.WATCHDOG_HANDOVER_DRY_RUN;
    } else {
      process.env.WATCHDOG_HANDOVER_DRY_RUN = previous;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createNetworkWatchdog: committed_pct is status-only and never critiques or tree-kills', async () => {
  const sent = [];
  const spawnMock = createSpawnMock();
  const watchdog = createIsolatedWatchdog({
    spawnImpl: spawnMock.spawnImpl,
    handoverEnabled: false,
    handoverConfig: { ipcSend: async (message) => { sent.push(message); } },
    probes: {
      cliProxy: async () => ok(),
      hub: async () => ok(),
      anthropic: async () => ok(),
      dns: async () => ok(),
      committed_pct: async () => ({ ok: true, pct: 95 }),
    },
  });

  const state = await watchdog.runTick();
  await watchdog.waitForIdle();

  assert.equal(state.lastChecks.committed_pct.pct, 95);
  assert.equal(sent.length, 0);
  assert.equal(spawnMock.calls.length, 0);
});

test('createNetworkWatchdog: phys_ram_used_pct at 90% invokes tree-kill', async () => {
  const spawnMock = createSpawnMock();
  const watchdog = createIsolatedWatchdog({
    spawnImpl: spawnMock.spawnImpl,
    handoverEnabled: false,
    probes: {
      cliProxy: async () => ok(),
      hub: async () => ok(),
      anthropic: async () => ok(),
      dns: async () => ok(),
      phys_ram_used_pct: async () => ({ ok: true, pct: 90 }),
    },
  });

  await watchdog.runTick();
  await watchdog.waitForIdle();

  assert.equal(spawnMock.calls.length, 1);
  assert.equal(spawnMock.calls[0].command, 'pwsh');
  assert(spawnMock.calls[0].args.some((arg) => arg.includes('session-guard.ps1')));
  assert(spawnMock.calls[0].args.includes('tree-kill'));
});

test('createNetworkWatchdog: available_ram_mb below 3GB invokes tree-kill', async () => {
  const spawnMock = createSpawnMock();
  const watchdog = createIsolatedWatchdog({
    spawnImpl: spawnMock.spawnImpl,
    handoverEnabled: false,
    probes: {
      cliProxy: async () => ok(),
      hub: async () => ok(),
      anthropic: async () => ok(),
      dns: async () => ok(),
      available_ram_mb: async () => ({ ok: true, availableMb: 2999 }),
    },
  });

  await watchdog.runTick();
  await watchdog.waitForIdle();

  assert.equal(spawnMock.calls.length, 1);
  assert.equal(spawnMock.calls[0].command, 'pwsh');
  assert(spawnMock.calls[0].args.some((arg) => arg.includes('session-guard.ps1')));
  assert(spawnMock.calls[0].args.includes('tree-kill'));
});

test('createNetworkWatchdog: handover tick uses next-tick pacing label', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-handoff-pacing-'));
  try {
    initCleanGitDir(dir);
    const capture = createFetchCapture({
      [`http://127.0.0.1:${TEST_IPC_PORT}/sessions`]: [
        { name: 'low-pct', pid: 1001, contextUsagePct: 70, cwd: dir, pendingOutgoing: 0 },
        { name: 'high-pct', pid: 1002, contextUsagePct: 95, cwd: dir, pendingOutgoing: 0 },
        { name: 'mid-pct', pid: 1003, contextUsagePct: 85, cwd: dir, pendingOutgoing: 0 },
      ],
      [`http://127.0.0.1:${TEST_IPC_PORT}/recent-messages?name=high-pct&since=3600000&limit=50`]: { messages: [] },
      [`http://127.0.0.1:${TEST_IPC_PORT}/recent-messages?name=mid-pct&since=3600000&limit=50`]: { messages: [] },
      [`http://127.0.0.1:${TEST_IPC_PORT}/recent-messages?name=low-pct&since=3600000&limit=50`]: { messages: [] },
    });
    const watchdog = createIsolatedWatchdog({
      fetchImpl: capture.fetchImpl,
      now: () => 1_000_000,
      ipcSpawn: async () => ({ spawned: true }),
      handoverEnabled: true,
      handoverTickIntervalMs: 0,
      handoverConfig: { handoverDir: dir, handoverRepoPath: dir },
      probes: {
        cliProxy: async () => ok(),
        hub: async () => ok(),
        anthropic: async () => ok(),
        dns: async () => ok(),
      },
    });

    await watchdog.runTick();
    const result = watchdog.getLastHandoverTickResult();

    assert.equal(result.detected.length, 1, 'this tick still spawns one handoff due to pacing');
    assert.equal(result.detected[0].name, 'high-pct', 'highest pct first');
    assert.equal(result.detected[0].pct, 95);
    assert.equal(result.skipped.filter((item) => item.skipped === 'global-rate-limit').length, 0, "v0.4 removes 'global-rate-limit' label");
    assert.equal(result.skipped.filter((item) => item.skipped === 'pacing-deferred-next-tick').length, 2, "v0.4 uses 'pacing-deferred-next-tick' label");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createNetworkWatchdog: critiques five_hour and seven_day at 95%', async () => {
  const sent = [];
  const capture = createFetchCapture({
    [`http://127.0.0.1:${TEST_IPC_PORT}/sessions`]: [
      {
        name: 'harness',
        rateLimits: {
          five_hour: { used_percentage: 96, resets_at: 1777300000 },
          seven_day: { used_percentage: 96, resets_at: 1777900000 },
        },
      },
    ],
  });
  const watchdog = createIsolatedWatchdog({
    fetchImpl: capture.fetchImpl,
    now: () => 1_000_000,
    handoverEnabled: false,
    rateLimitCritiqueEnabled: true,
    handoverConfig: { ipcSend: async (message) => { sent.push(message); } },
    probes: {
      cliProxy: async () => ok(),
      hub: async () => ok(),
      anthropic: async () => ok(),
      dns: async () => ok(),
    },
  });

  await watchdog.runTick();

  assert.deepEqual(sent.map((message) => message.to), ['harness', 'harness']);
  assert.deepEqual(sent.map((message) => message.topic), ['critique', 'critique']);
  assert.match(sent[0].content, /harness five_hour 96% >= 95%/);
  assert.match(sent[1].content, /harness seven_day 96% >= 95%/);
});

test('createNetworkWatchdog: skips stale rate limit critiques after reset time', async () => {
  const sent = [];
  const capture = createFetchCapture({
    [`http://127.0.0.1:${TEST_IPC_PORT}/sessions`]: [
      {
        name: 'stale-session',
        rateLimits: {
          five_hour: { used_percentage: 80, resets_at: 999 },
        },
      },
    ],
  });
  const watchdog = createIsolatedWatchdog({
    fetchImpl: capture.fetchImpl,
    now: () => 1_000_000,
    handoverEnabled: false,
    rateLimitCritiqueEnabled: true,
    handoverConfig: { ipcSend: async (message) => { sent.push(message); } },
    probes: {
      cliProxy: async () => ok(),
      hub: async () => ok(),
      anthropic: async () => ok(),
      dns: async () => ok(),
    },
  });

  await watchdog.runTick();

  assert.deepEqual(sent, []);
});

test('createNetworkWatchdog: rate limit critique dedups per portfolio window until dedup window elapses', async () => {
  const sent = [];
  const clock = createManualNow(1_000_000 + RATE_LIMIT_CRITIQUE_DEDUP_MS + 1);
  const capture = createFetchCapture({
    [`http://127.0.0.1:${TEST_IPC_PORT}/sessions`]: [
      {
        name: 'auditor-portfolio',
        rateLimits: {
          five_hour: { used_percentage: 96, resets_at: 1777300000 },
          seven_day: { used_percentage: 96, resets_at: 1777900000 },
        },
      },
      {
        name: 'xihe-ai',
        rateLimits: {
          five_hour: { used_percentage: 96, resets_at: 1777300000 },
          seven_day: { used_percentage: 96, resets_at: 1777900000 },
        },
      },
    ],
  });
  const watchdog = createIsolatedWatchdog({
    fetchImpl: capture.fetchImpl,
    now: clock.now,
    handoverEnabled: false,
    rateLimitCritiqueEnabled: true,
    handoverConfig: { ipcSend: async (message) => { sent.push(message); } },
    probes: {
      cliProxy: async () => ok(),
      hub: async () => ok(),
      anthropic: async () => ok(),
      dns: async () => ok(),
    },
  });

  await watchdog.runTick();
  await watchdog.runTick();
  clock.advance(RATE_LIMIT_CRITIQUE_DEDUP_MS);
  await watchdog.runTick();

  assert.equal(sent.length, 4);
  assert.equal(sent.filter((message) => message.content.includes('five_hour')).length, 2);
  assert.equal(sent.filter((message) => message.content.includes('seven_day')).length, 2);
  assert.equal(sent.filter((message) => message.content.includes('auditor-portfolio')).length, 4);
  assert.equal(sent.filter((message) => message.content.includes('xihe-ai')).length, 0);
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

function initCleanGitDir(dir) {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  mkdirSync(join(dir, 'reports', 'codex-runs'), { recursive: true });
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

function createServerStub() {
  const server = new EventEmitter();
  server.listen = () => {
    queueMicrotask(() => server.emit('listening'));
    return server;
  };
  server.address = () => ({ port: 43180 });
  server.close = (callback) => {
    callback?.();
  };
  return server;
}

async function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('timed out waiting for condition');
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
