import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeTranscript, createIdlePatrol, evaluateIdlePatrolSession } from '../lib/watchdog/idle-patrol.mjs';

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
  sessionGitPath = process.cwd(),
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
      maxTrustedIdleMs: 7 * 24 * 60 * 60 * 1000,
      watchdogSessionName: 'network-watchdog',
      harnessSessionName: 'harness',
      bossSessionName: 'boss',
      readTasksForSession: () => tasks,
      getActionableTasks: (items) => items.filter((item) => ['pending', 'in_progress'].includes(item.status)),
      analyzeTranscript: () => transcript,
      fetchOutboundMessages: async () => outbound,
      findRecentMtime: () => recentFileAt,
      resolveSessionGitPath: () => sessionGitPath,
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

test('idle patrol: shared cwd mtime 不作为 session recent-action 信号', async () => {
  const clock = createManualNow();
  const fixture = createOptions({
    clock,
    recentFileAt: clock.now(),
    sessionGitPath: null,
  });
  try {
    const result = await evaluateIdlePatrolSession(baseSession(), fixture.options);
    assert.equal(result.action, 'nudge');
    assert.equal(result.level, 1);
    assert.equal(fixture.sent.length, 1);
  } finally {
    fixture.cleanup();
  }
});

test('idle patrol: transcript 缺失/时间不可用 -> 不用 epoch 0 误报 5 万小时', async () => {
  const fixture = createOptions({
    transcript: baseTranscript({
      lastUserText: '',
      lastUserAt: 0,
      lastToolUseAt: 0,
    }),
    sessionGitPath: null,
  });
  try {
    const result = await evaluateIdlePatrolSession(baseSession(), fixture.options);
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, 'untrusted-action-time');
    assert.equal(fixture.sent.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('idle patrol: action time 超过 7 天 sanity window -> 不 nudge', async () => {
  const clock = createManualNow(8 * 24 * 60 * 60 * 1000);
  const fixture = createOptions({
    clock,
    transcript: baseTranscript({
      lastUserAt: 1,
      lastToolUseAt: 0,
    }),
    sessionGitPath: null,
  });
  try {
    const result = await evaluateIdlePatrolSession(baseSession(), fixture.options);
    assert.equal(result.action, 'skip');
    assert.equal(result.reason, 'untrusted-action-time');
    assert.equal(fixture.sent.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('idle patrol: Hub session count diff >= 2 只 warning 并继续 tick', async () => {
  const warnings = [];
  const patrol = createIdlePatrol({
    sessions: [],
    expectedSessionCount: 24,
    fetchImpl: async (url) => {
      assert.match(String(url), /\/sessions$/);
      return { status: 200, json: async () => Array.from({ length: 21 }, (_, index) => ({ name: `s${index}` })) };
    },
    stderr: (line) => warnings.push(String(line)),
  });

  const results = await patrol.tick();
  assert.deepEqual(results, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /connected=21, expected=24/);
});

test('idle patrol: transcript 空 user/tool-result 不会遮蔽后续工具行动信号', () => {
  const root = mkdtempSync(join(tmpdir(), 'idle-patrol-transcript-'));
  try {
    const transcriptPath = join(root, 'session.jsonl');
    const lines = [
      { timestamp: '2026-05-02T10:00:00.000Z', type: 'user', message: { role: 'user', content: '派 codex 实施' } },
      { timestamp: '2026-05-02T10:01:00.000Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash' }] } },
      { timestamp: '2026-05-02T10:01:01.000Z', type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'command output' }] } },
      { timestamp: '2026-05-02T10:01:02.000Z', type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'ScheduleWakeup' }] } },
      { timestamp: '2026-05-02T10:01:03.000Z', type: 'user', message: { role: 'user', content: '' } },
    ];
    mkdirSync(root, { recursive: true });
    writeFileSync(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');

    const result = analyzeTranscript({ transcriptPath }, { bakedGraceMs: 0 });
    assert.equal(result.lastUserText, '派 codex 实施');
    assert.equal(result.lastToolUseAt, Date.parse('2026-05-02T10:01:02.000Z'));
    assert.equal(result.hasScheduleWakeup, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
