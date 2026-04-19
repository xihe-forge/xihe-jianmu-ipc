import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { getObservationDbPath } from '../lib/claude-paths.mjs';
import { recallObservations } from '../lib/observation-query.mjs';
import {
  createObservationDb,
  insertObservation,
  cleanupSqliteFiles,
} from './helpers/observation-fixture.mjs';

function createTempHome() {
  return mkdtempSync(join(os.tmpdir(), 'ipc-observation-query-'));
}

function createProjectDb(homeDir, project, options = {}) {
  const dbPath = getObservationDbPath(project, { homeDir });
  const db = createObservationDb(dbPath, options);
  return { dbPath, db };
}

test('recallObservations: 单 project 支持 since/limit/ipc/tool/tags/keyword 全组合过滤并截断文本', () => {
  const homeDir = createTempHome();
  const now = 1_745_038_800_000;
  const project = 'xihe-houtu-seeds';
  const { dbPath, db } = createProjectDb(homeDir, project);

  try {
    insertObservation(db, {
      session_id: 'session-hit',
      ipc_name: 'houtu_builder',
      ts: now - 100,
      tool_name: 'Bash',
      tool_input: 'unpublish dev.to post',
      tool_output: 'x'.repeat(520),
      files_touched: ['posts/devto.md', 'README.md'],
      commit_sha: 'abc1234',
      tags: ['dev.to', 'ship', 'auto'],
      ipc_peer: 'jianmu-pm',
    });
    insertObservation(db, {
      session_id: 'session-miss',
      ipc_name: 'houtu_builder',
      ts: now - 200,
      tool_name: 'Bash',
      tool_input: 'publish another site',
      tool_output: 'done',
      files_touched: ['posts/other.md'],
      tags: ['dev.to'],
    });
    insertObservation(db, {
      session_id: 'session-old',
      ipc_name: 'houtu_builder',
      ts: now - 2 * 60 * 60 * 1000,
      tool_name: 'Bash',
      tool_input: 'unpublish stale post',
      tool_output: 'done',
      tags: ['dev.to', 'ship'],
    });

    const result = recallObservations(
      {
        project,
        since: 60 * 60 * 1000,
        limit: 50,
        ipc_name: 'houtu_builder',
        tool_name: 'Bash',
        tags: ['dev.to', 'ship'],
        keyword: 'unpublish',
      },
      {
        homeDir,
        now: () => now,
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.count, 1);
    assert.deepEqual(result.observations[0], {
      project,
      id: 1,
      session_id: 'session-hit',
      ipc_name: 'houtu_builder',
      ts: now - 100,
      tool_name: 'Bash',
      tool_input: 'unpublish dev.to post',
      tool_output: `${'x'.repeat(500)}...`,
      files_touched: ['posts/devto.md', 'README.md'],
      commit_sha: 'abc1234',
      tags: ['dev.to', 'ship', 'auto'],
      ipc_peer: 'jianmu-pm',
    });
  } finally {
    db.close();
    cleanupSqliteFiles(dbPath);
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('recallObservations: project=\"*\" 合并多个库并按 ts 全局倒序裁剪 limit', () => {
  const homeDir = createTempHome();
  const now = 1_745_038_800_000;
  const alpha = createProjectDb(homeDir, 'alpha-project');
  const beta = createProjectDb(homeDir, 'beta-project');

  try {
    insertObservation(alpha.db, {
      ts: now - 200,
      ipc_name: 'worker-a',
      tool_input: 'alpha change',
    });
    insertObservation(beta.db, {
      ts: now - 50,
      ipc_name: 'worker-b',
      tool_input: 'beta change',
    });

    const result = recallObservations(
      {
        project: '*',
        since: null,
        limit: 1,
      },
      {
        homeDir,
        now: () => now,
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.count, 1);
    assert.equal(result.observations[0].project, 'beta-project');
    assert.equal(result.observations[0].ipc_name, 'worker-b');
  } finally {
    alpha.db.close();
    beta.db.close();
    cleanupSqliteFiles(alpha.dbPath);
    cleanupSqliteFiles(beta.dbPath);
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('recallObservations: DB 不存在时友好返回空数组和 note', () => {
  const homeDir = createTempHome();

  try {
    mkdirSync(join(homeDir, '.claude'), { recursive: true });

    const result = recallObservations(
      {
        project: 'missing-project',
        since: null,
        limit: 10,
      },
      { homeDir },
    );

    assert.deepEqual(result, {
      ok: true,
      project: 'missing-project',
      count: 0,
      observations: [],
      note: 'db not found',
    });
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('recallObservations: observations_fts 不存在时回退 LIKE 关键字过滤', () => {
  const homeDir = createTempHome();
  const project = 'fallback-project';
  const { dbPath, db } = createProjectDb(homeDir, project, { withFts: false });

  try {
    insertObservation(db, {
      tool_input: 'ship the feature quietly',
      tags: ['ship'],
    });
    insertObservation(db, {
      tool_input: 'do not match this row',
      tags: ['ignore'],
    });

    const result = recallObservations(
      {
        project,
        keyword: 'quietly',
        limit: 10,
      },
      { homeDir },
    );

    assert.equal(result.count, 1);
    assert.equal(result.observations[0].tool_input, 'ship the feature quietly');
  } finally {
    db.close();
    cleanupSqliteFiles(dbPath);
    rmSync(homeDir, { recursive: true, force: true });
  }
});
