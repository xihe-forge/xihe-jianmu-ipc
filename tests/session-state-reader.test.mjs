import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findLatestTranscriptByCwd, getAllSessionStates, getSessionState } from '../lib/session-state-reader.mjs';

async function makeTempDir() {
  return await mkdtemp(join(tmpdir(), 'session-state-reader-'));
}

async function writeSession(dir, filename, body) {
  await writeFile(join(dir, filename), JSON.stringify(body), 'utf8');
}

describe('T-ADR-006-V03-STEP6 路 session-state-reader', () => {
  test('鐩綍涓嶅瓨鍦?鈫?杩斿洖 []', () => {
    const states = getAllSessionStates({ dir: join(tmpdir(), `missing-${Date.now()}`) });
    assert.deepEqual(states, []);
  });

  test('鍗曟潯 valid session.json 鈫?杩斿洖瀹屾暣 schema', async () => {
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

  test('澶氭潯娣峰悎 鈫?闈欓粯璺宠繃鎹熷潖銆佹棤 pid銆侀潪娉?status', async () => {
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

  test('status=idle 鏃?idleMs 璁＄畻姝ｇ‘锛宐usyMs=0', async () => {
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

  test('status=busy 鏃?busyMs 璁＄畻姝ｇ‘锛宨dleMs=0', async () => {
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

  test('T-ADR-010-MOD6-WIRING-V3 findLatestTranscriptByCwd: cwd missing returns null', async () => {
    const homeDir = await makeTempDir();
    try {
      assert.equal(findLatestTranscriptByCwd('D:\\missing\\project', { homeDir }), null);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  test('T-ADR-010-MOD6-WIRING-V3 findLatestTranscriptByCwd: picks newest .jsonl by mtime', async () => {
    const homeDir = await makeTempDir();
    const cwd = 'D:\\workspace\\ai\\research\\xiheAi\\xihe-jianmu-ipc';
    const projectDir = 'D-workspace-ai-research-xiheAi-xihe-jianmu-ipc';
    const transcriptsDir = join(homeDir, '.claude', 'projects', projectDir);
    try {
      await mkdir(transcriptsDir, { recursive: true });
      const older = join(transcriptsDir, 'older.jsonl');
      const newer = join(transcriptsDir, 'newer.jsonl');
      await writeFile(older, 'older', 'utf8');
      await writeFile(newer, 'newer', 'utf8');
      await utimes(older, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
      await utimes(newer, new Date('2026-01-02T00:00:00Z'), new Date('2026-01-02T00:00:00Z'));

      assert.equal(findLatestTranscriptByCwd(cwd, { homeDir }), newer);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  test('T-ADR-010-MOD6-WIRING-V3 findLatestTranscriptByCwd: no .jsonl returns null', async () => {
    const homeDir = await makeTempDir();
    const cwd = 'D:\\workspace\\ai\\research\\xiheAi\\xihe-jianmu-ipc';
    const projectDir = 'D-workspace-ai-research-xiheAi-xihe-jianmu-ipc';
    const transcriptsDir = join(homeDir, '.claude', 'projects', projectDir);
    try {
      await mkdir(transcriptsDir, { recursive: true });
      await writeFile(join(transcriptsDir, 'session.json'), '{}', 'utf8');

      assert.equal(findLatestTranscriptByCwd(cwd, { homeDir }), null);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
