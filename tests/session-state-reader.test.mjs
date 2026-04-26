import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getAllSessionStates, getSessionState } from '../lib/session-state-reader.mjs';

async function makeTempDir() {
  return await mkdtemp(join(tmpdir(), 'session-state-reader-'));
}

async function writeSession(dir, filename, body) {
  await writeFile(join(dir, filename), JSON.stringify(body), 'utf8');
}

describe('T-ADR-006-V03-STEP6 · session-state-reader', () => {
  test('目录不存在 → 返回 []', () => {
    const states = getAllSessionStates({ dir: join(tmpdir(), `missing-${Date.now()}`) });
    assert.deepEqual(states, []);
  });

  test('单条 valid session.json → 返回完整 schema', async () => {
    const dir = await makeTempDir();
    try {
      await writeSession(dir, 'one.json', {
        pid: 1234,
        sessionId: 'session-a',
        status: 'busy',
        updatedAt: 1_000,
      });

      const states = getAllSessionStates({ dir, now: () => 2_500 });
      assert.equal(states.length, 1);
      assert.equal(states[0].pid, 1234);
      assert.equal(states[0].sessionId, 'session-a');
      assert.equal(states[0].status, 'busy');
      assert.equal(states[0].updatedAt, 1_000);
      assert.equal(states[0].idleMs, 0);
      assert.equal(states[0].busyMs, 1_500);
      assert.equal(typeof states[0].transcriptPath, 'string');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('多条混合 → 静默跳过损坏、无 pid、非法 status', async () => {
    const dir = await makeTempDir();
    try {
      await writeSession(dir, 'valid.json', {
        pid: 2222,
        sessionId: 'session-valid',
        status: 'idle',
        updatedAt: 4_000,
      });
      await writeFile(join(dir, 'broken.json'), '{bad json', 'utf8');
      await writeSession(dir, 'no-pid.json', { sessionId: 'no-pid', status: 'busy', updatedAt: 1 });
      await writeSession(dir, 'bad-status.json', { pid: 3333, sessionId: 'bad', status: 'done', updatedAt: 1 });

      const states = getAllSessionStates({ dir, now: () => 5_000 });
      assert.deepEqual(states.map((state) => state.pid), [2222]);
      assert.equal(getSessionState(2222, { dir, now: () => 5_000 })?.sessionId, 'session-valid');
      assert.equal(getSessionState(3333, { dir, now: () => 5_000 }), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('status=idle 时 idleMs 计算正确，busyMs=0', async () => {
    const dir = await makeTempDir();
    try {
      await writeSession(dir, 'idle.json', { pid: 4444, sessionId: 'idle-s', status: 'idle', updatedAt: 10_000 });
      const [state] = getAllSessionStates({ dir, now: () => 13_000 });
      assert.equal(state.idleMs, 3_000);
      assert.equal(state.busyMs, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('status=busy 时 busyMs 计算正确，idleMs=0', async () => {
    const dir = await makeTempDir();
    try {
      await writeSession(dir, 'busy.json', { pid: 5555, sessionId: 'busy-s', status: 'busy', updatedAt: 20_000 });
      const [state] = getAllSessionStates({ dir, now: () => 24_500 });
      assert.equal(state.busyMs, 4_500);
      assert.equal(state.idleMs, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
