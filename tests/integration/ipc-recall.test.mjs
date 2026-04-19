import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { createMcpTools } from '../../lib/mcp-tools.mjs';
import { getObservationDbPath } from '../../lib/claude-paths.mjs';
import { recallObservations } from '../../lib/observation-query.mjs';
import {
  createObservationDb,
  insertObservation,
  cleanupSqliteFiles,
} from '../helpers/observation-fixture.mjs';

function createHarness(homeDir) {
  return createMcpTools({
    getSessionName: () => 'alpha',
    setSessionName: () => {},
    getHubHost: () => '127.0.0.1',
    setHubHost: () => {},
    getHubPort: () => 8765,
    setHubPort: () => {},
    getWs: () => null,
    disconnectWs: () => {},
    reconnect: () => {},
    getPendingOutgoingCount: () => 0,
    wsSend: () => {},
    httpGet: async () => ({}),
    httpPost: async () => ({}),
    httpPatch: async () => ({}),
    spawnSession: async () => ({}),
    recallObservations: (input) => recallObservations(input, { homeDir }),
  });
}

function getJson(result) {
  return JSON.parse(result.content[0].text);
}

test('ipc_recall: 端到端读取 observations.db 并返回过滤后的结果', async () => {
  const homeDir = mkdtempSync(join(os.tmpdir(), 'ipc-recall-integration-'));
  const dbPath = getObservationDbPath('xihe-jianmu-ipc', { homeDir });
  const db = createObservationDb(dbPath);

  try {
    insertObservation(db, {
      ipc_name: 'jianmu-pm',
      tool_name: 'Bash',
      tool_input: 'npm test',
      tags: ['ship', 'ci'],
    });
    insertObservation(db, {
      ipc_name: 'tech-worker',
      tool_name: 'Edit',
      tool_input: 'touch unrelated file',
      tags: ['auto'],
    });

    const tools = createHarness(homeDir);
    const result = await tools.handleToolCall('ipc_recall', {
      project: 'xihe-jianmu-ipc',
      keyword: 'npm test',
      tags: ['ship'],
      limit: 5,
    });
    const payload = getJson(result);

    assert.equal(payload.ok, true);
    assert.equal(payload.project, 'xihe-jianmu-ipc');
    assert.equal(payload.count, 1);
    assert.equal(payload.observations[0].ipc_name, 'jianmu-pm');
    assert.deepEqual(payload.observations[0].tags, ['ship', 'ci']);
  } finally {
    db.close();
    cleanupSqliteFiles(dbPath);
    rmSync(homeDir, { recursive: true, force: true });
  }
});
