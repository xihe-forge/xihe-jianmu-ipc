import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createZombiePidDetector,
  isPidAlive,
} from '../lib/zombie-pid-detector.mjs';

const NOW = 1_000_000;
const COOLDOWN = 30 * 60 * 1000;

function makeSession(overrides = {}) {
  return {
    name: 'session-dead',
    pid: 12345,
    cwd: 'D:/repo',
    ...overrides,
  };
}

function makeDetector({
  sessions = [makeSession()],
  alivePids = new Set(),
  dryRun = true,
  now = () => NOW,
  cooldownMs = COOLDOWN,
} = {}) {
  const reclaimCalls = [];
  const stderrLines = [];
  const detector = createZombiePidDetector({
    getSessions: async () => sessions,
    isPidAlive: (pid) => alivePids.has(pid),
    postReclaim: async (name) => {
      reclaimCalls.push(name);
      return { ok: true, evicted: true };
    },
    now,
    cooldownMs,
    dryRun,
    stderr: (line) => stderrLines.push(line),
  });
  return { detector, reclaimCalls, stderrLines };
}

describe('K.D zombie-pid-detector', () => {
  test('tick() returns scanned/dead/evicted/dryRun structure', async () => {
    const { detector } = makeDetector({
      sessions: [makeSession({ name: 'alive', pid: 111 })],
      alivePids: new Set([111]),
    });

    const result = await detector.tick();

    assert.deepEqual(result, {
      scanned: 1,
      dead: 0,
      evicted: 0,
      dryRun: [],
    });
  });

  test('dry-run records one dead pid and does not reclaim', async () => {
    const sessions = [
      makeSession({ name: 'alive-a', pid: 1 }),
      makeSession({ name: 'dead-b', pid: 2 }),
      makeSession({ name: 'alive-c', pid: 3 }),
    ];
    const { detector, reclaimCalls, stderrLines } = makeDetector({
      sessions,
      alivePids: new Set([1, 3]),
      dryRun: true,
    });

    const result = await detector.tick();

    assert.equal(result.scanned, 3);
    assert.equal(result.dead, 1);
    assert.equal(result.evicted, 0);
    assert.deepEqual(result.dryRun, [{ name: 'dead-b', pid: 2 }]);
    assert.deepEqual(reclaimCalls, []);
    assert.match(stderrLines[0], /DRY-RUN would evict dead-b pid=2/);
  });

  test('dryRun=false reclaims one dead pid and increments evicted', async () => {
    const { detector, reclaimCalls } = makeDetector({
      sessions: [makeSession({ name: 'dead-live-evict', pid: 777 })],
      dryRun: false,
    });

    const result = await detector.tick();

    assert.equal(result.scanned, 1);
    assert.equal(result.dead, 1);
    assert.equal(result.evicted, 1);
    assert.deepEqual(result.dryRun, []);
    assert.deepEqual(reclaimCalls, ['dead-live-evict']);
  });

  test('cooldown skips repeated same-name dead pid eviction', async () => {
    let nowValue = NOW;
    const { detector, reclaimCalls } = makeDetector({
      sessions: [makeSession({ name: 'cooldown-dead', pid: 404 })],
      dryRun: false,
      cooldownMs: COOLDOWN,
      now: () => nowValue,
    });

    const first = await detector.tick();
    nowValue += COOLDOWN - 1;
    const second = await detector.tick();

    assert.equal(first.evicted, 1);
    assert.equal(second.scanned, 1);
    assert.equal(second.dead, 1);
    assert.equal(second.evicted, 0);
    assert.deepEqual(reclaimCalls, ['cooldown-dead']);
  });

  test('missing pid is skipped and does not call postReclaim', async () => {
    const { detector, reclaimCalls } = makeDetector({
      sessions: [
        makeSession({ name: 'missing-pid', pid: null }),
        makeSession({ name: 'undefined-pid', pid: undefined }),
      ],
      dryRun: false,
    });

    const result = await detector.tick();

    assert.equal(result.scanned, 2);
    assert.equal(result.dead, 0);
    assert.equal(result.evicted, 0);
    assert.deepEqual(reclaimCalls, []);
  });

  test('isPidAlive treats ESRCH as dead and EPERM/unknown errors as alive', () => {
    const errorWithCode = (code) => Object.assign(new Error(code), { code });

    assert.equal(isPidAlive(100, () => {}), true);
    assert.equal(isPidAlive(100, () => { throw errorWithCode('ESRCH'); }), false);
    assert.equal(isPidAlive(100, () => { throw errorWithCode('EPERM'); }), true);
    assert.equal(isPidAlive(100, () => { throw errorWithCode('EINVAL'); }), true);
  });
});
