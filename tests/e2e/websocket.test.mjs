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
const TEST_TIMEOUT = 15_000;
const HUB_START_TIMEOUT = 5_000;
const MESSAGE_TIMEOUT = 4_000;
const MESSAGE_STATES = new WeakMap();

test('hello 注册后 /health 可见 session', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub();

  try {
    const ws = await connectSession(hub.port, 'hello-health');

    try {
      const health = await waitForHealth(hub.port, body =>
        body.sessions.some(session => session.name === 'hello-health'),
      );

      assert.equal(health.ok, true);
      assert.ok(health.sessions.some(session => session.name === 'hello-health'));
    } finally {
      await closeWs(ws);
    }
  } finally {
    await stopHub(hub);
  }
});

test('断开后 session 从 /health 列表消失', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub();

  try {
    const ws = await connectSession(hub.port, 'disconnect-health');
    await closeWs(ws);

    const health = await waitForHealth(hub.port, body =>
      !body.sessions.some(session => session.name === 'disconnect-health'),
    );

    assert.ok(!health.sessions.some(session => session.name === 'disconnect-health'));
  } finally {
    await stopHub(hub);
  }
});

test('断开后同名重连会 flush inbox 缓冲消息', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub();

  try {
    const receiver = await connectSession(hub.port, 'reconnect-b');
    await closeWs(receiver);
    await waitForHealth(hub.port, body =>
      !body.sessions.some(session => session.name === 'reconnect-b'),
    );

    const sender = await connectSession(hub.port, 'reconnect-a');
    try {
      sender.send(JSON.stringify(createMessage('reconnect-a', 'reconnect-b', 'buffered-on-reconnect')));
      await sleep(100);
    } finally {
      await closeWs(sender);
    }

    const reconnected = await connectSession(hub.port, 'reconnect-b');
    try {
      const inbox = await waitForMessage(reconnected, message => message.type === 'inbox');

      assert.deepEqual(
        inbox.messages.map(message => message.content),
        ['buffered-on-reconnect'],
      );
    } finally {
      await closeWs(reconnected);
    }
  } finally {
    await stopHub(hub);
  }
});

test('A 发消息给 B，B 收到正确 from/to/content', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub();

  try {
    const wsA = await connectSession(hub.port, 'direct-a');
    const wsB = await connectSession(hub.port, 'direct-b');

    try {
      const receivePromise = waitForMessage(
        wsB,
        message => message.type === 'message' && message.id === 'direct-msg-1',
      );

      wsA.send(JSON.stringify({
        ...createMessage('direct-a', 'direct-b', 'hello-direct'),
        id: 'direct-msg-1',
      }));

      const received = await receivePromise;
      assert.equal(received.from, 'direct-a');
      assert.equal(received.to, 'direct-b');
      assert.equal(received.content, 'hello-direct');
    } finally {
      await closeWs(wsA);
      await closeWs(wsB);
    }
  } finally {
    await stopHub(hub);
  }
});

test('广播 to=* 时 B 和 C 收到，A 不收到', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub();

  try {
    const wsA = await connectSession(hub.port, 'broadcast-a');
    const wsB = await connectSession(hub.port, 'broadcast-b');
    const wsC = await connectSession(hub.port, 'broadcast-c');

    try {
      const message = {
        ...createMessage('broadcast-a', '*', 'broadcast-body'),
        id: 'broadcast-msg-1',
      };

      const receiveB = waitForMessage(wsB, incoming => incoming.type === 'message' && incoming.id === message.id);
      const receiveC = waitForMessage(wsC, incoming => incoming.type === 'message' && incoming.id === message.id);
      const noReceiveA = expectNoMessage(wsA, incoming => incoming.type === 'message' && incoming.id === message.id, 400);

      wsA.send(JSON.stringify(message));

      const [receivedB, receivedC] = await Promise.all([receiveB, receiveC, noReceiveA]);
      assert.equal(receivedB.content, 'broadcast-body');
      assert.equal(receivedC.content, 'broadcast-body');
    } finally {
      await closeWs(wsA);
      await closeWs(wsB);
      await closeWs(wsC);
    }
  } finally {
    await stopHub(hub);
  }
});

test('topic 订阅后能收到对应 topic 消息', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub();

  try {
    const wsA = await connectSession(hub.port, 'topic-a');
    const wsB = await connectSession(hub.port, 'topic-b');

    try {
      const subscribed = waitForMessage(
        wsA,
        message => message.type === 'subscribed' && message.topic === 'alerts',
      );
      wsA.send(JSON.stringify({ type: 'subscribe', topic: 'alerts' }));
      await subscribed;

      const receivePromise = waitForMessage(
        wsA,
        message => message.type === 'message' && message.id === 'topic-msg-1',
      );

      wsB.send(JSON.stringify({
        ...createMessage('topic-b', '*', 'topic-body'),
        id: 'topic-msg-1',
        topic: 'alerts',
      }));

      const received = await receivePromise;
      assert.equal(received.topic, 'alerts');
      assert.equal(received.content, 'topic-body');
    } finally {
      await closeWs(wsA);
      await closeWs(wsB);
    }
  } finally {
    await stopHub(hub);
  }
});

test('同一 msg.id 发两次时目标只收到一次', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub();

  try {
    const wsA = await connectSession(hub.port, 'dedup-a');
    const wsB = await connectSession(hub.port, 'dedup-b');

    try {
      const duplicateMessage = {
        ...createMessage('dedup-a', 'dedup-b', 'dedup-body'),
        id: 'duplicate-id-1',
      };

      const firstReceive = waitForMessage(
        wsB,
        message => message.type === 'message' && message.id === duplicateMessage.id,
      );

      wsA.send(JSON.stringify(duplicateMessage));
      wsA.send(JSON.stringify(duplicateMessage));

      const received = await firstReceive;
      assert.equal(received.id, 'duplicate-id-1');
      await expectNoMessage(
        wsB,
        message => message.type === 'message' && message.id === duplicateMessage.id,
        500,
      );
    } finally {
      await closeWs(wsA);
      await closeWs(wsB);
    }
  } finally {
    await stopHub(hub);
  }
});

test('发给不在线 B 的消息会在 B 上线后作为 inbox 收到', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub();

  try {
    const wsA = await connectSession(hub.port, 'offline-a');

    try {
      wsA.send(JSON.stringify({
        ...createMessage('offline-a', 'offline-b', 'offline-body'),
        id: 'offline-msg-1',
      }));
      await sleep(100);
    } finally {
      await closeWs(wsA);
    }

    const wsB = await connectSession(hub.port, 'offline-b');
    try {
      const inbox = await waitForMessage(wsB, message => message.type === 'inbox');

      assert.equal(inbox.messages.length, 1);
      assert.equal(inbox.messages[0].from, 'offline-a');
      assert.equal(inbox.messages[0].to, 'offline-b');
      assert.equal(inbox.messages[0].content, 'offline-body');
    } finally {
      await closeWs(wsB);
    }
  } finally {
    await stopHub(hub);
  }
});

test('通过 HTTP POST /task 创建 task 时目标 session 收到通知', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub();

  try {
    const wsB = await connectSession(hub.port, 'task-b');

    try {
      const receiveTask = waitForMessage(
        wsB,
        message =>
          message.type === 'message' &&
          message.from === 'task-a' &&
          message.to === 'task-b' &&
          message.topic === 'task' &&
          message.contentType === 'task',
      );

      const response = await httpPostJson(hub.port, '/task', {
        from: 'task-a',
        to: 'task-b',
        title: 'ship-it',
      });

      const task = await receiveTask;
      const payload = JSON.parse(task.content);

      assert.equal(response.ok, true);
      assert.equal(response.online, true);
      assert.equal(task.from, 'task-a');
      assert.equal(task.to, 'task-b');
      assert.equal(task.topic, 'task');
      assert.equal(task.contentType, 'task');
      assert.equal(payload.taskId, response.taskId);
      assert.equal(payload.title, 'ship-it');
    } finally {
      await closeWs(wsB);
    }
  } finally {
    await stopHub(hub);
  }
});

test('多 session 并发消息不丢失', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub();

  try {
    const sink = await connectSession(hub.port, 'sink');
    const senderNames = ['multi-a', 'multi-b', 'multi-c', 'multi-d'];
    const senders = [];

    try {
      for (const name of senderNames) {
        senders.push(await connectSession(hub.port, name));
      }

      const expectedIds = [];
      for (const name of senderNames) {
        for (let index = 0; index < 5; index += 1) {
          expectedIds.push(`${name}-${index}`);
        }
      }
      const expectedIdSet = new Set(expectedIds);

      for (const [senderIndex, ws] of senders.entries()) {
        const senderName = senderNames[senderIndex];
        for (let messageIndex = 0; messageIndex < 5; messageIndex += 1) {
          ws.send(JSON.stringify({
            ...createMessage(senderName, 'sink', `${senderName}-body-${messageIndex}`),
            id: `${senderName}-${messageIndex}`,
          }));
        }
      }

      const received = await collectMessages(
        sink,
        message => message.type === 'message' && expectedIdSet.has(message.id),
        expectedIds.length,
      );

      assert.equal(received.length, expectedIds.length);
      assert.deepEqual(
        new Set(received.map(message => message.id)),
        new Set(expectedIds),
      );
    } finally {
      for (const ws of senders) {
        await closeWs(ws);
      }
      await closeWs(sink);
    }
  } finally {
    await stopHub(hub);
  }
});

function createMessage(from, to, content) {
  return {
    type: 'message',
    from,
    to,
    content,
    id: `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    ts: Date.now(),
  };
}

function randomPort() {
  return Math.floor(50000 + Math.random() * 10000);
}

function createTempDbPath() {
  return getTempDbPath('e2e');
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
      finish(new Error(`hub startup timeout\n${stderrChunks.join('')}`));
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
        finish(new Error(`hub exited before ready (code=${code})\n${stderrChunks.join('')}`));
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
        cleanupDb(dbPath);
        reject(error);
        return;
      }

      resolve({ worker, port, dbPath });
    }
  });
}

async function stopHub(hub) {
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
    cleanupDb(dbPath);
  }
}

function cleanupDb(dbPath) {
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      rmSync(file, { force: true });
    } catch {}
  }
}

function rawConnect(port, name) {
  const url = name
    ? `ws://127.0.0.1:${port}?name=${encodeURIComponent(name)}`
    : `ws://127.0.0.1:${port}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ensureMessageState(ws);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('websocket open timeout'));
    }, MESSAGE_TIMEOUT);

    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });

    ws.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function connectSession(port, name) {
  const ws = await rawConnect(port, name);
  if (name) {
    await waitForHealth(port, body =>
      body.sessions.some(session => session.name === name),
    );
  }
  return ws;
}

function ensureMessageState(ws) {
  let state = MESSAGE_STATES.get(ws);
  if (state) return state;

  state = {
    queue: [],
    waiters: [],
  };

  ws.on('message', raw => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    for (let index = 0; index < state.waiters.length; index += 1) {
      const waiter = state.waiters[index];
      if (waiter.predicate(message)) {
        state.waiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
        return;
      }
    }

    state.queue.push(message);
  });

  ws.on('close', () => {
    const error = new Error('websocket closed before receiving expected message');
    for (const waiter of state.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  });

  ws.on('error', error => {
    for (const waiter of state.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  });

  MESSAGE_STATES.set(ws, state);
  return state;
}

function waitForMessage(ws, predicate, timeout = MESSAGE_TIMEOUT) {
  const state = ensureMessageState(ws);

  for (let index = 0; index < state.queue.length; index += 1) {
    if (predicate(state.queue[index])) {
      return Promise.resolve(state.queue.splice(index, 1)[0]);
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
      const waiterIndex = state.waiters.indexOf(waiter);
      if (waiterIndex >= 0) state.waiters.splice(waiterIndex, 1);
      reject(new Error('waitForMessage timeout'));
    }, timeout);

    state.waiters.push(waiter);
  });
}

async function collectMessages(ws, predicate, expectedCount, timeout = MESSAGE_TIMEOUT) {
  const deadline = Date.now() + timeout;
  const messages = [];

  while (messages.length < expectedCount) {
    messages.push(await waitForMessage(ws, predicate, Math.max(1, deadline - Date.now())));
  }

  return messages;
}

function expectNoMessage(ws, predicate, timeout = 300) {
  const state = ensureMessageState(ws);

  for (const message of state.queue) {
    if (predicate(message)) {
      return Promise.reject(new Error('unexpected message already queued'));
    }
  }

  return new Promise((resolve, reject) => {
    const waiter = {
      predicate,
      resolve: () => reject(new Error('unexpected message received')),
      reject,
      timer: null,
    };

    waiter.timer = setTimeout(() => {
      const waiterIndex = state.waiters.indexOf(waiter);
      if (waiterIndex >= 0) state.waiters.splice(waiterIndex, 1);
      resolve();
    }, timeout);

    state.waiters.push(waiter);
  });
}

function closeWs(ws) {
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
  return httpRequestJson(port, path, 'GET');
}

function httpPostJson(port, path, body) {
  return httpRequestJson(port, path, 'POST', body);
}

function httpRequestJson(port, path, method, body = null) {
  return new Promise((resolve, reject) => {
    const requestBody = body === null ? null : JSON.stringify(body);
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: requestBody === null
          ? undefined
          : {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(requestBody),
            },
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
    if (requestBody !== null) {
      request.write(requestBody);
    }
    request.end();
  });
}

async function waitForHealth(port, predicate, timeout = MESSAGE_TIMEOUT) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const body = await httpGetJson(port, '/health');
    if (predicate(body)) {
      return body;
    }
    await sleep(50);
  }

  throw new Error('waitForHealth timeout');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
