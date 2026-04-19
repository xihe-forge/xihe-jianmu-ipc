import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarnessStateMachine } from '../lib/harness-state.mjs';

function createNow(start = 0, step = 1_000) {
  let current = start;
  return () => {
    current += step;
    return current;
  };
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

test('createHarnessStateMachine: critical + self-handover 触发 hard-signal down', () => {
  const transitions = [];
  const machine = createHarnessStateMachine({
    now: createNow(),
    coldStartGraceMs: 0,
    onTransition: (transition) => transitions.push(transition),
  });

  machine.ingestHeartbeat({
    pct: 70,
    state: 'critical',
    nextAction: 'self-handover',
  });

  assert.equal(machine.state, 'down');
  assert.equal(machine.lastReason, 'hard-signal');
  assert.deepEqual(transitions, [{
    from: 'ok',
    to: 'down',
    reason: 'hard-signal',
    contextPct: 70,
    warnCount: 0,
    nextAction: 'self-handover',
    ts: 3000,
  }]);
  assert.equal(machine.lastHeartbeatAt, 2000);
});

test('createHarnessStateMachine: silent-confirmed + disconnected 原因触发 soft-A down', () => {
  const now = createNow();
  const machine = createHarnessStateMachine({
    now,
    coldStartGraceMs: 0,
  });

  machine.ingestProbeResult({
    error: 'silent-confirmed',
    reason: 'disconnected beyond grace',
  });

  assert.equal(machine.state, 'down');
  assert.equal(machine.lastReason, 'soft-A-ws-disconnect');
  assert.equal(machine.lastProbeAt, 2000);
  assert.equal(machine.lastProbeError, 'silent-confirmed');
});

test('createHarnessStateMachine: silent-confirmed + 在线静默触发 soft-B down', () => {
  const machine = createHarnessStateMachine({
    now: createNow(),
    coldStartGraceMs: 0,
  });

  machine.ingestProbeResult({
    error: 'silent-confirmed',
    reason: 'online but silent',
  });

  assert.equal(machine.state, 'down');
  assert.equal(machine.lastReason, 'soft-B-silent');
});

test('createHarnessStateMachine: warn 连续 3 次且无 compact 时触发 down', () => {
  const machine = createHarnessStateMachine({
    now: createNow(),
    warnWithoutCompactCount: 3,
  });

  machine.ingestHeartbeat({ pct: 56, state: 'warn', nextAction: 'continue' });
  machine.ingestHeartbeat({ pct: 57, state: 'warn', nextAction: 'continue' });
  machine.ingestHeartbeat({ pct: 58, state: 'warn', nextAction: 'continue' });

  assert.equal(machine.state, 'down');
  assert.equal(machine.warnCount, 3);
  assert.equal(machine.lastReason, 'warn-without-compact');
});

test('createHarnessStateMachine: ok -> warn -> active 可恢复到 ok', () => {
  const now = createNow();
  const machine = createHarnessStateMachine({
    now,
  });

  machine.ingestHeartbeat({ pct: 56, state: 'warn', nextAction: 'continue' });
  assert.equal(machine.state, 'warn');
  assert.equal(machine.warnCount, 1);
  assert.equal(machine.lastHeartbeatAt, 2000);

  machine.ingestHeartbeat({ pct: 20, state: 'active', nextAction: 'continue' });
  assert.equal(machine.state, 'ok');
  assert.equal(machine.warnCount, 0);
  assert.equal(machine.lastReason, 'recovered');
  assert.equal(machine.lastHeartbeatAt, 4000);
});

test('createHarnessStateMachine: compact 会重置 warnCount，critical 无动作时进入 degraded', () => {
  const machine = createHarnessStateMachine({
    now: createNow(),
  });

  machine.ingestHeartbeat({ pct: 56, state: 'warn', nextAction: 'continue' });
  assert.equal(machine.warnCount, 1);

  machine.ingestHeartbeat({ pct: 57, state: 'warn', nextAction: 'compact' });
  assert.equal(machine.state, 'warn');
  assert.equal(machine.warnCount, 0);

  machine.ingestHeartbeat({ pct: 70, state: 'critical', nextAction: 'continue' });
  assert.equal(machine.state, 'degraded');
  assert.equal(machine.lastReason, 'context-critical-no-action');
});

test('createHarnessStateMachine: cold-start 首条 hard-signal heartbeat 不会被 grace 拦成 degraded', () => {
  const clock = createManualNow();
  const transitions = [];
  const machine = createHarnessStateMachine({
    now: clock.now,
    coldStartGraceMs: 120_000,
    onTransition: (transition) => transitions.push(transition),
  });

  machine.ingestHeartbeat({
    pct: 70,
    state: 'critical',
    nextAction: 'self-handover',
  });

  assert.equal(machine.state, 'down');
  assert.equal(machine.lastReason, 'hard-signal');
  assert.equal(machine.aliveSignalReceived, true);
  assert.equal(machine.lastAliveSignalSource, 'heartbeat');
  assert.deepEqual(transitions, [{
    from: 'ok',
    to: 'down',
    reason: 'hard-signal',
    contextPct: 70,
    warnCount: 0,
    nextAction: 'self-handover',
    ts: 0,
  }]);
});

test('createHarnessStateMachine: cold-start 内普通 warn heartbeat 仍不触发 down，但会先 mark alive', () => {
  const clock = createManualNow();
  const machine = createHarnessStateMachine({
    now: clock.now,
    coldStartGraceMs: 120_000,
  });

  machine.ingestHeartbeat({
    pct: 60,
    state: 'warn',
    nextAction: 'compact',
  });

  assert.equal(machine.state, 'warn');
  assert.equal(machine.aliveSignalReceived, true);
  assert.equal(machine.lastAliveSignalSource, 'heartbeat');
});

test('createHarnessStateMachine: cold-start 先收到 active heartbeat 后，后续 hard-signal 可正常 down', () => {
  const clock = createManualNow();
  const transitions = [];
  const machine = createHarnessStateMachine({
    now: clock.now,
    coldStartGraceMs: 120_000,
    onTransition: (transition) => transitions.push(transition),
  });

  machine.ingestHeartbeat({
    pct: 20,
    state: 'active',
    nextAction: 'continue',
  });
  clock.advance(1_000);
  machine.ingestHeartbeat({
    pct: 70,
    state: 'critical',
    nextAction: 'self-handover',
  });

  assert.equal(machine.state, 'down');
  assert.equal(machine.lastReason, 'hard-signal');
  assert.equal(machine.aliveSignalReceived, true);
  assert.equal(machine.lastAliveSignalSource, 'heartbeat');
  assert.deepEqual(transitions, [{
    from: 'ok',
    to: 'down',
    reason: 'hard-signal',
    contextPct: 70,
    warnCount: 0,
    nextAction: 'self-handover',
    ts: 1_000,
  }]);
});

test('createHarnessStateMachine: cold-start grace 过后无活性信号时，hard-signal 正常 down', () => {
  const clock = createManualNow();
  const machine = createHarnessStateMachine({
    now: clock.now,
    coldStartGraceMs: 120_000,
  });

  clock.advance(120_000);
  machine.ingestProbeResult({
    error: 'silent-confirmed',
    reason: 'online but silent',
  });

  assert.equal(machine.state, 'down');
  assert.equal(machine.lastReason, 'soft-B-silent');
  assert.equal(machine.aliveSignalReceived, false);
});

test('createHarnessStateMachine: cold-start 内先收到 pong 活性信号后，hard-signal 可正常 down', () => {
  const clock = createManualNow();
  const machine = createHarnessStateMachine({
    now: clock.now,
    coldStartGraceMs: 120_000,
  });

  clock.advance(5_000);
  machine.markAliveSignal('pong');
  clock.advance(1_000);
  machine.ingestProbeResult({
    error: 'silent-confirmed',
    reason: 'disconnected beyond grace',
  });

  assert.equal(machine.state, 'down');
  assert.equal(machine.lastReason, 'soft-A-ws-disconnect');
  assert.equal(machine.lastAliveSignalSource, 'pong');
});

test('createHarnessStateMachine: coldStartGraceMs=0 时回退为旧行为', () => {
  const machine = createHarnessStateMachine({
    now: createManualNow().now,
    coldStartGraceMs: 0,
  });

  machine.ingestProbeResult({
    error: 'silent-confirmed',
    reason: 'online but silent',
  });

  assert.equal(machine.state, 'down');
  assert.equal(machine.lastReason, 'soft-B-silent');
});

test('createHarnessStateMachine: 过旧 heartbeat ts 会被 stale-heartbeat 过滤', () => {
  const startedAt = Date.parse('2026-04-20T03:14:00+08:00');
  const clock = createManualNow(startedAt);
  const transitions = [];
  const machine = createHarnessStateMachine({
    now: clock.now,
    onTransition: (transition) => transitions.push(transition),
  });

  const result = machine.ingestHeartbeat({
    pct: 70,
    state: 'critical',
    nextAction: 'self-handover',
    ts: startedAt - 61_000,
  });

  assert.deepEqual(result, {
    ignored: true,
    reason: 'stale-heartbeat',
    heartbeatTs: startedAt - 61_000,
    startedAtBuffer: startedAt - 60_000,
  });
  assert.equal(machine.state, 'ok');
  assert.equal(machine.lastReason, 'init');
  assert.equal(machine.lastHeartbeatAt, null);
  assert.equal(machine.aliveSignalReceived, false);
  assert.deepEqual(transitions, []);
});

test('createHarnessStateMachine: invalid heartbeat ts(null/NaN) 不触发 transition', () => {
  const startedAt = Date.parse('2026-04-20T03:14:00+08:00');

  for (const invalidTs of [null, Number.NaN]) {
    const clock = createManualNow(startedAt);
    const machine = createHarnessStateMachine({
      now: clock.now,
    });

    const result = machine.ingestHeartbeat({
      pct: 70,
      state: 'critical',
      nextAction: 'self-handover',
      ts: invalidTs,
    });

    assert.equal(result.ignored, true);
    assert.equal(result.reason, 'invalid-ts-format');
    if (invalidTs === null) {
      assert.equal(result.heartbeatTs, null);
    } else {
      assert.equal(Number.isNaN(result.heartbeatTs), true);
    }
    assert.equal(machine.state, 'ok');
    assert.equal(machine.lastHeartbeatAt, null);
    assert.equal(machine.aliveSignalReceived, false);
  }
});

test('createHarnessStateMachine: 新鲜 heartbeat ts 可正常驱动 transition', () => {
  const startedAt = Date.parse('2026-04-20T03:14:00+08:00');
  const clock = createManualNow(startedAt);
  const transitions = [];
  const machine = createHarnessStateMachine({
    now: clock.now,
    coldStartGraceMs: 120_000,
    onTransition: (transition) => transitions.push(transition),
  });

  const result = machine.ingestHeartbeat({
    pct: 70,
    state: 'critical',
    nextAction: 'self-handover',
    ts: startedAt,
  });

  assert.deepEqual(result, {
    ignored: false,
    heartbeatTs: startedAt,
  });
  assert.equal(machine.state, 'down');
  assert.equal(machine.lastReason, 'hard-signal');
  assert.equal(machine.lastHeartbeatAt, startedAt);
  assert.equal(machine.aliveSignalReceived, true);
  assert.deepEqual(transitions, [{
    from: 'ok',
    to: 'down',
    reason: 'hard-signal',
    contextPct: 70,
    warnCount: 0,
    nextAction: 'self-handover',
    ts: startedAt,
  }]);
});
