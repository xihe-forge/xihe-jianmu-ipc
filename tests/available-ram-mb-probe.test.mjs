import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeAvailableRamMb } from '../lib/network-probes.mjs';

function createNow() {
  let current = 1_000;
  return () => {
    current += 7;
    return current;
  };
}

test('probeAvailableRamMb available_ram_mb: returns ok availableMb for 15000/9000/4000 samples', async () => {
  for (const availableMb of [15_000, 9_000, 4_000]) {
    const result = await probeAvailableRamMb({
      sample: async () => availableMb,
      now: createNow(),
    });

    assert.equal(result.ok, true);
    assert.equal(result.availableMb, availableMb);
    assert.equal(typeof result.latencyMs, 'number');
  }
});

test('probeAvailableRamMb: sample error returns failed result', async () => {
  const result = await probeAvailableRamMb({
    sample: async () => {
      throw new Error('counter unavailable');
    },
    now: createNow(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.availableMb, null);
  assert.match(result.error, /counter unavailable/);
});

test('probeAvailableRamMb: timeout returns failed result', async () => {
  const result = await probeAvailableRamMb({
    timeoutMs: 1,
    sample: () => new Promise(() => {}),
    now: createNow(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.availableMb, null);
  assert.equal(result.error, 'timeout');
});
