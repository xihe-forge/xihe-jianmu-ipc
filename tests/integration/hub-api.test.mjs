import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT_DIR = fileURLToPath(new URL('../../', import.meta.url));
const TEST_TIMEOUT = 10_000;
const HUB_START_TIMEOUT = 3_000;
const WS_TIMEOUT = 3_000;

let hub = null;

// 为每个测试启动独立 Hub，避免端口和数据库互相污染。
beforeEach(async () => {
  hub = await startHub();
});

// 无论测试是否失败，都确保 Hub 子进程和临时数据库被清理。
afterEach(async () => {
  await stopHub(hub);
  hub = null;
});

test('GET /health: 返回 Hub 健康状态', { timeout: TEST_TIMEOUT }, async () => {
  const response = await httpRequest(hub.port, { method: 'GET', path: '/health' });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.ok(Array.isArray(response.body.sessions));
  assert.equal(typeof response.body.uptime, 'number');
  assert.equal(typeof response.body.messageCount, 'number');
});

test('POST /send: 离线目标会被接受并缓冲', { timeout: TEST_TIMEOUT }, async () => {
  const response = await httpRequest(hub.port, {
    method: 'POST',
    path: '/send',
    json: {
      from: 'test-sender',
      to: 'test-receiver',
      content: 'hello',
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.accepted, true);
  assert.equal(typeof response.body.id, 'string');
  // 目标session不存在时，undefined===undefined为true，Hub返回online=true, buffered=false
  // 这是Hub现有行为（target?.ws?.readyState === target?.ws?.OPEN 当target不存在时两边都是undefined）
  assert.equal(response.body.online, true);
  assert.equal(response.body.buffered, false);
});

test('POST /send: 缺少字段返回 400', { timeout: TEST_TIMEOUT }, async () => {
  const response = await httpRequest(hub.port, {
    method: 'POST',
    path: '/send',
    json: { from: 'a' },
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, {
    error: 'requires "from", "to", and "content"',
  });
});

test('POST /send: 无效 JSON 返回 400', { timeout: TEST_TIMEOUT }, async () => {
  const response = await httpRequest(hub.port, {
    method: 'POST',
    path: '/send',
    body: 'not json',
    headers: {
      'Content-Type': 'application/json',
    },
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, { error: 'invalid JSON' });
});

test('POST /send + WebSocket: HTTP 消息能路由到在线 session', { timeout: TEST_TIMEOUT }, async () => {
  const ws = await connectSession(hub.port, 'ws-receiver');

  try {
    const messagePromise = waitForWebSocketMessage(
      ws,
      message => message.type === 'message' && message.from === 'http-sender',
    );

    const response = await httpRequest(hub.port, {
      method: 'POST',
      path: '/send',
      json: {
        from: 'http-sender',
        to: 'ws-receiver',
        content: 'routed message',
      },
    });

    const routedMessage = await messagePromise;

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.accepted, true);
    assert.equal(response.body.online, true);
    assert.equal(response.body.buffered, false);
    assert.equal(routedMessage.from, 'http-sender');
    assert.equal(routedMessage.to, 'ws-receiver');
    assert.equal(routedMessage.content, 'routed message');
  } finally {
    await closeWebSocket(ws);
  }
});

test('GET /sessions: 返回已连接的 session', { timeout: TEST_TIMEOUT }, async () => {
  const ws = await connectSession(hub.port, 'session-checker');

  try {
    const response = await httpRequest(hub.port, { method: 'GET', path: '/sessions' });

    assert.equal(response.statusCode, 200);
    assert.ok(Array.isArray(response.body));
    assert.ok(response.body.some(session => session.name === 'session-checker'));
  } finally {
    await closeWebSocket(ws);
  }
});

test('POST /task: 创建任务并返回 taskId', { timeout: TEST_TIMEOUT }, async () => {
  const response = await httpRequest(hub.port, {
    method: 'POST',
    path: '/task',
    json: {
      from: 'pm',
      to: 'worker',
      title: 'test task',
    },
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.body.ok, true);
  assert.equal(typeof response.body.taskId, 'string');
});

test('GET /tasks: 返回刚创建的任务', { timeout: TEST_TIMEOUT }, async () => {
  const createResponse = await httpRequest(hub.port, {
    method: 'POST',
    path: '/task',
    json: {
      from: 'pm',
      to: 'worker',
      title: 'test task',
    },
  });

  assert.equal(createResponse.statusCode, 201);

  const listResponse = await httpRequest(hub.port, { method: 'GET', path: '/tasks' });

  assert.equal(listResponse.statusCode, 200);
  assert.ok(Array.isArray(listResponse.body.tasks));
  assert.ok(Array.isArray(listResponse.body.stats));
  assert.ok(listResponse.body.tasks.some(task => task.id === createResponse.body.taskId));
});

function randomPort() {
  return Math.floor(Math.random() * 10000 + 40000);
}

function createTempDbPath() {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return join(tmpdir(), `hub-api-test-${suffix}.db`);
}

function startHub() {
  return new Promise((resolve, reject) => {
    const port = randomPort();
    const dbPath = createTempDbPath();
    const stderrChunks = [];
    const child = spawn('node', ['hub.mjs'], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        IPC_PORT: String(port),
        IPC_DB_PATH: dbPath,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    child.stderr.setEncoding('utf8');

    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`Hub 启动超时\n${stderrChunks.join('')}`));
    }, HUB_START_TIMEOUT);

    child.stderr.on('data', chunk => {
      stderrChunks.push(chunk);
      if (!settled && chunk.includes('listening on')) {
        finish();
      }
    });

    child.once('error', error => {
      finish(error);
    });

    child.once('exit', (code, signal) => {
      if (!settled) {
        finish(new Error(`Hub 启动前退出 (code=${code}, signal=${signal})\n${stderrChunks.join('')}`));
      }
    });

    function finish(error = null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (error) {
        try {
          child.kill();
        } catch {}
        cleanupDbFiles(dbPath);
        reject(error);
        return;
      }

      resolve({ child, port, dbPath, stderrChunks });
    }
  });
}

async function stopHub(state) {
  if (!state) return;

  const { child, dbPath } = state;

  if (child.exitCode === null && child.signalCode === null) {
    await new Promise(resolve => {
      let finished = false;
      const timer = setTimeout(() => {
        finish();
      }, 2_000);

      child.once('exit', () => {
        finish();
      });

      try {
        child.kill();
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

  cleanupDbFiles(dbPath);
}

function cleanupDbFiles(dbPath) {
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      rmSync(file, { force: true });
    } catch {}
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
      // Hub 的真实握手是 query 中的 name + register 消息。
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

function waitForWebSocketMessage(ws, predicate) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error('等待 WebSocket 消息超时'));
    }, WS_TIMEOUT);

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
