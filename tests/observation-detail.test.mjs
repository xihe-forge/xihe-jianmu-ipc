import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { getObservationDbPath } from '../lib/claude-paths.mjs';
import { getObservationDetail } from '../lib/observation-query.mjs';
import {
  cleanupSqliteFiles,
  createObservationDb,
  insertObservation,
} from './helpers/observation-fixture.mjs';

function createTempHome() {
  return mkdtempSync(join(os.tmpdir(), 'ipc-observation-detail-'));
}

test('getObservationDetail: 返回完整字段并解析 jsonl tag 元数据', () => {
  const homeDir = createTempHome();
  const project = 'xihe-houtu-seeds';
  const dbPath = getObservationDbPath(project, { homeDir });
  const db = createObservationDb(dbPath);
  const longOutput = 'y'.repeat(620);

  try {
    const id = insertObservation(db, {
      session_id: 'session-detail',
      ipc_name: 'houtu_builder',
      tool_name: 'Edit',
      tool_input: 'edit docs/adr.md',
      tool_output: longOutput,
      files_touched: ['docs/adr.md', 'README.md'],
      commit_sha: 'deadbee',
      tags: ['ship', 'jsonl:C:\\Users\\jolen\\.claude\\projects\\abc\\session.jsonl:10-20'],
      ipc_peer: 'jianmu-pm',
    });

    const result = getObservationDetail({ project, id }, { homeDir });

    assert.deepEqual(result, {
      ok: true,
      observation: {
        id,
        session_id: 'session-detail',
        ipc_name: 'houtu_builder',
        ts: result.observation.ts,
        tool_name: 'Edit',
        tool_input: 'edit docs/adr.md',
        tool_output: longOutput,
        files_touched: ['docs/adr.md', 'README.md'],
        commit_sha: 'deadbee',
        tags: ['ship', 'jsonl:C:\\Users\\jolen\\.claude\\projects\\abc\\session.jsonl:10-20'],
        ipc_peer: 'jianmu-pm',
        jsonl_path: 'C:\\Users\\jolen\\.claude\\projects\\abc\\session.jsonl',
        line_range: '10-20',
      },
    });
  } finally {
    db.close();
    cleanupSqliteFiles(dbPath);
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('getObservationDetail: id 不存在时返回 ok=false', () => {
  const homeDir = createTempHome();
  const project = 'xihe-jianmu-ipc';
  const dbPath = getObservationDbPath(project, { homeDir });
  const db = createObservationDb(dbPath);

  try {
    const result = getObservationDetail({ project, id: 42 }, { homeDir });

    assert.deepEqual(result, {
      ok: false,
      error: 'observation not found',
      project,
      id: 42,
    });
  } finally {
    db.close();
    cleanupSqliteFiles(dbPath);
    rmSync(homeDir, { recursive: true, force: true });
  }
});
