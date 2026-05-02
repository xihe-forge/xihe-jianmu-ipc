import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateIdlePatrolSession } from '../lib/watchdog/idle-patrol.mjs';

function createManualNow(start = 5 * 60 * 1000) {
  let current = start;
  return {
    now: () => current,
    advance: (deltaMs) => {
      current += deltaMs;
      return current;
    },
  };
}

function baseSession(overrides = {}) {
  return {
    name: 'harness-mock',
    connectedAt: 1,
    cwd: process.cwd(),
    sessionId: 'session-1',
    ...overrides,
  };
}

function baseTranscript(overrides = {}) {
  return {
    lastUserText: '派 codex 实施并 ship',
    lastUserAt: 1,
    lastToolUseAt: 0,
    hasScheduleWakeup: false,
    lastStopReason: 'end_turn',
    baked: false,
    ...overrides,
  };
}

function createOptions({
  clock = createManualNow(),
  tasks = [
    { id: '1', status: 'pending', description: '写模块' },
    { id: '2', status: 'in_progress', description: 'self-test' },
  ],
  transcript = baseTranscript(),
  recentFileAt = 0,
  commitLastAt = 0,
  outbound = [],
} = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'idle-patrol-test-'));
  const sent = [];
  return {
    stateDir,
    sent,
    cleanup: () => rmSync(stateDir, { recursive: true, force: true }),
    options: {
      now: clock.now,
      stateDir,
      idleThresholdMs: 3 * 60 * 1000,
      bakedGraceMs: 5 * 60 * 1000,
      ackGraceMs: 5 * 60 * 1000,
      offlineGraceMs: 30 * 60 * 1000,
      l1DedupMs: 30 * 60 * 1000,
      l2AfterMs: 30 * 60 * 1000,
      l3AfterMs: 90 * 60 * 1000,
      watchdogSessionName: 'network-watchdog',
      harnessSessionName: 'harness',
      bossSessionName: 'boss',
      readTasksForSession: () => tasks,
      getActionableTasks: (items) => items.filter((item) => ['pending', 'in_progress'].includes(item.status)),
      analyzeTranscript: () => transcript,
      fetchOutboundMessages: async () => outbound,
      findRecentMtime: () => recentFileAt,
      countRecentCommits: () => ({ count: commitLastAt > 0 ? 1 : 0, lastAt: commitLastAt }),
      hasCodexProcessForCwd: () => false,
      ipcSend: async (message) => {
        sent.push(message);
      },
      fetchImpl: async () => ({ status: 200, json: async () => [] }),
      ipcPort: 43179,
      hubAuthToken: 'token',
      stderr: () => {},
    },
  };
}

test('idle patrol: 派工后 5min 无工具调用 + actionable=2 -> L1 nudge sent', async () => {
  const fixture = createOptions();
  try {
    const result = await evaluateIdlePatrolSession(baseSession(), fixture.options);
    assert.equal(result.action, 'nudge');
    assert.equal(result.level, 1);
    assert.equal(fixture.sent.length, 1);
    assert.match(fixture.sent[0].content, /\[idle-patrol L1]/);
    assert.match(fixture.sent[0].content, /actionable task: 1,2/);
  } finally {
    fixture.cleanup();
  }
});

test('idle patrol: 派工后 5min 内有 Edit/Bash 工具调用 -> 不 nudge', async () => {
  const clock = createManualNow();
  const fixture = createOptions({
    clock,
    transcript: baseTranscript({ lastToolUseAt: clock.now() - 60 * 1000 }),
  });
  try {
    const result = await evaluateIdlePatrolSession(baseSession(), fixture.options);
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, 'recent-action');
    assert.equal(fixture.sent.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('idle patrol: 派工后 5min 内 ScheduleWakeup -> 不 nudge', async () => {
  const fixture = createOptions({
    transcript: baseTranscript({ hasScheduleWakeup: true }),
  });
  try {
    const result = await evaluateIdlePatrolSession(baseSession(), fixture.options);
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, 'schedule-wakeup');
    assert.equal(fixture.sent.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('idle patrol: frozen session -> 不 nudge', async () => {
  const fixture = createOptions();
  try {
    const result = await evaluateIdlePatrolSession(baseSession({ frozen: true }), fixture.options);
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, 'frozen-dormant');
    assert.equal(fixture.sent.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('idle patrol: 收 L1 后 30min 无新动作 -> L2 nudge sent + 抄送 harness', async () => {
  const clock = createManualNow();
  const fixture = createOptions({ clock });
  try {
    const first = await evaluateIdlePatrolSession(baseSession(), fixture.options);
    assert.equal(first.level, 1);
    clock.advance(30 * 60 * 1000);
    const second = await evaluateIdlePatrolSession(baseSession(), fixture.options);
    assert.equal(second.action, 'nudge');
    assert.equal(second.level, 2);
    assert.equal(fixture.sent.length, 3);
    assert.equal(fixture.sent[1].to, 'harness-mock');
    assert.equal(fixture.sent[2].to, 'harness');
    assert.match(fixture.sent[1].content, /\[idle-patrol L2 escalate]/);
  } finally {
    fixture.cleanup();
  }
});

test('idle patrol: 收 L1 后 commit 了 -> escalation reset 到 0·不再 L2', async () => {
  const clock = createManualNow();
  const fixture = createOptions({ clock });
  try {
    const first = await evaluateIdlePatrolSession(baseSession(), fixture.options);
    assert.equal(first.level, 1);
    clock.advance(30 * 60 * 1000);
    fixture.options.countRecentCommits = () => ({ count: 1, lastAt: clock.now() });
    const second = await evaluateIdlePatrolSession(baseSession(), fixture.options);
    assert.equal(second.action, 'skip');
    assert.equal(second.reason, 'recent-action');
    assert.equal(fixture.sent.length, 1);
  } finally {
    fixture.cleanup();
  }
});
