import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createMcpTools } from '../../lib/mcp-tools.mjs';
import {
  closeWebSocket,
  connectSession,
  httpRequest,
  startHub,
  stopHub,
  waitForClose,
  waitForHealth,
  waitForWebSocketMessage,
} from '../helpers/hub-fixture.mjs';

function uniqueName(label) {
  return `rename-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function waitForNoMessage(ws, predicate, timeoutMs = 200) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(), timeoutMs);

    const onMessage = (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (predicate(message)) {
        finish(new Error(`unexpected message: ${raw.toString()}`));
      }
    };

    const onError = (error) => finish(error);

    ws.on('message', onMessage);
    ws.once('error', onError);

    function finish(error = null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
      if (error) reject(error);
      else resolve();
    }
  });
}

async function registerClient(port, name) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}?name=${encodeURIComponent(name)}`);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`register timeout: ${name}`)), 3_000);
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'register', name }));
    });
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      ws._bufferedMessages ??= [];
      ws._bufferedMessages.push(message);
      if (message.type === 'registered' && message.name === name) {
        clearTimeout(timer);
        resolve();
      }
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return ws;
}

test('ipc_rename atomic handoff releases old name before immediate same-name replacement', { timeout: 15_000 }, async () => {
  const hub = await startHub({ prefix: 'ipc-rename-atomic' });
  const baseName = uniqueName('base');
  const archivedName = `${baseName}-old`;
  let currentWs = await connectSession(hub.port, baseName);
  const reconnects = [];

  try {
    const tools = createMcpTools({
      getSessionName: () => baseNameState.name,
      setSessionName: (name) => {
        baseNameState.name = name;
      },
      getHubHost: () => '127.0.0.1',
      setHubHost: () => {},
      getHubPort: () => hub.port,
      setHubPort: () => {},
      getWs: () => currentWs,
      disconnectWs: () => {
        currentWs?.close();
        currentWs = null;
      },
      terminateWs: () => {
        currentWs?.terminate();
        currentWs = null;
      },
      reconnect: async () => {
        currentWs = await registerClient(hub.port, baseNameState.name);
        reconnects.push(baseNameState.name);
        return true;
      },
      getPendingOutgoingCount: () => 0,
      wsSend: (payload) => currentWs.send(JSON.stringify(payload)),
      httpGet: async (url) => {
        const parsed = new URL(url);
        return (await httpRequest(hub.port, { method: 'GET', path: parsed.pathname + parsed.search })).body;
      },
      httpPost: async (url, body) => {
        const parsed = new URL(url);
        return (await httpRequest(hub.port, { method: 'POST', path: parsed.pathname, json: body })).body;
      },
      httpPatch: async () => ({ ok: true }),
      spawnSession: async () => ({ spawned: true }),
      stderrLog: () => {},
    });
    const baseNameState = { name: baseName };

    const renameResult = await tools.handleToolCall('ipc_rename', { name: archivedName });
    assert.deepEqual(JSON.parse(renameResult.content[0].text), {
      renamed: true,
      from: baseName,
      to: archivedName,
    });
    assert.deepEqual(reconnects, [archivedName]);

    await waitForHealth(
      hub.port,
      (body) =>
        body.sessions.some((session) => session.name === archivedName) &&
        !body.sessions.some((session) => session.name === baseName),
      5_000,
    );

    const replacementWs = await connectSession(hub.port, baseName);
    const both = await waitForHealth(
      hub.port,
      (body) =>
        body.sessions.some((session) => session.name === archivedName) &&
        body.sessions.some((session) => session.name === baseName),
      5_000,
    );
    assert.ok(both.sessions.some((session) => session.name === baseName));
    assert.ok(both.sessions.some((session) => session.name === archivedName));

    await httpRequest(hub.port, {
      method: 'POST',
      path: '/send',
      json: { from: 'tester', to: baseName, content: 'goes-to-new' },
    });
    const delivered = await waitForWebSocketMessage(
      replacementWs,
      (message) => message.type === 'message' && message.content === 'goes-to-new',
    );
    assert.equal(delivered.to, baseName);
    await waitForNoMessage(
      currentWs,
      (message) => message.type === 'message' && message.content === 'goes-to-new',
    );

    await closeWebSocket(replacementWs);
    await waitForHealth(
      hub.port,
      (body) => !body.sessions.some((session) => session.name === baseName),
      5_000,
    );
    await httpRequest(hub.port, {
      method: 'POST',
      path: '/send',
      json: { from: 'tester', to: baseName, content: 'offline-inbox' },
    });
    const resumedWs = await connectSession(hub.port, baseName);
    const inbox = await waitForWebSocketMessage(
      resumedWs,
      (message) =>
        message.type === 'inbox' &&
        message.messages?.some((entry) => entry.content === 'offline-inbox'),
    );
    assert.equal(inbox.messages[0].to, baseName);

    await closeWebSocket(resumedWs);
  } finally {
    await closeWebSocket(currentWs);
    await stopHub(hub);
  }
});

test('hub close fallback deletes current session when socket is destroyed', { timeout: 10_000 }, async () => {
  const hub = await startHub({ prefix: 'ipc-rename-destroy' });
  const name = uniqueName('destroy');
  const ws = await connectSession(hub.port, name);

  try {
    ws._socket.destroy();
    await waitForClose(ws, 3_000);
    const health = await waitForHealth(
      hub.port,
      (body) => !body.sessions.some((session) => session.name === name),
      5_000,
    );
    assert.ok(!health.sessions.some((session) => session.name === name));
  } finally {
    await closeWebSocket(ws);
    await stopHub(hub);
  }
});
