import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { rmSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { getTempDbPath } from '../helpers/temp-path.mjs';

const ROOT_DIR = fileURLToPath(new URL('../../', import.meta.url));
const TEST_TIMEOUT = 10_000;
const HUB_START_TIMEOUT = 3_000;
const WS_TIMEOUT = 3_000;

let hub = null;

beforeEach(async () => {
  hub = await startHub();
});

afterEach(async () => {
  await stopHub(hub);
  hub = null;
});

test('POST /wake-suspended: 通过 helper 广播 ADR payload 并清空 suspended_sessions', { timeout: TEST_TIMEOUT }, async () => {
  const wsA = await connectSession(hub.port, 'wake-a');
  const wsB = await connectSession(hub.port, 'wake-b');
  const wsC = await connectSession(hub.port, 'wake-c');
  const wsD = await connectSession(hub.port, 'wake-d');

  try {
    await subscribeToTopic(wsA, 'network-up');
    await subscribeToTopic(wsB, 'network-up');
    await subscribeToTopic(wsC, 'network-up');

    await httpRequest(hub.port, {
      method: 'POST',
      path: '/suspend',
      json: {
        from: 'suspend-a',
        reason: 'network down',
        task_description: 'resume task A',
        suspended_by: 'self',
      },
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    await httpRequest(hub.port, {
      method: 'POST',
      path: '/suspend',
      json: {
        from: 'suspend-b',
        reason: 'dns failure',
        task_description: 'resume task B',
        suspended_by: 'watchdog',
      },
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    await httpRequest(hub.port, {
      method: 'POST',
      path: '/suspend',
      json: {
        from: 'suspend-c',
        reason: 'hub unavailable',
        task_description: 'resume task C',
        suspended_by: 'harness',
      },
    });

    const receiveA = waitForWebSocketMessage(wsA, message => message.type === 'network-up');
    const receiveB = waitForWebSocketMessage(wsB, message => message.type === 'network-up');
    const receiveC = waitForWebSocketMessage(wsC, message => message.type === 'network-up');
    const noReceiveD = expectNoWebSocketMessage(wsD, message => message.type === 'network-up');

    const response = await httpRequest(hub.port, {
      method: 'POST',
      path: '/wake-suspended',
    });

    const [messageA, messageB, messageC] = await Promise.all([receiveA, receiveB, receiveC, noReceiveD]);

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.broadcastTo, 3);
    assert.deepEqual(
      response.body.subscribers.slice().sort(),
      ['wake-a', 'wake-b', 'wake-c'],
    );
    assert.deepEqual(response.body.clearedSessions, ['suspend-a', 'suspend-b', 'suspend-c']);

    for (const message of [messageA, messageB, messageC]) {
      assert.deepEqual(
        Object.keys(message).sort(),
        ['recoveredAfter', 'suspendedSessions', 'triggeredBy', 'ts', 'type'],
      );
      assert.equal(message.triggeredBy, 'manual');
      assert.equal(message.recoveredAfter, 0);
      assert.deepEqual(message.suspendedSessions, ['suspend-a', 'suspend-b', 'suspend-c']);
      assert.equal(typeof message.ts, 'number');
      assert.ok(message.ts > 0);
    }
    assert.deepEqual(readSuspendedSessions(hub.dbPath), []);
  } finally {
    await closeWebSocket(wsA);
    await closeWebSocket(wsB);
    await closeWebSocket(wsC);
    await closeWebSocket(wsD);
  }
});

test('POST /wake-suspended: 兼容旧 body，但广播 payload 仍严格走 helper', { timeout: TEST_TIMEOUT }, async () => {
  const ws = await connectSession(hub.port, 'wake-custom');

  try {
    await subscribeToTopic(ws, 'network-up');
    await httpRequest(hub.port, {
      method: 'POST',
      path: '/suspend',
      json: {
        from: 'legacy-suspended',
        reason: 'legacy reason',
        task_description: 'legacy task',
      },
    });

    const receive = waitForWebSocketMessage(ws, message => message.type === 'network-up');
    const response = await httpRequest(hub.port, {
      method: 'POST',
      path: '/wake-suspended',
      json: {
        reason: 'network restored',
        from: 'ops-script',
      },
    });
    const message = await receive;

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body.subscribers, ['wake-custom']);
    assert.deepEqual(response.body.clearedSessions, ['legacy-suspended']);
    assert.deepEqual(
      Object.keys(message).sort(),
      ['recoveredAfter', 'suspendedSessions', 'triggeredBy', 'ts', 'type'],
    );
    assert.equal(message.triggeredBy, 'manual');
    assert.equal(message.recoveredAfter, 0);
    assert.deepEqual(message.suspendedSessions, ['legacy-suspended']);
    assert.equal('reason' in message, false);
    assert.equal('from' in message, false);
  } finally {
    await closeWebSocket(ws);
  }
});

test('POST /wake-suspended: 非法 JSON body 返回 400', { timeout: TEST_TIMEOUT }, async () => {
  const response = await httpRequest(hub.port, {
    method: 'POST',
    path: '/wake-suspended',
    body: '{"reason"',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, { ok: false, error: 'invalid json' });
});

function randomPort() {
  return Math.floor(Math.random() * 10000 + 40000);
}

function createTempDbPath() {
  return getTempDbPath('wake-suspended');
}

function startHub() {
  return new Promise((resolve, reject) => {
    const port = randomPort();
    const dbPath = createTempDbPath();
    const stderrChunks = [];
    const hubUrl = pathToFileURL(join(ROOT_DIR, 'hub.mjs')).href;
    const worker = new Worker(
      `
        process.env.IPC_PORT = ${JSON.stringify(String(port))};
        process.env.IPC_DB_PATH = ${JSON.stringify(dbPath)};
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
  });
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

function expectNoWebSocketMessage(ws, predicate, timeout = 500) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish();
    }, timeout);

    const onMessage = raw => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (predicate(message)) {
        finish(new Error('收到不期望的 WebSocket 消息'));
      }
    };

    const onError = error => {
      finish(error);
    };

    ws.on('message', onMessage);
    ws.once('error', onError);

    function finish(error = null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);

      if (error) {
        reject(error);
        return;
      }

      resolve();
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
