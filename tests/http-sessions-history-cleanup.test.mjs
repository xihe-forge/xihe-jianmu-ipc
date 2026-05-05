import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { rmSync } from 'node:fs';
import { getTempDbPath } from './helpers/temp-path.mjs';

const DB_PATH = getTempDbPath('http-sessions-history-cleanup');
process.env.IPC_DB_PATH = DB_PATH;

const db = await import('../lib/db.mjs');
const { createHttpHandler } = await import('../lib/http-handlers.mjs');
const sqlite = new Database(DB_PATH);

function createCtx() {
  return {
    sessions: new Map(),
    routeMessage: () => {},
    broadcastToTopic: () => {},
    broadcastNetworkDown: async () => ({ broadcastTo: 0, subscribers: [] }),
    broadcastNetworkUp: async () => ({ broadcastTo: 0, subscribers: [], clearedSessions: [] }),
    checkAuth: () => true,
    authTokens: null,
    AUTH_TOKEN: null,
    INTERNAL_TOKEN: 'test-token',
    createMessage: (msg) => ({ ...msg, id: 'msg-test' }),
    createTask: (task) => ({ ...task, id: 'task-test' }),
    TASK_STATUSES: ['pending', 'in_progress', 'completed', 'failed'],
    saveTask: () => {},
    getTask: () => null,
    updateTaskStatus: () => ({}),
    listTasks: () => [],
    getTaskStats: () => [],
    getMessages: () => [],
    getRecipientRecent: () => [],
    getMessageCount: () => 0,
    getMessageCountByAgent: () => [],
    suspendSession: () => null,
    recordSessionSpawn: db.recordSessionSpawn,
    updateSessionLastSeen: db.updateSessionLastSeen,
    getSessionsByName: db.getSessionsByName,
    listSessionsHistory: db.listSessionsHistory,
    deleteSessionById: db.deleteSessionById,
    deleteSessionsByName: db.deleteSessionsByName,
    cleanupSessionsHistory: db.cleanupSessionsHistory,
    ERR_REBIND_PENDING: db.ERR_REBIND_PENDING,
    createPendingRebind: db.createPendingRebind,
    registerSessionRecord: async () => ({ ok: true }),
    updateSessionRecordProjects: async () => ({ ok: true }),
    sessionReclaim: async () => ({ ok: true }),
    feishuApps: [],
    getFeishuToken: async () => null,
    stderr: () => {},
    audit: () => {},
    hubDir: process.cwd(),
    now: () => 10_000,
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

async function request(port, method, path, body = null) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
}

function invokeNonLoopback(handler) {
  return new Promise((resolve) => {
    const req = new EventEmitter();
    req.method = 'DELETE';
    req.url = '/sessions-history?name=taiwei-test';
    req.socket = { remoteAddress: '203.0.113.10' };
    const res = {
      statusCode: null,
      body: '',
      writeHead(status) {
        this.statusCode = status;
      },
      end(chunk = '') {
        this.body += chunk;
        resolve({ status: this.statusCode, data: JSON.parse(this.body) });
      },
    };
    handler(req, res);
  });
}

beforeEach(() => {
  sqlite.exec('DELETE FROM lineage; DELETE FROM sessions_history;');
});

test('DELETE /sessions-history?name deletes by name on loopback', async () => {
  db.recordSessionSpawn({ sessionId: 'http-delete-name-1', name: 'taiwei-test', spawnAt: 1000 });
  db.recordSessionSpawn({ sessionId: 'http-delete-name-2', name: 'taiwei-test', spawnAt: 2000 });
  const server = http.createServer(createHttpHandler(createCtx()));
  const port = await listen(server);
  try {
    const res = await request(port, 'DELETE', '/sessions-history?name=taiwei-test');
    assert.equal(res.status, 200);
    assert.equal(res.data.count, 2);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM sessions_history WHERE name = 'taiwei-test'").get().count, 0);
  } finally {
    server.close();
  }
});

test('POST /sessions-history/cleanup supports dry-run and enforce', async () => {
  db.recordSessionSpawn({ sessionId: 'http-cleanup-old', name: 'taiwei-test', spawnAt: 1000, endedAt: 1000 });
  db.recordSessionSpawn({ sessionId: 'http-cleanup-keep', name: 'taiwei-test', spawnAt: 9000, endedAt: 9000 });
  const server = http.createServer(createHttpHandler(createCtx()));
  const port = await listen(server);
  try {
    const dryRun = await request(port, 'POST', '/sessions-history/cleanup', {
      dryRun: true,
      endedOlderThanDays: 0.00005,
    });
    assert.equal(dryRun.status, 200);
    assert.equal(dryRun.data.count, 1);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM sessions_history').get().count, 2);

    const enforce = await request(port, 'POST', '/sessions-history/cleanup', {
      dryRun: false,
      endedOlderThanDays: 0.00005,
    });
    assert.equal(enforce.status, 200);
    assert.equal(enforce.data.count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM sessions_history WHERE session_id = 'http-cleanup-old'").get().count, 0);
  } finally {
    server.close();
  }
});

test('sessions-history delete endpoints reject non-loopback remotes', async () => {
  const result = await invokeNonLoopback(createHttpHandler(createCtx()));
  assert.equal(result.status, 403);
  assert.equal(result.data.error, 'forbidden');
});

after(() => {
  try {
    sqlite.close();
  } catch {}
  try {
    db.close();
  } catch {}
  for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    try {
      rmSync(file, { force: true });
    } catch {}
  }
});
