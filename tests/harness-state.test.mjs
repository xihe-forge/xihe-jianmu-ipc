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

test('createHarnessStateMachine: critical + self-handover 触发 hard-signal down', () => {
  const transitions = [];
  const machine = createHarnessStateMachine({
    now: createNow(),
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
    ts: 2000,
  }]);
});

test('createHarnessStateMachine: silent-confirmed + disconnected 原因触发 soft-A down', () => {
  const machine = createHarnessStateMachine({
    now: createNow(),
  });

  machine.ingestProbeResult({
    error: 'silent-confirmed',
    reason: 'disconnected beyond grace',
  });

  assert.equal(machine.state, 'down');
  assert.equal(machine.lastReason, 'soft-A-ws-disconnect');
});

test('createHarnessStateMachine: silent-confirmed + 在线静默触发 soft-B down', () => {
  const machine = createHarnessStateMachine({
    now: createNow(),
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
  const machine = createHarnessStateMachine({
    now: createNow(),
  });

  machine.ingestHeartbeat({ pct: 56, state: 'warn', nextAction: 'continue' });
  assert.equal(machine.state, 'warn');
  assert.equal(machine.warnCount, 1);

  machine.ingestHeartbeat({ pct: 20, state: 'active', nextAction: 'continue' });
  assert.equal(machine.state, 'ok');
  assert.equal(machine.warnCount, 0);
  assert.equal(machine.lastReason, 'recovered');
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
