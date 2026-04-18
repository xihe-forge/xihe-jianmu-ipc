import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { getTempDbPath } from '../helpers/temp-path.mjs';

const ROOT_DIR = fileURLToPath(new URL('../../', import.meta.url));
const TEST_TIMEOUT = 5_000;
const HUB_START_TIMEOUT = 3_000;
const WS_TIMEOUT = 1_500;
const HEARTBEAT_INTERVAL_MS = 150;
const HEARTBEAT_TIMEOUT_MS = 450;

test('heartbeat: 客户端自动回 pong 后下一轮不会被 terminate', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub();
  const sessionName = uniqueName('alive');

  try {
    const ws = await connectSession(hub.port, sessionName);

    try {
      await waitForPingCount(ws, 2);

      assert.equal(ws.readyState, WebSocket.OPEN);

      const health = await waitForHealth(
        hub.port,
        body => body.sessions.some(session => session.name === sessionName),
      );

      assert.ok(health.sessions.some(session => session.name === sessionName));
    } finally {
      await closeWebSocket(ws);
    }
  } finally {
    await stopHub(hub);
  }
});

test('heartbeat: 客户端不回 pong 时下一轮会被 terminate', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub();
  const sessionName = uniqueName('silent');

  try {
    const ws = await connectSession(hub.port, sessionName, { autoPong: false });

    try {
      const closePromise = waitForClose(ws);

      await waitForPingCount(ws, 1);
      const closeEvent = await closePromise;

      assert.equal(closeEvent.code, 1006);

      const health = await waitForHealth(
        hub.port,
        body => !body.sessions.some(session => session.name === sessionName),
      );

      assert.ok(!health.sessions.some(session => session.name === sessionName));
      assert.match(
        hub.stderrChunks.join(''),
        new RegExp(`heartbeat timeout: terminating ${sessionName}`),
      );
    } finally {
      await closeWebSocket(ws);
    }
  } finally {
    await stopHub(hub);
  }
});

test('heartbeat: interval 调用 unref 避免阻塞进程退出', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ observeHeartbeatUnref: true });

  try {
    const event = await waitForWorkerEvent(hub, message => message.type === 'heartbeat-unref');

    assert.deepEqual(event, { type: 'heartbeat-unref' });
  } finally {
    await stopHub(hub);
  }
});

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function randomPort() {
  return Math.floor(45000 + Math.random() * 10000);
}

function createTempDbPath() {
  return getTempDbPath('heartbeat');
}

function startHub({
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
  heartbeatTimeoutMs = HEARTBEAT_TIMEOUT_MS,
  observeHeartbeatUnref = false,
} = {}) {
  return new Promise((resolve, reject) => {
    const port = randomPort();
    const dbPath = createTempDbPath();
    const stderrChunks = [];
    const workerEvents = [];
    const workerWaiters = [];
    const hubUrl = pathToFileURL(join(ROOT_DIR, 'hub.mjs')).href;
    const worker = new Worker(
      `
        const { parentPort } = require('node:worker_threads');
        const originalSetInterval = globalThis.setInterval.bind(globalThis);
        const originalSetTimeout = globalThis.setTimeout.bind(globalThis);
        const heartbeatIntervalMs = ${JSON.stringify(heartbeatIntervalMs)};
        const heartbeatTimeoutMs = ${JSON.stringify(heartbeatTimeoutMs)};
        const observeHeartbeatUnref = ${JSON.stringify(observeHeartbeatUnref)};
        let thirtySecondIntervalCount = 0;

        globalThis.setInterval = function (fn, delay, ...args) {
          const isThirtySecondInterval = delay === 30000;
          if (isThirtySecondInterval) {
            thirtySecondIntervalCount += 1;
          }

          const timer = originalSetInterval(
            fn,
            delay === 30000 ? heartbeatIntervalMs : delay,
            ...args,
          );

          // hub.mjs 在顶层只创建两个 30s interval：ack 清理和 heartbeat。第二个就是 heartbeat。
          if (
            observeHeartbeatUnref &&
            isThirtySecondInterval &&
            thirtySecondIntervalCount === 2 &&
            timer &&
            typeof timer.unref === 'function'
          ) {
            const originalUnref = timer.unref.bind(timer);
            timer.unref = (...unrefArgs) => {
              parentPort.postMessage({ type: 'heartbeat-unref' });
              return originalUnref(...unrefArgs);
            };
          }

          return timer;
        };

        globalThis.setTimeout = function (fn, delay, ...args) {
          return originalSetTimeout(
            fn,
            delay === 10000 ? heartbeatTimeoutMs : delay,
            ...args,
          );
        };

        process.env.IPC_PORT = ${JSON.stringify(String(port))};
        process.env.IPC_DB_PATH = ${JSON.stringify(dbPath)};
        import(${JSON.stringify(hubUrl)}).catch(error => {
          setImmediate(() => {
            throw error;
          });
        });
      `,
      {
        eval: true,
        stdout: true,
        stderr: true,
      },
    );

    worker.stderr.setEncoding('utf8');

    worker.on('message', message => {
      workerEvents.push(message);

      for (let index = 0; index < workerWaiters.length; index += 1) {
        const waiter = workerWaiters[index];
        if (!waiter.predicate(message)) continue;

        workerWaiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
        break;
      }
    });

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

      resolve({
        worker,
        workerEvents,
        workerWaiters,
        port,
        dbPath,
        stderrChunks,
      });
    }
  });
}

async function stopHub(hub) {
  if (!hub) return;

  const { worker, dbPath, workerWaiters } = hub;

  try {
    if (worker) {
      await Promise.race([
        worker.terminate().catch(() => {}),
        sleep(2_000),
      ]);
    }
  } finally {
    for (const waiter of workerWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('hub stopped before worker event'));
    }
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

function connectSession(port, name, options = {}) {
  const url = `ws://127.0.0.1:${port}?name=${encodeURIComponent(name)}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`WebSocket 连接超时: ${name}`));
    }, WS_TIMEOUT);
    const onError = error => {
      finish(error);
    };

    ws.once('open', () => {
      waitForHealth(port, body => body.sessions.some(session => session.name === name))
        .then(() => finish())
        .catch(error => finish(error));
    });

    ws.once('error', onError);

    function finish(error = null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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

function waitForPingCount(ws, expectedCount, timeout = WS_TIMEOUT) {
  return new Promise((resolve, reject) => {
    let count = 0;
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`等待 ping 超时，只收到 ${count}/${expectedCount}`));
    }, timeout);

    const onPing = () => {
      count += 1;
      if (count >= expectedCount) {
        finish();
      }
    };

    const onError = error => {
      finish(error);
    };

    const onClose = () => {
      finish(new Error('WebSocket 在收到预期 ping 前已关闭'));
    };

    ws.on('ping', onPing);
    ws.once('error', onError);
    ws.once('close', onClose);

    function finish(error = null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.off('ping', onPing);
      ws.off('error', onError);
      ws.off('close', onClose);

      if (error) {
        reject(error);
        return;
      }

      resolve();
    }
  });
}

function waitForClose(ws, timeout = WS_TIMEOUT) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error('等待 WebSocket 关闭超时'));
    }, timeout);

    const onClose = (code, reason) => {
      finish(null, { code, reason: reason.toString() });
    };

    const onError = error => {
      finish(error);
    };

    ws.once('close', onClose);
    ws.once('error', onError);

    function finish(error = null, closeEvent = null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.off('close', onClose);
      ws.off('error', onError);

      if (error) {
        reject(error);
        return;
      }

      resolve(closeEvent);
    }
  });
}

function waitForWorkerEvent(hub, predicate, timeout = HUB_START_TIMEOUT) {
  for (const message of hub.workerEvents) {
    if (predicate(message)) {
      return Promise.resolve(message);
    }
  }

  return new Promise((resolve, reject) => {
    const waiter = {
      predicate,
      resolve,
      reject,
      timer: null,
    };

    waiter.timer = setTimeout(() => {
      const index = hub.workerWaiters.indexOf(waiter);
      if (index >= 0) hub.workerWaiters.splice(index, 1);
      reject(new Error('等待 worker 事件超时'));
    }, timeout);

    hub.workerWaiters.push(waiter);
  });
}

function closeWebSocket(ws) {
  if (!ws || ws.readyState === WebSocket.CLOSED) {
    return Promise.resolve();
  }

  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(finish, 1_000);

    ws.once('close', finish);

    try {
      ws.close();
    } catch {
      finish();
    }

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    }
  });
}

function httpGetJson(port, path) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'GET',
      },
      response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => {
          body += chunk;
        });
        response.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    request.once('error', reject);
    request.end();
  });
}

async function waitForHealth(port, predicate, timeout = WS_TIMEOUT) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const body = await httpGetJson(port, '/health');
    if (predicate(body)) {
      return body;
    }
    await sleep(25);
  }

  throw new Error('等待 /health 条件超时');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
