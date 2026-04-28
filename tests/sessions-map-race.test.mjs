import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import {
  closeWebSocket,
  connectSession,
  httpRequest,
  sleep,
  startHub,
  stopHub,
  waitForClose,
  waitForHealth,
  workerRequest,
} from './helpers/hub-fixture.mjs';

const ROOT_DIR = fileURLToPath(new URL('../', import.meta.url));
const HUB_SOURCE = join(ROOT_DIR, 'hub.mjs');
const TEST_TIMEOUT = 10_000;
const CLOSE_TIMEOUT = 2_000;

test('K.E sessions Map race: concurrent force-rebind keeps only the last same-name socket open', { timeout: TEST_TIMEOUT }, async () => {
  assertHubUsesPerNameMutex();

  const hub = await startHub({ prefix: 'sessions-map-race-force' });
  const name = uniqueName('ke-force');
  let seed = null;
  const clients = [];

  try {
    seed = await connectSession(hub.port, name, { register: { pid: 9000 } });
    clients.push(...startRaceClients(hub.port, name, { count: 8, force: true, pidBase: 9100 }));

    await Promise.all(clients.map((client) => client.opened));
    await waitForHealth(
      hub.port,
      (body) => body.sessions.some((session) => session.name === name && session.pid === 9107),
      3_000,
    );
    await Promise.all(clients.slice(0, -1).map((client) => waitUntilClosed(client.ws)));

    assert.equal(clients.at(-1).ws.readyState, WebSocket.OPEN);
    for (const client of clients.slice(0, -1)) {
      assert.notEqual(client.ws.readyState, WebSocket.OPEN, `${client.label} should be superseded`);
    }

    const sessions = await getSessions(hub.port);
    assert.deepEqual(
      sessions.filter((session) => session.name === name).map((session) => session.pid),
      [9107],
    );
  } finally {
    await Promise.all([closeWebSocket(seed), ...clients.map((client) => closeWebSocket(client.ws))]);
    await stopHub(hub);
  }
});

test('K.E sessions Map race: concurrent same-name non-force accepts first holder and closes the rest as name taken', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({ prefix: 'sessions-map-race-name-taken' });
  const name = uniqueName('ke-noforce');
  let holder = null;
  const clients = [];

  try {
    holder = await connectSession(hub.port, name, { register: { pid: 9200 } });
    clients.push(...startRaceClients(hub.port, name, { count: 7, force: false, pidBase: 9201 }));

    const closeEvents = await Promise.all(clients.map((client) => waitForClose(client.ws, CLOSE_TIMEOUT)));

    assert.equal(holder.readyState, WebSocket.OPEN);
    assert.deepEqual(
      closeEvents.map((event) => ({ code: event.code, reason: event.reason })),
      Array.from({ length: 7 }, () => ({ code: 4001, reason: 'name taken' })),
    );

    const sessions = await getSessions(hub.port);
    assert.deepEqual(
      sessions.filter((session) => session.name === name).map((session) => session.pid),
      [9200],
    );
  } finally {
    await Promise.all([closeWebSocket(holder), ...clients.map((client) => closeWebSocket(client.ws))]);
    await stopHub(hub);
  }
});

test('K.E sessions Map race: mixed force and zombie rebinds leave one terminal owner', { timeout: TEST_TIMEOUT }, async () => {
  const hub = await startHub({
    prefix: 'sessions-map-race-mixed',
    env: { IPC_ENABLE_TEST_HOOKS: '1' },
  });
  const name = uniqueName('ke-mixed');
  let current = null;
  const forceClients = [];

  try {
    current = await connectSession(hub.port, name, { register: { pid: 9300 } });

    for (let index = 0; index < 3; index += 1) {
      await workerRequest(hub.worker, 'setSessionIsAlive', { name, isAlive: false });
      const next = await connectSession(hub.port, name, {
        register: { pid: 9301 + index },
      });
      assert.notEqual(current.readyState, WebSocket.OPEN, `zombie owner ${index} should be evicted`);
      current = next;
    }

    forceClients.push(...startRaceClients(hub.port, name, { count: 5, force: true, pidBase: 9400 }));
    await Promise.all(forceClients.map((client) => client.opened));
    await waitForHealth(
      hub.port,
      (body) => body.sessions.some((session) => session.name === name && session.pid === 9404),
      3_000,
    );
    await Promise.all(forceClients.slice(0, -1).map((client) => waitUntilClosed(client.ws)));

    assert.notEqual(current.readyState, WebSocket.OPEN);
    assert.equal(forceClients.at(-1).ws.readyState, WebSocket.OPEN);

    const sessions = await getSessions(hub.port);
    assert.deepEqual(
      sessions.filter((session) => session.name === name).map((session) => session.pid),
      [9404],
    );
  } finally {
    await Promise.all([closeWebSocket(current), ...forceClients.map((client) => closeWebSocket(client.ws))]);
    await stopHub(hub);
  }
});

test('K.E sessions Map race: concurrent different names are protected by independent per-name locks', { timeout: TEST_TIMEOUT }, async () => {
  assertHubUsesPerNameMutex();

  const hub = await startHub({ prefix: 'sessions-map-race-per-name' });
  const nameA = uniqueName('ke-A');
  const nameB = uniqueName('ke-B');
  let seedA = null;
  let seedB = null;
  const clientsA = [];
  const clientsB = [];

  try {
    seedA = await connectSession(hub.port, nameA, { register: { pid: 9500 } });
    seedB = await connectSession(hub.port, nameB, { register: { pid: 9600 } });

    const startedAt = performance.now();
    const [durationA, durationB] = await Promise.all([
      runForceRace(hub.port, nameA, 9510, clientsA),
      runForceRace(hub.port, nameB, 9610, clientsB),
    ]);
    const totalMs = performance.now() - startedAt;

    await Promise.all([
      ...clientsA.slice(0, -1).map((client) => waitUntilClosed(client.ws)),
      ...clientsB.slice(0, -1).map((client) => waitUntilClosed(client.ws)),
    ]);

    assert.equal(clientsA.at(-1).ws.readyState, WebSocket.OPEN);
    assert.equal(clientsB.at(-1).ws.readyState, WebSocket.OPEN);
    assert.ok(Math.abs(durationA - durationB) < 50, `A/B duration skew too high: ${durationA}ms vs ${durationB}ms`);
    assert.ok(totalMs < Math.max(durationA, durationB) + 80, `races should overlap, total=${totalMs}ms`);

    const sessions = await getSessions(hub.port);
    const byName = new Map(sessions.map((session) => [session.name, session]));
    assert.equal(byName.get(nameA)?.pid, 9517);
    assert.equal(byName.get(nameB)?.pid, 9617);
  } finally {
    await Promise.all([
      closeWebSocket(seedA),
      closeWebSocket(seedB),
      ...clientsA.map((client) => closeWebSocket(client.ws)),
      ...clientsB.map((client) => closeWebSocket(client.ws)),
    ]);
    await stopHub(hub);
  }
});

async function runForceRace(port, name, pidBase, collector) {
  const startedAt = performance.now();
  collector.push(...startRaceClients(port, name, { count: 8, force: true, pidBase }));
  await Promise.all(collector.map((client) => client.opened));
  await waitForHealth(
    port,
    (body) => body.sessions.some((session) => session.name === name && session.pid === pidBase + 7),
    3_000,
  );
  return performance.now() - startedAt;
}

function startRaceClients(port, name, { count, force, pidBase }) {
  return Array.from({ length: count }, (_, index) => {
    const client = createRaceClient(port, name, {
      force,
      pid: pidBase + index,
      label: `${name}#${index + 1}`,
    });
    return client;
  });
}

function createRaceClient(port, name, { force, pid, label }) {
  const params = new URLSearchParams({ name });
  if (force) params.set('force', '1');
  const ws = new WebSocket(`ws://127.0.0.1:${port}?${params.toString()}`);
  ws.on('error', () => {});
  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`open timeout: ${label}`)), 2_000);
    ws.once('open', () => {
      clearTimeout(timer);
      ws.send(JSON.stringify({ type: 'register', name, pid }));
      resolve(ws);
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return { ws, opened, label, pid };
}

async function waitUntilClosed(ws) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  await waitForClose(ws, CLOSE_TIMEOUT).catch(() => {});
}

async function getSessions(port) {
  const response = await httpRequest(port, { method: 'GET', path: '/sessions' });
  assert.equal(response.statusCode, 200);
  return response.body;
}

function assertHubUsesPerNameMutex() {
  const source = readFileSync(HUB_SOURCE, 'utf8');
  assert.match(source, /from 'async-mutex'/);
  assert.match(source, /const sessionMutexes = new Map\(\)/);
  assert.match(source, /getSessionMutex\(name\)\.acquire\(\)/);
}

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}
