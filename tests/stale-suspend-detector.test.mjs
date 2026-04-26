import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createStaleSuspendDetector } from '../lib/stale-suspend-detector.mjs';

const STALE_MS = 10 * 60 * 1000;
const COOLDOWN_MS = 5 * 60 * 1000;
const WS_OPEN = 1;

function makeDb({ suspended = [] } = {}) {
  const calls = [];
  return {
    calls,
    listSuspendedSessions: () => suspended.map((n) => ({ name: n })),
    suspendSession: (args) => { calls.push(args); return { name: args.name, suspended_at: Date.now(), suspended_by: args.suspended_by }; },
  };
}

describe('AC-ADR-006-PLAN-B-C · stale-suspend detector', () => {
  test('a · session stale > 10min + ws OPEN + 未 suspended → suspendSession', async () => {
    const now = () => 100_000_000;
    const db = makeDb();
    const sessions = new Map([['stuck', { name: 'stuck', lastAliveProbe: now() - 11 * 60 * 1000, ws: { readyState: WS_OPEN } }]]);
    const det = createStaleSuspendDetector({ db, getSessions: () => sessions, now, staleMs: STALE_MS, cooldownMs: COOLDOWN_MS });
    const r = det.tick();
    assert.deepEqual(r.detected, ['stuck']);
    assert.equal(db.calls.length, 1);
    assert.equal(db.calls[0].name, 'stuck');
    assert.equal(db.calls[0].reason, 'stuck-stale');
    assert.equal(db.calls[0].suspended_by, 'watchdog');
  });

  test('b · session stale + ws CLOSED → 不 suspendSession', () => {
    const now = () => 100_000_000;
    const db = makeDb();
    const sessions = new Map([['closed', { name: 'closed', lastAliveProbe: now() - 11 * 60 * 1000, ws: { readyState: 3 } }]]);
    const det = createStaleSuspendDetector({ db, getSessions: () => sessions, now });
    const r = det.tick();
    assert.equal(r.detected.length, 0);
    assert.equal(db.calls.length, 0);
  });

  test('c · session stale 但已在 suspended → 不重复 suspend', () => {
    const now = () => 100_000_000;
    const db = makeDb({ suspended: ['already'] });
    const sessions = new Map([['already', { name: 'already', lastAliveProbe: now() - 11 * 60 * 1000, ws: { readyState: WS_OPEN } }]]);
    const det = createStaleSuspendDetector({ db, getSessions: () => sessions, now });
    const r = det.tick();
    assert.equal(r.detected.length, 0);
    assert.equal(db.calls.length, 0);
  });

  test('d · fresh session (<10min) → 不 suspend', () => {
    const now = () => 100_000_000;
    const db = makeDb();
    const sessions = new Map([['fresh', { name: 'fresh', lastAliveProbe: now() - 5 * 60 * 1000, ws: { readyState: WS_OPEN } }]]);
    const det = createStaleSuspendDetector({ db, getSessions: () => sessions, now });
    const r = det.tick();
    assert.equal(r.detected.length, 0);
    assert.equal(db.calls.length, 0);
  });

  test('e · cooldown · 第一次 suspend 后 5min 内同 session 不重复', () => {
    let nowVal = 100_000_000;
    const now = () => nowVal;
    const db = makeDb();
    const sessions = new Map([['x', { name: 'x', lastAliveProbe: nowVal - 11 * 60 * 1000, ws: { readyState: WS_OPEN } }]]);
    const det = createStaleSuspendDetector({ db, getSessions: () => sessions, now, cooldownMs: COOLDOWN_MS });
    let r = det.tick();
    assert.equal(r.detected.length, 1);
    // 模拟 db.listSuspendedSessions 在第一次后回 [] (例：被 wake)
    // session 仍 stale · 但 cooldown 内不重复
    nowVal += 4 * 60 * 1000; // 4min 后
    sessions.get('x').lastAliveProbe = nowVal - 11 * 60 * 1000;
    r = det.tick();
    assert.equal(r.detected.length, 0);
    // 5min 后 cooldown 过 · 重新 suspend
    nowVal += 2 * 60 * 1000; // 累计 6min 后
    sessions.get('x').lastAliveProbe = nowVal - 11 * 60 * 1000;
    r = det.tick();
    assert.equal(r.detected.length, 1);
    assert.equal(db.calls.length, 2);
  });
});
