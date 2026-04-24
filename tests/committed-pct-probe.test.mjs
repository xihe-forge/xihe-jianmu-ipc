import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeCommittedPct } from '../lib/network-probes.mjs';

function createNow() {
  let current = 0;
  return () => {
    current += 1;
    return current;
  };
}

test('probeCommittedPct committed_pct: returns ok pct for 60/90/95 samples', async () => {
  for (const pct of [60, 90, 95]) {
    const result = await probeCommittedPct({
      sample: async () => pct,
      now: createNow(),
    });

    assert.equal(result.ok, true);
    assert.equal(result.pct, pct);
    assert.equal(typeof result.latencyMs, 'number');
  }
});

test('probeCommittedPct: sample error returns failed result', async () => {
  const result = await probeCommittedPct({
    sample: async () => {
      throw new Error('counter unavailable');
    },
    now: createNow(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.pct, null);
  assert.match(result.error, /counter unavailable/);
});

test('probeCommittedPct: timeout returns failed result', async () => {
  const result = await probeCommittedPct({
    timeoutMs: 1,
    sample: () => new Promise(() => {}),
    now: createNow(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.pct, null);
  assert.equal(result.error, 'timeout');
});
