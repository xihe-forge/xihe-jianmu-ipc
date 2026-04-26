import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createWakeCooldown } from '../lib/wake-cooldown.mjs';

function makeDb(records = new Map()) {
  return {
    records,
    getWakeRecord: (name) => records.get(name) ?? null,
    upsertWakeRecord: ({ name, last_wake_at }) => {
      records.set(name, { name, last_wake_at });
    },
  };
}

describe('T-ADR-006-V03-STEP8 wake-cooldown', () => {
  test('canWake is true when no wake record exists', () => {
    const cooldown = createWakeCooldown({ db: makeDb(), now: () => 1_000_000 });
    assert.equal(cooldown.canWake('alpha'), true);
    assert.equal(cooldown.cooldownRemainingMs('alpha'), 0);
  });

  test('canWake is true after cooldown window expires', () => {
    const records = new Map([['alpha', { name: 'alpha', last_wake_at: 1_000_000 }]]);
    const cooldown = createWakeCooldown({ db: makeDb(records), now: () => 1_300_000 });
    assert.equal(cooldown.canWake('alpha'), true);
    assert.equal(cooldown.cooldownRemainingMs('alpha'), 0);
  });

  test('canWake is false inside cooldown window', () => {
    const records = new Map([['alpha', { name: 'alpha', last_wake_at: 1_000_000 }]]);
    const cooldown = createWakeCooldown({ db: makeDb(records), now: () => 1_060_000 });
    assert.equal(cooldown.canWake('alpha'), false);
    assert.equal(cooldown.cooldownRemainingMs('alpha'), 240_000);
  });

  test('recordWake immediately starts cooldown', () => {
    const db = makeDb();
    const cooldown = createWakeCooldown({ db, now: () => 2_000_000 });
    cooldown.recordWake('alpha');
    assert.deepEqual(db.records.get('alpha'), { name: 'alpha', last_wake_at: 2_000_000 });
    assert.equal(cooldown.canWake('alpha'), false);
  });

  test('cooldown records are isolated per session', () => {
    const records = new Map([['alpha', { name: 'alpha', last_wake_at: 1_000_000 }]]);
    const cooldown = createWakeCooldown({ db: makeDb(records), now: () => 1_060_000 });
    assert.equal(cooldown.canWake('alpha'), false);
    assert.equal(cooldown.canWake('beta'), true);
  });
});
