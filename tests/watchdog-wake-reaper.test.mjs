import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as watchdog from '../bin/network-watchdog.mjs';

function createTestReaper({
  suspendedSessions = [],
  probes = [],
  now = () => 1_000_000,
  posted = [],
} = {}) {
  return watchdog.createWakeReaper({
    fetchHealth: async () => ({ suspended_sessions: suspendedSessions }),
    recentAnthropicProbes: () => probes,
    postWakeSuspended: async (body) => {
      posted.push(body);
      return { ok: true };
    },
    now,
    cooldownMs: 5 * 60 * 1000,
  });
}

describe('watchdog wake-suspended reaper', () => {
  test('posts wake-suspended once when sessions are suspended and anthropic is stable', async () => {
    const posted = [];
    const reaper = createTestReaper({
      suspendedSessions: ['a', 'b'],
      probes: [{ ok: true }, { ok: true }, { ok: true }],
      posted,
    });

    const result = await reaper.tick();

    assert.equal(posted.length, 1);
    assert.deepEqual(posted[0], { triggeredBy: 'watchdog-reaper' });
    assert.equal(result.triggered, true);
    assert.equal(result.suspendedCount, 2);
  });

  test('does not post with fewer than three consecutive successful anthropic probes', async () => {
    const posted = [];
    const reaper = createTestReaper({
      suspendedSessions: ['a'],
      probes: [{ ok: true }],
      posted,
    });

    const result = await reaper.tick();

    assert.equal(posted.length, 0);
    assert.deepEqual(result, { triggered: false, reason: 'anthropic-not-stable' });
  });

  test('does not post when any recent anthropic probe failed', async () => {
    const posted = [];
    const reaper = createTestReaper({
      suspendedSessions: ['a'],
      probes: [{ ok: true }, { ok: false }, { ok: true }],
      posted,
    });

    const result = await reaper.tick();

    assert.equal(posted.length, 0);
    assert.deepEqual(result, { triggered: false, reason: 'anthropic-not-stable' });
  });

  test('does not post when no sessions are suspended', async () => {
    const posted = [];
    const reaper = createTestReaper({
      suspendedSessions: [],
      probes: [{ ok: true }, { ok: true }, { ok: true }],
      posted,
    });

    const result = await reaper.tick();

    assert.equal(posted.length, 0);
    assert.deepEqual(result, { triggered: false, reason: 'no-suspended' });
  });

  test('does not repost during cooldown and posts again after five minutes', async () => {
    let mockNow = 1_000_000;
    const posted = [];
    const reaper = createTestReaper({
      suspendedSessions: ['a'],
      probes: [{ ok: true }, { ok: true }, { ok: true }],
      now: () => mockNow,
      posted,
    });

    assert.equal((await reaper.tick()).triggered, true);
    mockNow += 60 * 1000;
    assert.deepEqual(await reaper.tick(), { triggered: false, reason: 'cooldown' });
    mockNow += 4 * 60 * 1000;
    assert.equal((await reaper.tick()).triggered, true);

    assert.equal(posted.length, 2);
    assert.deepEqual(posted, [
      { triggeredBy: 'watchdog-reaper' },
      { triggeredBy: 'watchdog-reaper' },
    ]);
  });
});
