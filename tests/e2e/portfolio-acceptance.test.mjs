import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import WebSocket from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const HUB_MJS = resolve(REPO_ROOT, 'hub.mjs');

const TEST_PORT = 31891;
const TEST_DB_DIR = resolve(REPO_ROOT, 'temp/test-portfolio-acceptance');
const TEST_DB_PATH = resolve(TEST_DB_DIR, 'messages.db');
const HUB_BASE = `http://127.0.0.1:${TEST_PORT}`;
const WS_BASE = `ws://127.0.0.1:${TEST_PORT}`;
const MESSAGE_TIMEOUT = 5_000;

let hubProcess = null;

async function startTestHub() {
  await mkdir(TEST_DB_DIR, { recursive: true });
  await rm(TEST_DB_PATH, { force: true });
  await rm(`${TEST_DB_PATH}-wal`, { force: true });
  await rm(`${TEST_DB_PATH}-shm`, { force: true });

  hubProcess = spawn('node', [HUB_MJS], {
    env: {
      ...process.env,
      IPC_PORT: String(TEST_PORT),
      IPC_DB_PATH: TEST_DB_PATH,
      IPC_HUB_AUTOSTART: 'false',
    },
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  for (let index = 0; index < 50; index += 1) {
    try {
      const response = await fetch(`${HUB_BASE}/health`);
      if (response.ok) return;
    } catch {}
    await wait(200);
  }

  throw new Error('Hub did not become healthy within 10s');
}

async function stopTestHub() {
  if (!hubProcess) return;

  const processToStop = hubProcess;
  hubProcess = null;
  processToStop.kill('SIGTERM');
  await Promise.race([
    new Promise(resolveStop => processToStop.once('exit', resolveStop)),
    wait(1_000),
  ]);
  if (!processToStop.killed) processToStop.kill('SIGKILL');
}

async function ipcConnect(name, opts = {}) {
  const url = `${WS_BASE}/?name=${encodeURIComponent(name)}${opts.force ? '&force=1' : ''}`;
  const ws = new WebSocket(url);
  const messages = [];
  const waiters = [];

  ws.on('message', data => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }

    const waiterIndex = waiters.findIndex(waiter => waiter.predicate(message));
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }

    messages.push(message);
  });

  await new Promise((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => rejectOpen(new Error(`ws connect timeout ${name}`)), MESSAGE_TIMEOUT);
    ws.once('open', () => {
      clearTimeout(timer);
      resolveOpen();
    });
    ws.once('error', error => {
      clearTimeout(timer);
      rejectOpen(error);
    });
  });

  await waitForHealth(body => body.sessions.some(session => session.name === name));
  return { ws, messages, waiters };
}

function createMessage(from, to, content) {
  return {
    type: 'message',
    from,
    to,
    content,
    id: `portfolio-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    ts: Date.now(),
  };
}

function waitForClientMessage(client, predicate, timeout = MESSAGE_TIMEOUT) {
  const queuedIndex = client.messages.findIndex(predicate);
  if (queuedIndex >= 0) {
    return Promise.resolve(client.messages.splice(queuedIndex, 1)[0]);
  }

  return new Promise((resolveMessage, rejectMessage) => {
    const waiter = {
      predicate,
      resolve: resolveMessage,
      reject: rejectMessage,
      timer: null,
    };
    waiter.timer = setTimeout(() => {
      const waiterIndex = client.waiters.indexOf(waiter);
      if (waiterIndex >= 0) client.waiters.splice(waiterIndex, 1);
      rejectMessage(new Error(`waitForClientMessage timeout; queued=${JSON.stringify(client.messages)}`));
    }, timeout);
    client.waiters.push(waiter);
  });
}

async function closeClient(client) {
  if (!client?.ws || client.ws.readyState === WebSocket.CLOSED) return;

  await new Promise(resolveClose => {
    const timer = setTimeout(resolveClose, 1_000);
    client.ws.once('close', () => {
      clearTimeout(timer);
      resolveClose();
    });
    client.ws.close();
  });
}

async function waitForHealth(predicate, timeout = MESSAGE_TIMEOUT) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const response = await fetch(`${HUB_BASE}/health`);
    if (response.ok) {
      const body = await response.json();
      if (predicate(body)) return body;
    }
    await wait(50);
  }

  throw new Error('waitForHealth timeout');
}

describe('AC-PORTFOLIO-ACCEPTANCE-001 portfolio acceptance e2e self-test', () => {
  before(startTestHub);
  after(stopTestHub);

  test('AC-PORTFOLIO-ACCEPTANCE-001-a: Hub /health returns ok + session list + uptime', async () => {
    const response = await fetch(`${HUB_BASE}/health`);
    assert.equal(response.status, 200);

    const data = await response.json();
    assert.equal(data.ok, true);
    assert.ok(Array.isArray(data.sessions));
    assert.ok(Number.isFinite(data.sessions.length));
    assert.ok(Number.isFinite(data.uptime));
  });

  test('AC-PORTFOLIO-ACCEPTANCE-001-b: two IPC clients connect + unicast send/recv', async () => {
    const alice = await ipcConnect('alice-acceptance');
    const bob = await ipcConnect('bob-acceptance');

    try {
      const message = createMessage('alice-acceptance', 'bob-acceptance', 'hello bob');
      const receiveBob = waitForClientMessage(
        bob,
        incoming => incoming.type === 'message' && incoming.id === message.id,
      );
      alice.ws.send(JSON.stringify(message));

      const fromAlice = await receiveBob;
      assert.equal(fromAlice.from, 'alice-acceptance');
      assert.equal(fromAlice.to, 'bob-acceptance');
      assert.equal(fromAlice.content, 'hello bob');
    } finally {
      await closeClient(alice);
      await closeClient(bob);
    }
  });

  test('AC-PORTFOLIO-ACCEPTANCE-001-c: broadcast to=* reaches every in-flight recipient', async () => {
    const broadcaster = await ipcConnect('broadcast-a-acceptance');
    const receiverB = await ipcConnect('broadcast-b-acceptance');
    const receiverC = await ipcConnect('broadcast-c-acceptance');

    try {
      const message = createMessage('broadcast-a-acceptance', '*', 'broadcast-test');
      const receiveB = waitForClientMessage(receiverB, incoming => incoming.id === message.id);
      const receiveC = waitForClientMessage(receiverC, incoming => incoming.id === message.id);
      broadcaster.ws.send(JSON.stringify(message));

      const [messageB, messageC] = await Promise.all([receiveB, receiveC]);
      assert.equal(messageB.content, 'broadcast-test');
      assert.equal(messageC.content, 'broadcast-test');
    } finally {
      await closeClient(broadcaster);
      await closeClient(receiverB);
      await closeClient(receiverC);
    }
  });

  test('AC-PORTFOLIO-ACCEPTANCE-001-d: SQLite persistence replays offline inbox', async () => {
    const sender = await ipcConnect('sender-acceptance');

    try {
      sender.ws.send(JSON.stringify(createMessage('sender-acceptance', 'recipient-offline', 'persisted-msg')));
      await wait(300);
    } finally {
      await closeClient(sender);
    }

    const recipient = await ipcConnect('recipient-offline');
    try {
      const inbox = await waitForClientMessage(recipient, incoming => incoming.type === 'inbox');
      const replayed = inbox.messages.find(message => message.content === 'persisted-msg');
      assert.ok(replayed, `inbox replay failed: ${JSON.stringify(inbox)}`);
      assert.equal(replayed.from, 'sender-acceptance');
      assert.equal(replayed.to, 'recipient-offline');
    } finally {
      await closeClient(recipient);
    }
  });

  test('AC-PORTFOLIO-ACCEPTANCE-001-e: HTTP /send endpoint + /sessions list are consistent', async () => {
    const charlie = await ipcConnect('charlie-acceptance');

    try {
      const receiveCharlie = waitForClientMessage(
        charlie,
        incoming => incoming.type === 'message' && incoming.content === 'http-send-test',
      );
      const response = await fetch(`${HUB_BASE}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'http-sender',
          to: 'charlie-acceptance',
          content: 'http-send-test',
        }),
      });
      assert.equal(response.status, 200);

      const fromHttp = await receiveCharlie;
      assert.equal(fromHttp.from, 'http-sender');
      assert.equal(fromHttp.to, 'charlie-acceptance');

      const sessionsResponse = await fetch(`${HUB_BASE}/sessions`);
      assert.equal(sessionsResponse.status, 200);
      const sessionsList = await sessionsResponse.json();
      assert.ok(sessionsList.some(session => session.name === 'charlie-acceptance'));
    } finally {
      await closeClient(charlie);
    }
  });
});
