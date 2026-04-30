import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  closeWebSocket,
  connectSession,
  httpRequest,
  sleep,
  startHub,
  stopHub,
  waitForWebSocketMessage,
} from '../helpers/hub-fixture.mjs';
import { TEMP_ROOT } from '../helpers/temp-path.mjs';
import { startWatchdog } from '../../bin/network-watchdog.mjs';

const TEST_TIMEOUT = 10_000;

test('watchdog e2e dummy: pct>=90 and three clean signals auto-spawn a new lineage', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'watchdog-handover-dummy' });
  const cwd = mkdtempSync(join(TEMP_ROOT, 'watchdog-handover-dummy-'));
  const name = `dummy-handover-test-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  let watchdog = null;
  let oldSession = null;
  let oldLineage = null;
  let newLineage = null;

  try {
    execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
    mkdirSync(join(cwd, 'reports', 'codex-runs'), { recursive: true });

    oldSession = await connectSession(hub.port, name, {
      register: {
        pid: process.pid,
        cwd,
        contextUsagePct: 95,
        pendingOutgoing: 0,
      },
    });

    const initialSessions = await getSessions(hub.port);
    const initialDummy = initialSessions.find((session) => session.name === name);
    assert.equal(initialDummy?.contextUsagePct, 95);
    assert.equal(initialDummy?.pendingOutgoing, 0);

    const oldQuitAndRename = waitForWebSocketMessage(
      oldSession,
      (message) => message.type === 'message'
        && message.topic === 'atomic-handoff'
        && message.content === 'atomic-handoff-quit',
    ).then(async () => {
      await closeWebSocket(oldSession);
      oldSession = null;
      oldLineage = await connectSession(hub.port, `${name}-old`, {
        register: {
          pid: process.pid,
          cwd,
          contextUsagePct: 1,
          pendingOutgoing: 0,
        },
      });
    });

    const spawned = [];
    const logs = [];
    watchdog = await startWatchdog({
      ipcPort: hub.port,
      watchdogPort: randomPort(),
      intervalMs: 100,
      internalToken: 'watchdog-test-token',
      stderr: (line) => logs.push(line),
      ipcSpawn: async (args) => {
        spawned.push(args);
        await oldQuitAndRename;
        newLineage = await connectSession(hub.port, args.name, {
          register: {
            pid: process.pid,
            cwd: args.cwd,
            contextUsagePct: 1,
            pendingOutgoing: 0,
          },
        });
        return { spawned: true, sentinel: 'dummy-lineage-online' };
      },
      stuckDetectorEnabled: false,
      zombiePidDetectorEnabled: false,
      rateLimitCritiqueEnabled: false,
      handoverEnabled: true,
      handoverDryRun: false,
      handoverTickIntervalMs: 0,
      handoverConfig: { handoverDir: join(cwd, 'handover'), handoverRepoPath: cwd },
      probes: {
        cliProxy: async () => ({ ok: true, latencyMs: 1 }),
        hub: async () => ({ ok: true, latencyMs: 1 }),
        anthropic: async () => ({ ok: true, latencyMs: 1 }),
        dns: async () => ({ ok: true, latencyMs: 1 }),
      },
    });

    await waitFor(() => spawned.length === 1);
    await waitFor(async () => {
      const sessions = await getSessions(hub.port);
      return sessions.some((session) => session.name === name)
        && sessions.some((session) => session.name === `${name}-old`);
    });

    const sessions = await getSessions(hub.port);
    assert.equal(spawned[0].name, name);
    assert.equal(spawned[0].cwd, cwd);
    assert.match(spawned[0].task, /ADR-010 context-usage auto handover cold start/);
    assert.ok(sessions.some((session) => session.name === name), 'new lineage is online');
    assert.ok(sessions.some((session) => session.name === `${name}-old`), 'old lineage is online under -old');
    assert.ok(logs.some((line) => line.includes(`context usage handover triggered: ${name} pct=95`)));
  } finally {
    await watchdog?.stop();
    await closeWebSocket(newLineage);
    await closeWebSocket(oldLineage);
    await closeWebSocket(oldSession);
    await stopHub(hub);
    rmSync(cwd, { recursive: true, force: true });
  }
});

async function getSessions(port) {
  const response = await httpRequest(port, { method: 'GET', path: '/sessions' });
  assert.equal(response.statusCode, 200);
  assert.ok(Array.isArray(response.body));
  return response.body;
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(25);
  }
  assert.fail('timed out waiting for watchdog dummy handover');
}

function randomPort() {
  return Math.floor(Math.random() * 10_000 + 40_000);
}
