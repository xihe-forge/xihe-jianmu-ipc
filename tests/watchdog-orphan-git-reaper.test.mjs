import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ORPHAN_GIT_REAPER_INTERVAL_MS,
  getOrphanGitReaperStatus,
  isMutatingGitCommand,
  isOrphanGitCandidate,
  resetOrphanGitReaperStatus,
  runOrphanGitReaper,
} from '../lib/watchdog/orphan-git-reaper.mjs';
import { createNetworkWatchdog } from '../bin/network-watchdog.mjs';

function createClock(start = 120_000) {
  let current = start;
  return {
    now: () => current,
    advance: (deltaMs) => {
      current += deltaMs;
      return current;
    },
  };
}

function gitProcess(overrides = {}) {
  return {
    pid: 4201,
    ppid: 4200,
    cmdline: 'C:\\Program Files\\Git\\cmd\\git.exe rev-parse HEAD',
    startTimeMs: 0,
    parentExists: false,
    ...overrides,
  };
}

function isReapableOrphan(cmdline) {
  return isOrphanGitCandidate(gitProcess({ cmdline, startTimeMs: 0, parentExists: false }), {
    nowMs: 120_000,
  });
}

test('orphan git reaper defaults to a 60s cycle and 60s minimum age', () => {
  assert.equal(DEFAULT_ORPHAN_GIT_REAPER_INTERVAL_MS, 60 * 1000);
  assert.equal(isOrphanGitCandidate(gitProcess({ startTimeMs: 59_999 }), { nowMs: 120_000 }), true);
  assert.equal(isOrphanGitCandidate(gitProcess({ startTimeMs: 60_000 }), { nowMs: 120_000 }), false);
});

test('orphan git reaper: parent gone + non-mutating git older than 60s is killed and recorded', async () => {
  resetOrphanGitReaperStatus();
  const killed = [];
  const result = await runOrphanGitReaper({
    now: () => 120_000,
    listProcesses: async () => [
      gitProcess({ pid: 4301, ppid: 1, cmdline: 'git rev-parse HEAD', startTimeMs: 0 }),
    ],
    killProcessImpl: async (pid) => killed.push(pid),
    stderr: () => {},
  });

  assert.deepEqual(killed, [4301]);
  assert.equal(result.reaped_count, 1);
  assert.deepEqual(result.reaped_pids, [4301]);
  assert.deepEqual(getOrphanGitReaperStatus(), {
    reaped_total: 1,
    last_cycle_count: 1,
    last_cycle_ts: 120_000,
    last_reaped_pids: [4301],
  });
});

test('orphan git reaper: normal running git under 60s is not killed', async () => {
  resetOrphanGitReaperStatus();
  const killed = [];
  const result = await runOrphanGitReaper({
    now: () => 120_000,
    listProcesses: async () => [
      gitProcess({ pid: 4302, cmdline: 'git status --short', startTimeMs: 61_000, parentExists: false }),
    ],
    killProcessImpl: async (pid) => killed.push(pid),
    stderr: () => {},
  });

  assert.deepEqual(killed, []);
  assert.equal(result.reaped_count, 0);
});

test('orphan git reaper: mutating git commands are never killed even when parent is gone', async () => {
  resetOrphanGitReaperStatus();
  const killed = [];
  const result = await runOrphanGitReaper({
    now: () => 120_000,
    listProcesses: async () => [
      gitProcess({ pid: 4303, cmdline: 'git push origin main', startTimeMs: 0, parentExists: false }),
      gitProcess({ pid: 4304, cmdline: 'git pull', startTimeMs: 0, parentExists: false }),
      gitProcess({ pid: 4305, cmdline: 'git commit -m fix', startTimeMs: 0, parentExists: false }),
      gitProcess({ pid: 4306, cmdline: 'git add .', startTimeMs: 0, parentExists: false }),
    ],
    killProcessImpl: async (pid) => killed.push(pid),
    stderr: () => {},
  });

  assert.deepEqual(killed, []);
  assert.equal(result.reaped_count, 0);
  assert.equal(isMutatingGitCommand('git push origin main'), true);
  assert.equal(isMutatingGitCommand('git pull'), true);
  assert.equal(isMutatingGitCommand('git commit -m fix'), true);
  assert.equal(isMutatingGitCommand('git add .'), true);
  assert.equal(isReapableOrphan('git push origin main'), false);
  assert.equal(isReapableOrphan('git pull'), false);
  assert.equal(isReapableOrphan('git commit -m fix'), false);
  assert.equal(isReapableOrphan('git add .'), false);
});

test('orphan git reaper: non-mutating git commands are reapable when orphaned and old', () => {
  assert.equal(isMutatingGitCommand('git remote get-url origin'), false);
  assert.equal(isMutatingGitCommand('git rev-parse HEAD'), false);
  assert.equal(isMutatingGitCommand('git status --short'), false);
  assert.equal(isMutatingGitCommand('git log --oneline -1'), false);
  assert.equal(isReapableOrphan('git remote get-url origin'), true);
  assert.equal(isReapableOrphan('git rev-parse HEAD'), true);
  assert.equal(isReapableOrphan('git status --short'), true);
  assert.equal(isReapableOrphan('git log --oneline -1'), true);
});

test('orphan git reaper: mutating matcher handles Windows git.exe command lines', () => {
  assert.equal(isMutatingGitCommand('C:\\Program Files\\Git\\cmd\\git.exe push origin master'), true);
  assert.equal(isMutatingGitCommand('"C:\\Program Files\\Git\\cmd\\git.exe" commit -m fix'), true);
  assert.equal(isMutatingGitCommand('C:\\Program Files\\Git\\cmd\\git.exe rev-parse HEAD'), false);
});

test('orphan git reaper: live parent protects a 90s query git child', async () => {
  resetOrphanGitReaperStatus();
  const killed = [];
  const result = await runOrphanGitReaper({
    now: () => 120_000,
    listProcesses: async () => [
      gitProcess({ pid: 4305, cmdline: 'git status --porcelain=v2', startTimeMs: 30_000, parentExists: true }),
    ],
    killProcessImpl: async (pid) => killed.push(pid),
    stderr: () => {},
  });

  assert.deepEqual(killed, []);
  assert.equal(result.reaped_count, 0);
});

test('network watchdog runs orphan-git-reaper independently and logs 5min status', async () => {
  const clock = createClock(0);
  const logs = [];
  const reaperCalls = [];
  const watchdog = createNetworkWatchdog({
    internalToken: 'watchdog-token',
    createWatchdogIpcClientImpl: () => ({
      async start() {},
      async stop() {},
      async sendMessage() { return true; },
    }),
    createServerImpl: () => ({
      once() {},
      off() {},
      listen() {},
      address() { return { port: 3180 }; },
      close(callback) { callback(); },
    }),
    now: clock.now,
    stderr: (line) => logs.push(line),
    orphanGitReaperIntervalMs: 60_000,
    orphanGitReaperStatusIntervalMs: 5 * 60_000,
    orphanGitReaperInitialLastTickAt: 0,
    orphanGitReaperInitialLastStatusAt: 0,
    orphanGitReaperNow: clock.now,
    orphanGitReaperImpl: async () => {
      reaperCalls.push(clock.now());
      return { reaped_count: 1, reaped_pids: [5010], cycle_ts: clock.now() };
    },
    probes: {
      cliProxy: async () => ({ ok: true }),
      hub: async () => ({ ok: true }),
      anthropic: async () => ({ ok: true }),
      dns: async () => ({ ok: true }),
    },
    fetchImpl: async () => ({ status: 200, json: async () => [] }),
    rateLimitCritiqueEnabled: false,
    handoverEnabled: false,
    stuckDetectorEnabled: false,
    zombiePidDetectorEnabled: false,
    idlePatrolEnabled: false,
  });

  await watchdog.runTick();
  clock.advance(60_000);
  await watchdog.runTick();
  clock.advance(4 * 60_000);
  await watchdog.runTick();

  assert.deepEqual(reaperCalls, [60_000, 300_000]);
  assert.deepEqual(watchdog.getLastOrphanGitReaperTickResult().reaped_pids, [5010]);
  assert.ok(logs.some((line) => line.includes('reaper status: reaped_total=')));
});
