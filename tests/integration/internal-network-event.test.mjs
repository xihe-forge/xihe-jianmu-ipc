import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { createHttpHandler } from '../../lib/http-handlers.mjs';
import { getTempDbPath } from '../helpers/temp-path.mjs';

const ROOT_DIR = fileURLToPath(new URL('../../', import.meta.url));
const INTERNAL_TOKEN = 'test-internal-token';
const TEST_TIMEOUT = 20_000;
const HUB_START_TIMEOUT = 3_000;
const WORKER_CONTROL_TIMEOUT = 1_000;
const WS_TIMEOUT = 3_000;
const DEDUPE_WAIT_MS = 5_200;
const HUB_CLOCK_START_MS = 1_776_516_000_000;

let hub = null;

beforeEach(async () => {
  hub = await startHub();
});

afterEach(async () => {
  await stopHub(hub);
  hub = null;
});

test('POST /internal/network-event: network-down happy path 会广播到订阅者', { timeout: TEST_TIMEOUT }, async () => {
  const ws = await connectSession(hub.port, 'internal-down-listener');

  try {
    await subscribeToTopic(ws, 'network-down');

    const payload = {
      event: 'network-down',
      failing: ['cliproxy', 'anthropic'],
      since: 1776516000000,
      triggeredBy: 'watchdog',
      ts: 1776516090000,
    };
    const receive = waitForWebSocketMessage(ws, message => message.type === 'network-down');
    const response = await postInternalEvent(hub.port, payload);
    const message = await receive;

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { ok: true, broadcastTo: 1 });
    assert.deepEqual(
      Object.keys(message).sort(),
      ['failing', 'since', 'triggeredBy', 'ts', 'type'],
    );
    assert.deepEqual(message, {
      type: 'network-down',
      failing: ['cliproxy', 'anthropic'],
      since: 1776516000000,
      triggeredBy: 'watchdog',
      ts: 1776516090000,
    });
  } finally {
    await closeWebSocket(ws);
  }
});

test('POST /internal/network-event: network-up happy path 会返回 clearedSessions 并广播 suspendedSessions', { timeout: TEST_TIMEOUT }, async () => {
  const ws = await connectSession(hub.port, 'internal-up-listener');

  try {
    await subscribeToTopic(ws, 'network-up');
    await postSuspend(hub.port, {
      from: 'alpha-session',
      reason: 'network down',
      task_description: 'resume alpha',
      suspended_by: 'self',
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    await postSuspend(hub.port, {
      from: 'beta-session',
      reason: 'network down',
      task_description: 'resume beta',
      suspended_by: 'watchdog',
    });

    const payload = {
      event: 'network-up',
      recoveredAfter: 600000,
      triggeredBy: 'watchdog',
      ts: 1776516690000,
    };
    const receive = waitForWebSocketMessage(ws, message => message.type === 'network-up');
    const response = await postInternalEvent(hub.port, payload);
    const message = await receive;

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      ok: true,
      broadcastTo: 1,
      clearedSessions: ['alpha-session', 'beta-session'],
    });
    assert.deepEqual(
      Object.keys(message).sort(),
      ['recoveredAfter', 'suspendedSessions', 'triggeredBy', 'ts', 'type'],
    );
    assert.deepEqual(message, {
      type: 'network-up',
      recoveredAfter: 600000,
      suspendedSessions: ['alpha-session', 'beta-session'],
      triggeredBy: 'watchdog',
      ts: 1776516690000,
    });
  } finally {
    await closeWebSocket(ws);
  }
});

test('POST /internal/network-event: 外网 IP 访问返回 403', { timeout: TEST_TIMEOUT }, async () => {
  const handler = createHttpHandler(createStubHandlerContext());
  const server = http.createServer((req, res) => {
    Object.defineProperty(req.socket, 'remoteAddress', {
      configurable: true,
      value: '10.0.0.2',
    });
    handler(req, res);
  });

  try {
    const port = await listenServer(server);
    const response = await postInternalEvent(port, {
      event: 'network-down',
      failing: ['hub'],
      since: 1,
      triggeredBy: 'watchdog',
      ts: 2,
    });

    assert.equal(response.statusCode, 403);
    assert.deepEqual(response.body, { ok: false, error: 'forbidden' });
  } finally {
    await closeServer(server);
  }
});

test('POST /internal/network-event: 错 token 返回 403', { timeout: TEST_TIMEOUT }, async () => {
  const response = await postInternalEvent(hub.port, {
    event: 'network-down',
    failing: ['hub'],
    since: 1,
    triggeredBy: 'watchdog',
    ts: 2,
  }, 'wrong-token');

  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.body, { ok: false, error: 'invalid token' });
});

test('POST /internal/network-event: 缺 token 返回 403', { timeout: TEST_TIMEOUT }, async () => {
  const response = await postInternalEvent(hub.port, {
    event: 'network-down',
    failing: ['hub'],
    since: 1,
    triggeredBy: 'watchdog',
    ts: 2,
  }, null);

  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.body, { ok: false, error: 'invalid token' });
});

test('POST /internal/network-event: 非法 JSON 返回 400', { timeout: TEST_TIMEOUT }, async () => {
  const response = await httpRequest(hub.port, {
    method: 'POST',
    path: '/internal/network-event',
    body: '{"event"',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Token': INTERNAL_TOKEN,
    },
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, { ok: false, error: 'invalid json' });
});

test('POST /internal/network-event: 非法 event 枚举返回 400', { timeout: TEST_TIMEOUT }, async () => {
  const response = await postInternalEvent(hub.port, {
    event: 'network-flap',
    triggeredBy: 'watchdog',
    ts: 1776516090000,
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, { ok: false, error: 'invalid event' });
});

test('POST /internal/network-event: 5 秒内同一事件按 sorted failing 去重，超时后重新广播', { timeout: TEST_TIMEOUT }, async () => {
  const ws = await connectSession(hub.port, 'internal-dedup-listener');

  try {
    await subscribeToTopic(ws, 'network-down');

    const firstPayload = {
      event: 'network-down',
      failing: ['hub', 'dns'],
      since: 1776516000000,
      triggeredBy: 'watchdog',
      ts: 1776516090000,
    };
    const secondPayload = {
      ...firstPayload,
      failing: ['dns', 'hub'],
    };

    const receiveFirst = waitForWebSocketMessage(ws, message => message.type === 'network-down');
    const firstResponse = await postInternalEvent(hub.port, firstPayload);
    const firstMessage = await receiveFirst;

    const secondResponse = await postInternalEvent(hub.port, secondPayload);
    await expectNoWebSocketMessage(ws, message => message.type === 'network-down');

    await advanceHubClock(hub.worker, DEDUPE_WAIT_MS);

    const receiveThird = waitForWebSocketMessage(ws, message => message.type === 'network-down');
    const thirdResponse = await postInternalEvent(hub.port, secondPayload);
    const thirdMessage = await receiveThird;

    assert.equal(firstResponse.statusCode, 200);
    assert.deepEqual(firstResponse.body, { ok: true, broadcastTo: 1 });
    assert.deepEqual(firstMessage, {
      type: 'network-down',
      failing: ['hub', 'dns'],
      since: 1776516000000,
      triggeredBy: 'watchdog',
      ts: 1776516090000,
    });

    assert.equal(secondResponse.statusCode, 200);
    assert.deepEqual(secondResponse.body, { ok: true, deduped: true });

    assert.equal(thirdResponse.statusCode, 200);
    assert.deepEqual(thirdResponse.body, { ok: true, broadcastTo: 1 });
    assert.deepEqual(thirdMessage, {
      type: 'network-down',
      failing: ['dns', 'hub'],
      since: 1776516000000,
      triggeredBy: 'watchdog',
      ts: 1776516090000,
    });
  } finally {
    await closeWebSocket(ws);
  }
});

function createTempDbPath() {
  return getTempDbPath('internal-network-event');
}

function createStubHandlerContext(overrides = {}) {
  return {
    sessions: new Map(),
    routeMessage: () => {},
    broadcastToTopic: () => [],
    broadcastNetworkDown: async () => ({ broadcastTo: 0, subscribers: [] }),
    broadcastNetworkUp: async () => ({ broadcastTo: 0, subscribers: [], clearedSessions: [] }),
    checkAuth: () => true,
    authTokens: null,
    AUTH_TOKEN: null,
    INTERNAL_TOKEN,
    createMessage: (value) => value,
    createTask: (value) => value,
    TASK_STATUSES: [],
    saveTask: () => {},
    getTask: () => null,
    updateTaskStatus: () => {},
    listTasks: () => [],
    getTaskStats: () => [],
    getMessages: () => [],
    getMessageCount: () => 0,
    getMessageCountByAgent: () => [],
    suspendSession: () => ({}),
    feishuApps: [],
    getFeishuToken: async () => null,
    stderr: () => {},
    audit: () => {},
    hubDir: ROOT_DIR,
    ...overrides,
  };
}

function startHub() {
  return findAvailablePort().then((port) => new Promise((resolve, reject) => {
    const dbPath = createTempDbPath();
    const stderrChunks = [];
    const hubUrl = pathToFileURL(join(ROOT_DIR, 'hub.mjs')).href;
    const worker = new Worker(
      `
        const { parentPort } = require('node:worker_threads');
        let fakeNow = ${JSON.stringify(HUB_CLOCK_START_MS)};

        Date.now = () => {
          fakeNow += 1;
          return fakeNow;
        };

        parentPort.on('message', (message) => {
          if (!message || message.type !== 'test-clock') {
            return;
          }

          if (message.command === 'advance') {
            fakeNow += Number(message.deltaMs) || 0;
          } else if (message.command === 'set') {
            fakeNow = Number(message.value) || fakeNow;
          }

          parentPort.postMessage({
            type: 'test-clock:ack',
            requestId: message.requestId,
            now: fakeNow,
          });
        });

        process.env.IPC_PORT = ${JSON.stringify(String(port))};
        process.env.IPC_DB_PATH = ${JSON.stringify(dbPath)};
        process.env.IPC_INTERNAL_TOKEN = ${JSON.stringify(INTERNAL_TOKEN)};
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

      resolve({ worker, port, dbPath });
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

function advanceHubClock(worker, deltaMs) {
  return sendClockCommand(worker, {
    command: 'advance',
    deltaMs,
  });
}

function sendClockCommand(worker, payload) {
  return new Promise((resolve, reject) => {
    const requestId = `clock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`worker clock command timeout: ${payload.command}`));
    }, WORKER_CONTROL_TIMEOUT);

    const onMessage = (message) => {
      if (message?.type !== 'test-clock:ack' || message.requestId !== requestId) {
        return;
      }

      finish(null, message.now);
    };

    worker.on('message', onMessage);
    worker.postMessage({
      type: 'test-clock',
      requestId,
      ...payload,
    });

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

function listenServer(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : null);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function postInternalEvent(port, payload, token = INTERNAL_TOKEN) {
  const headers = {};
  if (token !== null) {
    headers['X-Internal-Token'] = token;
  }

  return httpRequest(port, {
    method: 'POST',
    path: '/internal/network-event',
    json: payload,
    headers,
  });
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
    const requestHeaders = {
      Connection: 'close',
      ...headers,
    };

    if (json !== undefined && !requestHeaders['Content-Type']) {
      requestHeaders['Content-Type'] = 'application/json';
    }

    if (payload !== undefined) {
      requestHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const request = http.request(
      {
        agent: false,
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
