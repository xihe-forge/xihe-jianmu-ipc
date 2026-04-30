import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAtomicHandoverTrigger } from '../lib/context-usage-auto-handover.mjs';
import { startWatchdog } from '../bin/network-watchdog.mjs';

const TEST_IPC_PORT = 43179;

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
  if (!headers) return normalized;
  for (const [key, value] of Object.entries(headers)) {
    normalized[String(key).toLowerCase()] = String(value);
  }
  return normalized;
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
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('timed out waiting for condition');
}

test('atomic handover real swap notifies old session to quit after prepare-rebind', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handover-quit-real-'));
  try {
    const events = [];
    const trigger = createAtomicHandoverTrigger({
      name: 'jianmu-pm',
      cwd: dir,
      handoverDir: dir,
      now: () => 1_777_232_746_089,
      dryRun: false,
      renameSession: async () => {
        events.push('prepare-rebind');
        return { ok: true, status: 200 };
      },
      notifyOldSessionQuit: async ({ name }) => {
        events.push(`quit:${name}`);
        return { ok: true, status: 200 };
      },
      spawnSession: async () => {
        events.push('spawn');
        return { spawned: true };
      },
    });

    const result = await trigger();

    assert.deepEqual(events, ['prepare-rebind', 'quit:jianmu-pm', 'spawn']);
    assert.equal(result.quitNotifyResult.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('atomic handover dry-run does not notify old session quit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handover-quit-dryrun-'));
  try {
    let quitNotified = false;
    const trigger = createAtomicHandoverTrigger({
      name: 'jianmu-pm',
      cwd: dir,
      handoverDir: dir,
      now: () => 1_777_232_746_089,
      dryRun: true,
      stderr: () => {},
      notifyPreSpawnReview: async () => {},
      notifyOldSessionQuit: async () => {
        quitNotified = true;
      },
      renameSession: async () => ({ ok: true }),
      spawnSession: async () => ({ spawned: true }),
    });

    const result = await trigger();

    assert.equal(result.dryRun, true);
    assert.equal(quitNotified, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('atomic handover aborts spawn when quit notification fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handover-quit-fail-'));
  try {
    let spawned = false;
    const trigger = createAtomicHandoverTrigger({
      name: 'jianmu-pm',
      cwd: dir,
      handoverDir: dir,
      now: () => 1_777_232_746_089,
      dryRun: false,
      renameSession: async () => ({ ok: true, status: 200 }),
      notifyOldSessionQuit: async () => {
        throw new Error('send failed');
      },
      spawnSession: async () => {
        spawned = true;
        return { spawned: true };
      },
    });

    await assert.rejects(trigger, /send failed/);
    assert.equal(spawned, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watchdog atomic handoff sends atomic-handoff-quit IPC with auth', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-quit-send-'));
  try {
    initCleanGitDir(dir);
    const spawned = [];
    const capture = createFetchCapture({
      [`http://127.0.0.1:${TEST_IPC_PORT}/sessions`]: [
        { name: 'jianmu-pm', pid: 1777, contextUsagePct: 95, cwd: dir, pendingOutgoing: 0 },
      ],
      [`http://127.0.0.1:${TEST_IPC_PORT}/recent-messages?name=jianmu-pm&since=3600000&limit=50`]: { messages: [] },
    });
    const watchdog = await startWatchdog({
      ipcPort: TEST_IPC_PORT,
      watchdogPort: 43180,
      intervalMs: 60_000,
      internalToken: 'watchdog-token',
      hubAuthToken: 'watchdog-token',
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
        cliProxy: async () => ({ ok: true, latencyMs: 1 }),
        hub: async () => ({ ok: true, latencyMs: 1 }),
        anthropic: async () => ({ ok: true, latencyMs: 1 }),
        dns: async () => ({ ok: true, latencyMs: 1 }),
      },
    });

    try {
      await waitFor(() => spawned.length === 1);
      const quitRequest = capture.requests.find((request) => request.url.endsWith('/send') && request.body?.topic === 'atomic-handoff');

      assert.equal(quitRequest.method, 'POST');
      assert.equal(quitRequest.headers.authorization, 'Bearer watchdog-token');
      assert.deepEqual(quitRequest.body, {
        from: 'network-watchdog',
        to: 'jianmu-pm',
        topic: 'atomic-handoff',
        content: 'atomic-handoff-quit',
      });
    } finally {
      await watchdog.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('watchdog sends prepare-rebind before quit IPC before spawn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-quit-order-'));
  try {
    initCleanGitDir(dir);
    const events = [];
    const capture = createFetchCapture({
      [`http://127.0.0.1:${TEST_IPC_PORT}/sessions`]: [
        { name: 'jianmu-pm', pid: 1777, contextUsagePct: 95, cwd: dir, pendingOutgoing: 0 },
      ],
      [`http://127.0.0.1:${TEST_IPC_PORT}/recent-messages?name=jianmu-pm&since=3600000&limit=50`]: { messages: [] },
    });
    const fetchImpl = async (url, init) => {
      const response = await capture.fetchImpl(url, init);
      const stringUrl = String(url);
      if (stringUrl.endsWith('/prepare-rebind')) events.push('prepare-rebind');
      if (stringUrl.endsWith('/send') && JSON.parse(init.body).topic === 'atomic-handoff') events.push('quit-ipc');
      return response;
    };
    const watchdog = await startWatchdog({
      ipcPort: TEST_IPC_PORT,
      watchdogPort: 43180,
      intervalMs: 60_000,
      internalToken: 'watchdog-token',
      hubAuthToken: 'watchdog-token',
      fetchImpl,
      createWatchdogIpcClientImpl: () => createIpcClientStub(),
      createServerImpl: createServerStub,
      setTimeoutImpl: () => null,
      clearTimeoutImpl: () => {},
      now: () => 1_000_000,
      ipcSpawn: async () => {
        events.push('spawn');
        return { spawned: true };
      },
      stuckDetectorEnabled: false,
      rateLimitCritiqueEnabled: false,
      handoverEnabled: true,
      handoverTickIntervalMs: 0,
      handoverConfig: { handoverDir: dir, handoverRepoPath: dir },
      probes: {
        cliProxy: async () => ({ ok: true, latencyMs: 1 }),
        hub: async () => ({ ok: true, latencyMs: 1 }),
        anthropic: async () => ({ ok: true, latencyMs: 1 }),
        dns: async () => ({ ok: true, latencyMs: 1 }),
      },
    });

    try {
      await waitFor(() => events.includes('spawn'));
      assert.deepEqual(events, ['prepare-rebind', 'quit-ipc', 'spawn']);
    } finally {
      await watchdog.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function initCleanGitDir(dir) {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  mkdirSync(join(dir, 'reports', 'codex-runs'), { recursive: true });
}
