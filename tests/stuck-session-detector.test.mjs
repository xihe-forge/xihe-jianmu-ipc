import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStuckSessionDetector } from '../lib/stuck-session-detector.mjs';

const WS_OPEN = 1;
const NOW = 100_000_000;
const THRESHOLD = 5 * 60 * 1000;
const COOLDOWN = 5 * 60 * 1000;

async function makeTranscript({ fresh = false, text = 'ECONNRESET attempt 9/10' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'stuck-session-detector-'));
  const path = join(dir, 'session.jsonl');
  await writeFile(path, text, 'utf8');
  const mtimeMs = fresh ? NOW - 60_000 : NOW - THRESHOLD - 1_000;
  await utimes(path, mtimeMs / 1000, mtimeMs / 1000);
  return { dir, path };
}

function makeDb({ suspended = [] } = {}) {
  const calls = [];
  return {
    calls,
    listSuspendedSessions: () => suspended.map((name) => ({ name })),
    suspendSession: (args) => {
      calls.push(args);
      return args;
    },
  };
}

function makeDetector({
  db = makeDb(),
  session = {},
  state = {},
  tail = 'ECONNRESET attempt 9/10',
  transcriptPath,
  now = () => NOW,
} = {}) {
  const resolvedSession = {
    name: 'jianmu-pm',
    pid: 1234,
    ws: { readyState: WS_OPEN },
    ...session,
  };
  const resolvedState = state === null ? null : {
    pid: resolvedSession.pid,
    status: 'busy',
    updatedAt: NOW - THRESHOLD - 1_000,
    transcriptPath,
    ...state,
  };

  return {
    db,
    detector: createStuckSessionDetector({
      db,
      getSessions: () => new Map([[resolvedSession.name, resolvedSession]]),
      getSessionState: () => resolvedState,
      readTranscriptTail: () => tail,
      now,
      cooldownMs: COOLDOWN,
      stuckThresholdMs: THRESHOLD,
    }),
  };
}

describe('T-ADR-006-V03-STEP7 · stuck-session-detector 5-signal AND', () => {
  test('全 5 信号命中 → detected + suspendSession', async () => {
    const fixture = await makeTranscript();
    try {
      const { db, detector } = makeDetector({ transcriptPath: fixture.path });
      const result = detector.tick();
      assert.deepEqual(result.detected, ['jianmu-pm']);
      assert.equal(db.calls.length, 1);
      assert.equal(db.calls[0].name, 'jianmu-pm');
      assert.equal(db.calls[0].reason, 'stuck-network');
      assert.equal(db.calls[0].suspended_by, 'watchdog');
      assert.match(db.calls[0].task_description, /5-signal AND/);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  test('信号 1 fail（status=idle）→ skip not-busy', async () => {
    const fixture = await makeTranscript();
    try {
      const { db, detector } = makeDetector({ transcriptPath: fixture.path, state: { status: 'idle' } });
      const result = detector.tick();
      assert.deepEqual(result.detected, []);
      assert.equal(result.skipped[0].reason, 'not-busy');
      assert.equal(db.calls.length, 0);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  test('信号 2 fail（updatedAt 鲜）→ skip fresh-update', async () => {
    const fixture = await makeTranscript();
    try {
      const { db, detector } = makeDetector({ transcriptPath: fixture.path, state: { updatedAt: NOW - 60_000 } });
      const result = detector.tick();
      assert.equal(result.skipped[0].reason, 'fresh-update');
      assert.equal(db.calls.length, 0);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  test('信号 3 fail（transcript mtime 鲜）→ skip fresh-transcript', async () => {
    const fixture = await makeTranscript({ fresh: true });
    try {
      const { db, detector } = makeDetector({ transcriptPath: fixture.path });
      const result = detector.tick();
      assert.equal(result.skipped[0].reason, 'fresh-transcript');
      assert.equal(db.calls.length, 0);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  test('信号 4 fail（无错误关键字）→ skip no-error-keyword', async () => {
    const fixture = await makeTranscript({ text: 'normal progress' });
    try {
      const { db, detector } = makeDetector({ transcriptPath: fixture.path, tail: 'normal progress' });
      const result = detector.tick();
      assert.equal(result.skipped[0].reason, 'no-error-keyword');
      assert.equal(db.calls.length, 0);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  test('信号 5 fail（冷却内）→ skip cooldown', async () => {
    const fixture = await makeTranscript();
    try {
      let nowValue = NOW;
      const { db, detector } = makeDetector({ transcriptPath: fixture.path, now: () => nowValue });
      assert.deepEqual(detector.tick().detected, ['jianmu-pm']);
      nowValue += COOLDOWN - 1_000;
      const result = detector.tick();
      assert.equal(result.skipped[0].reason, 'cooldown');
      assert.equal(db.calls.length, 1);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  test('session.pid 不在 reader 结果 → skip no-pid-state', async () => {
    const fixture = await makeTranscript();
    try {
      const { db, detector } = makeDetector({ transcriptPath: fixture.path, state: null });
      const result = detector.tick();
      assert.equal(result.skipped[0].reason, 'no-pid-state');
      assert.equal(db.calls.length, 0);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  test('transcriptPath 文件不存在 → skip no-transcript', () => {
    const { db, detector } = makeDetector({ transcriptPath: join(tmpdir(), `missing-${Date.now()}.jsonl`) });
    const result = detector.tick();
    assert.equal(result.skipped[0].reason, 'no-transcript');
    assert.equal(db.calls.length, 0);
  });

  test('WS not OPEN → skip ws-not-open', async () => {
    const fixture = await makeTranscript();
    try {
      const { db, detector } = makeDetector({ transcriptPath: fixture.path, session: { ws: { readyState: 3 } } });
      const result = detector.tick();
      assert.equal(result.skipped[0].reason, 'ws-not-open');
      assert.equal(db.calls.length, 0);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  test('已 suspended → skip already-suspended', async () => {
    const fixture = await makeTranscript();
    try {
      const db = makeDb({ suspended: ['jianmu-pm'] });
      const { detector } = makeDetector({ db, transcriptPath: fixture.path });
      const result = detector.tick();
      assert.equal(result.skipped[0].reason, 'already-suspended');
      assert.equal(db.calls.length, 0);
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  test("命中 'rate limit' → reason='stuck-rate-limited'", async () => {
    const fixture = await makeTranscript({ text: 'rate limit reached' });
    try {
      const { db, detector } = makeDetector({ transcriptPath: fixture.path, tail: 'rate limit reached' });
      detector.tick();
      assert.equal(db.calls[0].reason, 'stuck-rate-limited');
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  test("命中 'ECONNRESET' → reason='stuck-network'", async () => {
    const fixture = await makeTranscript({ text: 'ECONNRESET' });
    try {
      const { db, detector } = makeDetector({ transcriptPath: fixture.path, tail: 'ECONNRESET' });
      detector.tick();
      assert.equal(db.calls[0].reason, 'stuck-network');
    } finally {
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });
});
