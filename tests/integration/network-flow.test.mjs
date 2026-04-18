import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { getTempDbPath } from '../helpers/temp-path.mjs';

const ROOT_DIR = fileURLToPath(new URL('../../', import.meta.url));
const TEST_TIMEOUT = 10_000;
const HUB_START_TIMEOUT = 3_000;
const WS_TIMEOUT = 3_000;
const WORKER_TIMEOUT = 3_000;

let hub = null;

beforeEach(async () => {
  hub = await startHub();
});

afterEach(async () => {
  await stopHub(hub);
  hub = null;
});

test('session 主动 POST /suspend 后会落盘到 suspended_sessions', { timeout: TEST_TIMEOUT }, async () => {
  const response = await postSuspend(hub.port, {
    from: 'flow-suspended',
    reason: 'network down',
    task_description: 'resume AC-AUTH-08',
    suspended_by: 'self',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.name, 'flow-suspended');

  assert.deepEqual(readSuspendedSessions(hub.dbPath), [{
    name: 'flow-suspended',
    reason: 'network down',
    task_description: 'resume AC-AUTH-08',
    suspended_at: response.body.suspended_at,
    suspended_by: 'self',
  }]);
});

test('OK→down 时通过真实 Hub 广播 network-down，payload 严格 5 字段', { timeout: TEST_TIMEOUT }, async () => {
  const ws = await connectSession(hub.port, 'down-listener');

  try {
    await subscribeToTopic(ws, 'network-down');

    const receive = waitForWebSocketMessage(ws, message => message.type === 'network-down');
    const result = await workerRequest(hub.worker, 'broadcastNetworkDown', {
      failing: ['cliproxy', 'anthropic'],
      since: 1776516000000,
    });
    const message = await receive;

    assert.equal(result.broadcastTo, 1);
    assert.deepEqual(result.subscribers, ['down-listener']);
    assert.deepEqual(
      Object.keys(message).sort(),
      ['failing', 'since', 'triggeredBy', 'ts', 'type'],
    );
    assert.deepEqual(message, {
      type: 'network-down',
      triggeredBy: 'watchdog',
      failing: ['cliproxy', 'anthropic'],
      since: 1776516000000,
      ts: message.ts,
    });
    assert.equal(typeof message.ts, 'number');
  } finally {
    await closeWebSocket(ws);
  }
});

test('down→OK 时 broadcastNetworkUp 广播准确的 suspendedSessions 名单', { timeout: TEST_TIMEOUT }, async () => {
  const ws = await connectSession(hub.port, 'up-listener');

  try {
    await subscribeToTopic(ws, 'network-up');

    await postSuspend(hub.port, {
      from: 'alpha-session',
      reason: 'r1',
      task_description: 'task 1',
      suspended_by: 'self',
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    await postSuspend(hub.port, {
      from: 'beta-session',
      reason: 'r2',
      task_description: 'task 2',
      suspended_by: 'watchdog',
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    await postSuspend(hub.port, {
      from: 'gamma-session',
      reason: 'r3',
      task_description: 'task 3',
      suspended_by: 'harness',
    });

    const receive = waitForWebSocketMessage(ws, message => message.type === 'network-up');
    const result = await workerRequest(hub.worker, 'broadcastNetworkUp', {
      recoveredAfter: 600000,
    });
    const message = await receive;

    assert.equal(result.broadcastTo, 1);
    assert.deepEqual(result.clearedSessions, ['alpha-session', 'beta-session', 'gamma-session']);
    assert.deepEqual(
      Object.keys(message).sort(),
      ['recoveredAfter', 'suspendedSessions', 'triggeredBy', 'ts', 'type'],
    );
    assert.deepEqual(message, {
      type: 'network-up',
      triggeredBy: 'watchdog',
      recoveredAfter: 600000,
      suspendedSessions: ['alpha-session', 'beta-session', 'gamma-session'],
      ts: message.ts,
    });
    assert.equal(typeof message.ts, 'number');
  } finally {
    await closeWebSocket(ws);
  }
});

test('broadcastNetworkUp 完成后 suspended_sessions 会被清空', { timeout: TEST_TIMEOUT }, async () => {
  await postSuspend(hub.port, {
    from: 'clear-a',
    reason: 'r1',
    task_description: 'task A',
    suspended_by: 'self',
  });
  await new Promise(resolve => setTimeout(resolve, 5));
  await postSuspend(hub.port, {
    from: 'clear-b',
    reason: 'r2',
    task_description: 'task B',
    suspended_by: 'watchdog',
  });

  await workerRequest(hub.worker, 'broadcastNetworkUp', {
    recoveredAfter: 1234,
  });

  assert.deepEqual(readSuspendedSessions(hub.dbPath), []);
});

test('同一 session 重复 POST /suspend 时表内保持一条且字段为最后一次', { timeout: TEST_TIMEOUT }, async () => {
  const first = await postSuspend(hub.port, {
    from: 'idempotent-session',
    reason: 'first reason',
    task_description: 'first task',
    suspended_by: 'self',
  });
  await new Promise(resolve => setTimeout(resolve, 5));
  const second = await postSuspend(hub.port, {
    from: 'idempotent-session',
    reason: 'second reason',
    task_description: 'second task',
    suspended_by: 'watchdog',
  });

  const rows = readSuspendedSessions(hub.dbPath);

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    name: 'idempotent-session',
    reason: 'second reason',
    task_description: 'second task',
    suspended_at: second.body.suspended_at,
    suspended_by: 'watchdog',
  });
});

function createTempDbPath() {
  return getTempDbPath('network-flow');
}

function startHub() {
  return findAvailablePort().then((port) => new Promise((resolve, reject) => {
    const dbPath = createTempDbPath();
    const stderrChunks = [];
    const hubUrl = pathToFileURL(join(ROOT_DIR, 'hub.mjs')).href;
    const worker = new Worker(
      `
        process.env.IPC_PORT = ${JSON.stringify(String(port))};
        process.env.IPC_DB_PATH = ${JSON.stringify(dbPath)};
        process.env.IPC_ENABLE_TEST_HOOKS = '1';
        import(${JSON.stringify(hubUrl)});
      `,
      {
        eval: true,
        stdout: true,
        stderr: true,
      },
    );

    worker.stderr.setEncoding('utf8');

    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`Hub 启动超时\n${stderrChunks.join('')}`));
    }, HUB_START_TIMEOUT);

    worker.stderr.on('data', chunk => {
      stderrChunks.push(chunk);
      if (!settled && chunk.includes('listening on')) {
        finish();
      }
    });

    worker.once('error', error => {
      finish(error);
    });

    worker.once('exit', code => {
      if (!settled) {
        finish(new Error(`Hub 启动前退出 (code=${code})\n${stderrChunks.join('')}`));
      }
    });

    function finish(error = null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (error) {
        try {
          worker.terminate();
        } catch {}
        cleanupDbFiles(dbPath);
        reject(error);
        return;
      }

      resolve({ worker, port, dbPath, stderrChunks });
    }
  }));
}

async function stopHub(state) {
  if (!state) return;

  const { worker, dbPath } = state;

  try {
    if (worker) {
      await Promise.race([
        worker.terminate().catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 2_000)),
      ]);
    }
  } finally {
    cleanupDbFiles(dbPath);
  }
}

function cleanupDbFiles(dbPath) {
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      rmSync(file, { force: true });
    } catch {}
  }
}

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function workerRequest(worker, action, payload) {
  return new Promise((resolve, reject) => {
    const requestId = `${action}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`worker request timeout: ${action}`));
    }, WORKER_TIMEOUT);

    const onMessage = (message) => {
      if (message?.type !== 'test-hook:result' || message.requestId !== requestId) {
        return;
      }

      if (message.ok) {
        finish(null, message.result);
      } else {
        finish(new Error(message.error || `worker request failed: ${action}`));
      }
    };

    worker.on('message', onMessage);
    worker.postMessage({ requestId, action, payload });

    function finish(error = null, result = null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.off('message', onMessage);

      if (error) {
        reject(error);
        return;
      }

      resolve(result);
    }
  });
}

function readSuspendedSessions(dbPath) {
  const db = new Database(dbPath);
  try {
    return db.prepare(`
      SELECT name, reason, task_description, suspended_at, suspended_by
      FROM suspended_sessions
      ORDER BY suspended_at ASC
    `).all();
  } finally {
    db.close();
  }
}

function postSuspend(port, payload) {
  return httpRequest(port, {
    method: 'POST',
    path: '/suspend',
    json: payload,
  });
}

function httpRequest(port, { method, path, json, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const payload = json === undefined ? body : JSON.stringify(json);
    const requestHeaders = { ...headers };

    if (json !== undefined && !requestHeaders['Content-Type']) {
      requestHeaders['Content-Type'] = 'application/json';
    }

    if (payload !== undefined) {
      requestHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const request = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: requestHeaders,
      },
      response => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', chunk => {
          responseBody += chunk;
        });
        response.on('end', () => {
          let parsedBody = null;
          if (responseBody.length > 0) {
            try {
              parsedBody = JSON.parse(responseBody);
            } catch {
              parsedBody = responseBody;
            }
          }

          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
            body: parsedBody,
            rawBody: responseBody,
          });
        });
      },
    );

    request.once('error', reject);

    if (payload !== undefined) {
      request.write(payload);
    }

    request.end();
  });
}

function connectSession(port, name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}?name=${encodeURIComponent(name)}`);
    let settled = false;

    const timer = setTimeout(() => {
      finish(new Error(`WebSocket 连接超时: ${name}`));
    }, WS_TIMEOUT);

    const onError = error => {
      finish(error);
    };

    const onMessage = raw => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (message.type === 'registered' && message.name === name) {
        finish();
      }
    };

    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'register', name }));
    });
    ws.on('message', onMessage);
    ws.once('error', onError);

    function finish(error = null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);

      if (error) {
        try {
          ws.close();
        } catch {}
        reject(error);
        return;
      }

      resolve(ws);
    }
  });
}

async function subscribeToTopic(ws, topic) {
  const subscribed = waitForWebSocketMessage(
    ws,
    message => message.type === 'subscribed' && message.topic === topic,
  );
  ws.send(JSON.stringify({ type: 'subscribe', topic }));
  await subscribed;
}

function waitForWebSocketMessage(ws, predicate, timeout = WS_TIMEOUT) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error('等待 WebSocket 消息超时'));
    }, timeout);

    const onMessage = raw => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (predicate(message)) {
        finish(null, message);
      }
    };

    const onError = error => {
      finish(error);
    };

    const onClose = () => {
      finish(new Error('WebSocket 在收到目标消息前已关闭'));
    };

    ws.on('message', onMessage);
    ws.once('error', onError);
    ws.once('close', onClose);

    function finish(error = null, message = null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
      ws.off('close', onClose);

      if (error) {
        reject(error);
        return;
      }

      resolve(message);
    }
  });
}

function closeWebSocket(ws) {
  if (!ws || ws.readyState === WebSocket.CLOSED) {
    return Promise.resolve();
  }

  return new Promise(resolve => {
    let finished = false;
    const timer = setTimeout(() => {
      finish();
    }, 1_000);

    ws.once('close', () => {
      finish();
    });

    try {
      ws.close();
    } catch {
      finish();
    }

    function finish() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve();
    }
  });
}
