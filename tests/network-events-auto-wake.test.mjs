import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createNetworkEventBroadcaster } from '../lib/network-events.mjs';

function makeRouter() {
  const sent = [];
  return {
    sent,
    broadcastToTopic: () => [],
    routeMessage: (msg) => { sent.push(msg); return { delivered: true, msg_id: 'fake' }; },
  };
}
function makeDb() {
  return {
    listSuspendedSessions: () => [],
    clearSuspendedSessions: () => [],
  };
}
function makeSessions(arr) {
  // arr: [{name, lastAliveProbe, wsOpen}]
  const m = new Map();
  for (const s of arr) {
    m.set(s.name, {
      name: s.name,
      lastAliveProbe: s.lastAliveProbe,
      ws: { readyState: s.wsOpen ? 1 : 3 },
    });
  }
  return m;
}

describe('AC-ADR-006-PLAN-A · Hub auto-wake on broadcastNetworkUp', () => {
  test('a · stale session (>5min idle) + ws OPEN → routeMessage wake IPC', async () => {
    const router = makeRouter();
    const db = makeDb();
    const now = () => 100_000_000;
    const sessions = makeSessions([
      { name: 'stale-session', lastAliveProbe: now() - 6 * 60 * 1000, wsOpen: true },
    ]);
    const { broadcastNetworkUp } = createNetworkEventBroadcaster({
      router, db, now, getSessions: () => sessions,
    });
    const result = await broadcastNetworkUp({ triggeredBy: 'watchdog' });
    assert.equal(router.sent.length, 1, `应发 1 条 wake IPC: ${JSON.stringify(router.sent)}`);
    assert.equal(router.sent[0].to, 'stale-session');
    assert.match(router.sent[0].content, /auto-wake from jianmu-pm/);
    assert.deepEqual(result.autoWokenSessions, ['stale-session']);
  });

  test('b · fresh session (<5min idle) → 不发 wake IPC', async () => {
    const router = makeRouter();
    const sessions = makeSessions([
      { name: 'fresh', lastAliveProbe: 100_000_000 - 1 * 60 * 1000, wsOpen: true },
    ]);
    const { broadcastNetworkUp } = createNetworkEventBroadcaster({
      router, db: makeDb(), now: () => 100_000_000, getSessions: () => sessions,
    });
    const result = await broadcastNetworkUp({ triggeredBy: 'watchdog' });
    assert.equal(router.sent.length, 0);
    assert.deepEqual(result.autoWokenSessions, []);
  });

  test('c · stale session 但 ws CLOSED → 不发 wake IPC（无意义 · session 不在线）', async () => {
    const router = makeRouter();
    const sessions = makeSessions([
      { name: 'closed', lastAliveProbe: 100_000_000 - 6 * 60 * 1000, wsOpen: false },
    ]);
    const { broadcastNetworkUp } = createNetworkEventBroadcaster({
      router, db: makeDb(), now: () => 100_000_000, getSessions: () => sessions,
    });
    const result = await broadcastNetworkUp({ triggeredBy: 'watchdog' });
    assert.equal(router.sent.length, 0);
    assert.deepEqual(result.autoWokenSessions, []);
  });

  test('d · 多 stale session → 每个发独立 wake IPC', async () => {
    const router = makeRouter();
    const sessions = makeSessions([
      { name: 'a', lastAliveProbe: 100_000_000 - 6 * 60 * 1000, wsOpen: true },
      { name: 'b', lastAliveProbe: 100_000_000 - 10 * 60 * 1000, wsOpen: true },
      { name: 'c', lastAliveProbe: 100_000_000 - 1 * 60 * 1000, wsOpen: true },
    ]);
    const { broadcastNetworkUp } = createNetworkEventBroadcaster({
      router, db: makeDb(), now: () => 100_000_000, getSessions: () => sessions,
    });
    const result = await broadcastNetworkUp({ triggeredBy: 'watchdog' });
    assert.equal(router.sent.length, 2);
    assert.deepEqual(result.autoWokenSessions.sort(), ['a', 'b']);
  });

  test('e · getSessions 缺失（向后兼容）→ 不发 wake · autoWokenSessions=[]', async () => {
    const router = makeRouter();
    const { broadcastNetworkUp } = createNetworkEventBroadcaster({
      router, db: makeDb(), now: () => 100_000_000,
      // getSessions 故意不传
    });
    const result = await broadcastNetworkUp({ triggeredBy: 'watchdog' });
    assert.equal(router.sent.length, 0);
    assert.deepEqual(result.autoWokenSessions, []);
  });
});
