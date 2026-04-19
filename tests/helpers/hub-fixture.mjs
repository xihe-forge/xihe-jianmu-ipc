import { existsSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { getTempDbPath } from './temp-path.mjs';

const ROOT_DIR = fileURLToPath(new URL('../../', import.meta.url));
const HUB_URL = pathToFileURL(join(ROOT_DIR, 'hub.mjs')).href;

export const TEST_TIMEOUT = 10_000;
export const HUB_START_TIMEOUT = 3_000;
export const WS_TIMEOUT = 3_000;
export const AUDIT_LOG_PATH = join(ROOT_DIR, 'data', 'audit.log');

function randomPort() {
  return Math.floor(Math.random() * 10_000 + 40_000);
}

function createTempDbPath(prefix = 'hub-fixture') {
  return getTempDbPath(prefix);
}

export function buildSessionUrl(port, name, options = {}) {
  const params = new URLSearchParams({ name });
  if (options.token) params.set('token', options.token);
  if (options.force) params.set('force', '1');
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null) {
      params.set(key, String(value));
    }
  }
  return `ws://127.0.0.1:${port}?${params.toString()}`;
}

export function startHub({
  prefix = 'hub-fixture',
  env = {},
  heartbeatIntervalMs = null,
  heartbeatTimeoutMs = null,
  nowOffsetMs = 0,
  startTimeoutMs = HUB_START_TIMEOUT,
} = {}) {
  return new Promise((resolve, reject) => {
    const port = randomPort();
    const dbPath = env.IPC_DB_PATH || createTempDbPath(prefix);
    const stderrChunks = [];
    const envAssignments = Object.entries({
      IPC_PORT: String(port),
      IPC_DB_PATH: dbPath,
      ...env,
    }).map(([key, value]) => {
      if (value === undefined) return '';
      return `process.env[${JSON.stringify(key)}] = ${JSON.stringify(String(value))};`;
    }).join('\n');

    const worker = new Worker(
      `
        const { parentPort } = require('node:worker_threads');
        const originalSetInterval = globalThis.setInterval.bind(globalThis);
        const originalSetTimeout = globalThis.setTimeout.bind(globalThis);
        const originalDateNow = Date.now.bind(Date);
        const heartbeatIntervalMs = ${heartbeatIntervalMs == null ? 'null' : JSON.stringify(heartbeatIntervalMs)};
        const heartbeatTimeoutMs = ${heartbeatTimeoutMs == null ? 'null' : JSON.stringify(heartbeatTimeoutMs)};
        let nowOffsetMs = ${JSON.stringify(nowOffsetMs)};

        Date.now = function () {
          return originalDateNow() + nowOffsetMs;
        };

        parentPort.on('message', (message) => {
          if (message?.type === 'set-now-offset') {
            nowOffsetMs = Number(message.offsetMs) || 0;
          }
        });

        if (heartbeatIntervalMs != null) {
          globalThis.setInterval = function (fn, delay, ...args) {
            return originalSetInterval(fn, delay === 30000 ? heartbeatIntervalMs : delay, ...args);
          };
        }

        if (heartbeatTimeoutMs != null) {
          globalThis.setTimeout = function (fn, delay, ...args) {
            return originalSetTimeout(fn, delay === 10000 ? heartbeatTimeoutMs : delay, ...args);
          };
        }

        ${envAssignments}

        import(${JSON.stringify(HUB_URL)}).catch(error => {
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

    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`Hub 启动超时\n${stderrChunks.join('')}`));
    }, startTimeoutMs);

    worker.stderr.on('data', (chunk) => {
      stderrChunks.push(chunk);
      if (!settled && chunk.includes('listening on')) {
        finish();
      }
    });

    worker.once('error', (error) => {
      finish(error);
    });

    worker.once('exit', (code) => {
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

export async function stopHub(hub) {
  if (!hub) return;

  const { worker, dbPath } = hub;

  try {
    if (worker) {
      await Promise.race([
        worker.terminate().catch(() => {}),
        sleep(2_000),
      ]);
    }
  } finally {
    cleanupDbFiles(dbPath);
  }
}

export function workerRequest(worker, action, payload, timeout = WS_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const requestId = `${action}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`worker request timeout: ${action}`));
    }, timeout);

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

export function setHubNowOffset(hub, offsetMs) {
  hub?.worker?.postMessage({ type: 'set-now-offset', offsetMs });
}

function cleanupDbFiles(dbPath) {
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      rmSync(file, { force: true });
    } catch {}
  }
}

export function httpRequest(port, { method, path, json, body, headers = {} }) {
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
      (response) => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
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

export function connectSession(port, name, options = {}) {
  const url = buildSessionUrl(port, name, options);
  const wsOptions = {};
  if (Object.hasOwn(options, 'autoPong')) {
    wsOptions.autoPong = options.autoPong;
  }

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, wsOptions);
    ws._bufferedMessages = [];
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`WebSocket 连接超时: ${name}`));
    }, options.timeoutMs ?? WS_TIMEOUT);

    const onError = (error) => {
      finish(error);
    };

    const onClose = (code, reason) => {
      finish(new Error(`WebSocket 提前关闭: code=${code} reason=${reason.toString()}`));
    };

    const onMessage = (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }

      ws._bufferedMessages.push(message);
      if (message.type === 'registered' && message.name === name) {
        finish();
      }
    };

    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'register', name }));
    });
    ws.on('message', onMessage);
    ws.once('error', onError);
    ws.once('close', onClose);

    function finish(error = null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.off('error', onError);
      ws.off('close', onClose);

      if (error) {
        ws.off('message', onMessage);
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

export function waitForWebSocketMessage(ws, predicate, timeout = WS_TIMEOUT) {
  const bufferedMessages = Array.isArray(ws?._bufferedMessages) ? ws._bufferedMessages : [];
  const bufferedIndex = bufferedMessages.findIndex(predicate);
  if (bufferedIndex >= 0) {
    const [message] = bufferedMessages.splice(bufferedIndex, 1);
    return Promise.resolve(message);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error('等待 WebSocket 消息超时'));
    }, timeout);

    const onMessage = (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (!predicate(message)) {
        return;
      }

      const bufferedIndex = Array.isArray(ws._bufferedMessages)
        ? ws._bufferedMessages.findIndex(predicate)
        : -1;
      if (bufferedIndex >= 0) {
        ws._bufferedMessages.splice(bufferedIndex, 1);
      }

      finish(null, message);
    };

    const onError = (error) => {
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

export function waitForPingCount(ws, expectedCount, timeout = WS_TIMEOUT) {
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

    const onError = (error) => {
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

export function waitForClose(ws, timeout = WS_TIMEOUT) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error('等待 WebSocket 关闭超时'));
    }, timeout);

    const onClose = (code, reason) => {
      finish(null, { code, reason: reason.toString() });
    };

    const onError = (error) => {
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

export function closeWebSocket(ws) {
  if (!ws || ws.readyState === WebSocket.CLOSED) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
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

export async function waitForHealth(port, predicate, timeout = WS_TIMEOUT) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const response = await httpRequest(port, { method: 'GET', path: '/health' });
    if (predicate(response.body)) {
      return response.body;
    }
    await sleep(25);
  }

  throw new Error('等待 /health 条件超时');
}

export function readAuditEntries() {
  if (!existsSync(AUDIT_LOG_PATH)) {
    return [];
  }

  return readFileSync(AUDIT_LOG_PATH, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
