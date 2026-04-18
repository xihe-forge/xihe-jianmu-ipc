import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStateMachine } from '../lib/network-state.mjs';

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

function createTickNow(start = 0) {
  let current = start;
  return () => {
    current += 1;
    return current;
  };
}

test('createStateMachine: 初始状态为 OK', () => {
  const machine = createStateMachine({
    probes: {
      cliProxy: async () => ok(),
      hub: async () => ok(),
    },
  });

  assert.deepEqual(machine.getState(), {
    state: 'OK',
    failing: [],
    consecutive: { cliProxy: 0, hub: 0 },
    lastChecks: {},
    history: [],
  });
});

test('createStateMachine: 1 项异常 1 次进入 degraded', async () => {
  const transitions = [];
  const machine = createStateMachine({
    probes: {
      cliProxy: createSequenceProbe([fail('HTTP 503', 5)]),
      hub: createSequenceProbe([ok(2)]),
    },
    onTransition: (transition) => transitions.push(transition),
    now: createTickNow(),
  });

  const state = await machine.tick();

  assert.equal(state.state, 'degraded');
  assert.deepEqual(state.failing, ['cliProxy']);
  assert.deepEqual(state.consecutive, { cliProxy: 1, hub: 0 });
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].from, 'OK');
  assert.equal(transitions[0].to, 'degraded');
  assert.deepEqual(transitions[0].failing, ['cliProxy']);
});

test('createStateMachine: 1 项连续 3 次异常后进入 down', async () => {
  const transitions = [];
  const machine = createStateMachine({
    probes: {
      cliProxy: createSequenceProbe([fail('HTTP 503'), fail('HTTP 503'), fail('HTTP 503')]),
      hub: createSequenceProbe([ok(), ok(), ok()]),
    },
    onTransition: (transition) => transitions.push({ from: transition.from, to: transition.to }),
    now: createTickNow(),
  });

  await machine.tick();
  await machine.tick();
  const state = await machine.tick();

  assert.equal(state.state, 'down');
  assert.deepEqual(state.failing, ['cliProxy']);
  assert.deepEqual(state.consecutive, { cliProxy: 3, hub: 0 });
  assert.deepEqual(transitions, [
    { from: 'OK', to: 'degraded' },
    { from: 'degraded', to: 'down' },
  ]);
});

test('createStateMachine: 2 项同时异常时立刻 down', async () => {
  const transitions = [];
  const machine = createStateMachine({
    probes: {
      cliProxy: createSequenceProbe([fail('HTTP 503')]),
      hub: createSequenceProbe([fail('HTTP 503')]),
      dns: createSequenceProbe([ok()]),
    },
    onTransition: (transition) => transitions.push({ from: transition.from, to: transition.to }),
    now: createTickNow(),
  });

  const state = await machine.tick();

  assert.equal(state.state, 'down');
  assert.deepEqual(state.failing.sort(), ['cliProxy', 'hub']);
  assert.deepEqual(transitions, [{ from: 'OK', to: 'down' }]);
});

test('createStateMachine: down 后所有项仅恢复 1 次仍保持 down', async () => {
  const transitions = [];
  const machine = createStateMachine({
    probes: {
      cliProxy: createSequenceProbe([fail('HTTP 503'), ok()]),
      hub: createSequenceProbe([fail('HTTP 503'), ok()]),
    },
    onTransition: (transition) => transitions.push({ from: transition.from, to: transition.to }),
    now: createTickNow(),
  });

  await machine.tick();
  const state = await machine.tick();

  assert.equal(state.state, 'down');
  assert.deepEqual(state.failing, []);
  assert.deepEqual(transitions, [{ from: 'OK', to: 'down' }]);
});

test('createStateMachine: down 后所有项连续 3 次 OK 才回到 OK', async () => {
  const transitions = [];
  const machine = createStateMachine({
    probes: {
      cliProxy: createSequenceProbe([fail('HTTP 503'), ok(), ok(), ok()]),
      hub: createSequenceProbe([fail('HTTP 503'), ok(), ok(), ok()]),
    },
    onTransition: (transition) => transitions.push({ from: transition.from, to: transition.to }),
    now: createTickNow(),
  });

  await machine.tick();
  await machine.tick();
  await machine.tick();
  const state = await machine.tick();

  assert.equal(state.state, 'OK');
  assert.deepEqual(state.failing, []);
  assert.deepEqual(transitions, [
    { from: 'OK', to: 'down' },
    { from: 'down', to: 'OK' },
  ]);
});

test('createStateMachine: history 默认只保留最近 10 次', async () => {
  const machine = createStateMachine({
    probes: {
      hub: createSequenceProbe(new Array(12).fill(ok())),
    },
    now: createTickNow(),
  });

  for (let index = 0; index < 12; index += 1) {
    await machine.tick();
  }

  const state = machine.getState();
  assert.equal(state.history.length, 10);
  assert.equal(state.history[0].ts, 3);
  assert.equal(state.history[9].ts, 12);
});

test('createStateMachine: onTransition 只在真实状态变化时触发', async () => {
  const transitions = [];
  const machine = createStateMachine({
    probes: {
      cliProxy: createSequenceProbe([fail('HTTP 503'), fail('HTTP 503'), ok(), ok()]),
      hub: createSequenceProbe([ok(), ok(), ok(), ok()]),
    },
    onTransition: (transition) => transitions.push({ from: transition.from, to: transition.to }),
    now: createTickNow(),
  });

  await machine.tick();
  await machine.tick();
  await machine.tick();
  await machine.tick();

  assert.deepEqual(transitions, [
    { from: 'OK', to: 'degraded' },
    { from: 'degraded', to: 'OK' },
  ]);
});

test('createStateMachine: probe rejection 会按失败结果记录并进入 degraded', async () => {
  const transitions = [];
  const machine = createStateMachine({
    probes: {
      cliProxy: async () => {
        throw new Error('boom');
      },
      hub: createSequenceProbe([ok(2)]),
    },
    onTransition: (transition) => transitions.push({ from: transition.from, to: transition.to }),
    now: createTickNow(),
  });

  const state = await machine.tick();

  assert.equal(state.state, 'degraded');
  assert.deepEqual(state.failing, ['cliProxy']);
  assert.deepEqual(state.consecutive, { cliProxy: 1, hub: 0 });
  assert.equal(state.lastChecks.cliProxy.ok, false);
  assert.equal(state.lastChecks.cliProxy.latencyMs, 0);
  assert.match(state.lastChecks.cliProxy.error, /boom/);
  assert.deepEqual(transitions, [{ from: 'OK', to: 'degraded' }]);
});

test('createStateMachine: reset 会清空状态并从初始条件重新计算', async () => {
  const machine = createStateMachine({
    probes: {
      cliProxy: createSequenceProbe([
        fail('HTTP 503'),
        fail('HTTP 503'),
        fail('HTTP 503'),
        fail('HTTP 503'),
        fail('HTTP 503'),
        fail('HTTP 503'),
        fail('HTTP 503'),
        ok(),
        ok(),
        fail('HTTP 503'),
        ok(),
        ok(),
        ok(),
      ]),
      hub: createSequenceProbe([
        ok(),
        ok(),
        ok(),
        ok(),
        ok(),
        ok(),
        fail('HTTP 503'),
        ok(),
        ok(),
        fail('HTTP 503'),
        ok(),
        ok(),
        ok(),
      ]),
    },
    now: createTickNow(),
  });

  for (let index = 0; index < 5; index += 1) {
    await machine.tick();
  }

  const beforeReset = machine.getState();
  assert.equal(beforeReset.state, 'down');
  assert.equal(beforeReset.history.length, 5);
  assert.deepEqual(beforeReset.consecutive, { cliProxy: 5, hub: 0 });

  machine.reset();

  assert.deepEqual(machine.getState(), {
    state: 'OK',
    failing: [],
    consecutive: { cliProxy: 0, hub: 0 },
    lastChecks: {},
    history: [],
  });

  const degradedAfterReset = await machine.tick();
  assert.equal(degradedAfterReset.state, 'degraded');
  assert.deepEqual(degradedAfterReset.consecutive, { cliProxy: 1, hub: 0 });

  await machine.tick();
  await machine.tick();
  await machine.tick();

  machine.reset();

  assert.deepEqual(machine.getState(), {
    state: 'OK',
    failing: [],
    consecutive: { cliProxy: 0, hub: 0 },
    lastChecks: {},
    history: [],
  });

  await machine.tick();

  const firstRecoveryTick = await machine.tick();
  assert.equal(firstRecoveryTick.state, 'down');

  await machine.tick();
  const recovered = await machine.tick();
  assert.equal(recovered.state, 'OK');
});
