import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_ACK_DEDUP_MS,
  DEFAULT_IDLE_PATROL_INTERVAL_MS,
  DEFAULT_IDLE_THRESHOLD_MS,
  analyzeTranscript,
  createIdlePatrol,
  evaluateIdlePatrolSession,
  getAckDedupLastAt,
  isHoldTask,
  recordAckDedup,
} from '../lib/watchdog/idle-patrol.mjs';

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
      ackDedupMs: 60 * 60 * 1000,
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
      isHoldTask,
      getAckDedupLastAt,
      recordAckDedup,
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

test('idle patrol defaults: threshold/interval 30min and ack dedup 60min', () => {
  assert.equal(DEFAULT_IDLE_THRESHOLD_MS, 30 * 60 * 1000);
  assert.equal(DEFAULT_IDLE_PATROL_INTERVAL_MS, 30 * 60 * 1000);
  assert.equal(DEFAULT_ACK_DEDUP_MS, 60 * 60 * 1000);
});

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
    fixture.options.ackDedupMs = 0;
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

test('idle patrol: L1 nudge 后写持久 ack dedup，60min 内同 session/topic 跳过', async () => {
  const clock = createManualNow();
  const fixture = createOptions({ clock });
  try {
    const first = await evaluateIdlePatrolSession(baseSession(), fixture.options);
    assert.equal(first.action, 'nudge');
    assert.equal(fixture.sent.length, 1);

    const dedupPath = join(fixture.stateDir, 'ack-dedup-state.json');
    assert.equal(existsSync(dedupPath), true);
    const dedupState = JSON.parse(readFileSync(dedupPath, 'utf8'));
    assert.equal(dedupState['harness-mock:idle-patrol'].last_nudge_at, clock.now());

    clock.advance(59 * 60 * 1000);
    const second = await evaluateIdlePatrolSession(baseSession(), fixture.options);
    assert.equal(second.action, 'skip');
    assert.match(second.reason, /dedup/);
    assert.equal(fixture.sent.length, 1);

    clock.advance(1 * 60 * 1000);
    const third = await evaluateIdlePatrolSession(baseSession(), fixture.options);
    assert.equal(third.action, 'nudge');
    assert.equal(third.level, 2);
    assert.equal(fixture.sent.length, 3);
  } finally {
    fixture.cleanup();
  }
});

test('idle patrol: multi-round dedup persists and escalates across dry-run intervals', async () => {
  const clock = createManualNow(100 * 60 * 1000);
  let transcript = baseTranscript({ lastUserAt: 1 });
  const fixture = createOptions({
    clock,
    transcript,
    sessionGitPath: null,
  });
  try {
    fixture.options.analyzeTranscript = () => transcript;

    const first = await evaluateIdlePatrolSession(baseSession({ name: 'xihe-ai' }), fixture.options);
    assert.equal(first.action, 'nudge');
    assert.equal(first.level, 1);

    transcript = baseTranscript({
      lastUserText: first.content,
      lastUserAt: 1,
    });
    for (const minutes of [3, 7, 15]) {
      clock.advance(minutes * 60 * 1000);
      const result = await evaluateIdlePatrolSession(baseSession({ name: 'xihe-ai' }), fixture.options);
      assert.equal(result.action, 'skip');
      assert.match(result.reason, /dedup/);
    }

    clock.advance(35 * 60 * 1000);
    const l2 = await evaluateIdlePatrolSession(baseSession({ name: 'xihe-ai' }), fixture.options);
    assert.equal(l2.action, 'nudge');
    assert.equal(l2.level, 2);

    transcript = baseTranscript({
      lastUserText: l2.content,
      lastUserAt: 1,
    });
    clock.advance(70 * 60 * 1000);
    const l3 = await evaluateIdlePatrolSession(baseSession({ name: 'xihe-ai' }), fixture.options);
    assert.equal(l3.action, 'nudge');
    assert.equal(l3.level, 3);
    assert.equal(fixture.sent.length, 4);
  } finally {
    fixture.cleanup();
  }
});

test('idle patrol: harness/xihe-ai spam traces dedup to one nudge inside 30min', async () => {
  for (const [name, offsets] of [
    ['harness', [0, 14]],
    ['xihe-ai', [0, 7, 13, 17]],
  ]) {
    const clock = createManualNow(100 * 60 * 1000);
    const fixture = createOptions({ clock, sessionGitPath: null });
    try {
      let transcript = baseTranscript({ lastUserAt: 1 });
      fixture.options.analyzeTranscript = () => transcript;

      const first = await evaluateIdlePatrolSession(baseSession({ name }), fixture.options);
      assert.equal(first.action, 'nudge');
      assert.equal(first.level, 1);
      transcript = baseTranscript({ lastUserText: first.content, lastUserAt: 1 });

      let previous = offsets[0];
      for (const offset of offsets.slice(1)) {
        clock.advance((offset - previous) * 60 * 1000);
        previous = offset;
        const result = await evaluateIdlePatrolSession(baseSession({ name }), fixture.options);
        assert.equal(result.action, 'skip');
        assert.match(result.reason, /dedup/);
      }
      assert.equal(fixture.sent.length, 1);
    } finally {
      fixture.cleanup();
    }
  }
});

test('idle patrol: hold-aware task description 含 hold 或 等 -> skip hold-task', async () => {
  for (const description of ['hold task 等老板 verify CI 24h+', '等老板 verify CI 24h+']) {
    const fixture = createOptions({
      tasks: [{ id: 'hold-1', status: 'pending', description }],
    });
    try {
      const result = await evaluateIdlePatrolSession(baseSession(), fixture.options);
      assert.equal(result.action, 'skip');
      assert.equal(result.reason, 'hold-task');
      assert.equal(fixture.sent.length, 0);
    } finally {
      fixture.cleanup();
    }
  }
});

test('idle patrol: hold-aware status/metadata hold_reason -> skip hold-task', async () => {
  for (const task of [
    { id: 'hold-status', status: 'hold', description: '等外部 trigger' },
    { id: 'hold-meta', status: 'pending', description: 'CI verify', metadata: { hold_reason: 'waiting for boss' } },
  ]) {
    const fixture = createOptions({ tasks: [task] });
    try {
      const result = await evaluateIdlePatrolSession(baseSession(), fixture.options);
      assert.equal(result.action, 'skip');
      assert.equal(result.reason, 'hold-task');
      assert.equal(fixture.sent.length, 0);
    } finally {
      fixture.cleanup();
    }
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
      { timestamp: '2026-05-02T10:02:00.000Z', type: 'user', message: { role: 'user', content: '[idle-patrol L1] harness 你 30min 无工具调用' } },
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
