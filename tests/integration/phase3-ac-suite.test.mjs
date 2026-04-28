import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  closeWebSocket,
  connectSession,
  httpRequest,
  sleep,
  startHub,
  stopHub,
  waitForWebSocketMessage,
  workerRequest,
} from '../helpers/hub-fixture.mjs';

const ROOT_DIR = fileURLToPath(new URL('../../', import.meta.url));
const PHASE3_PORT = 31791;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function startPhase3Hub(prefix) {
  let hub;
  try {
    hub = await startHub({
      prefix,
      port: PHASE3_PORT,
      env: {
        IPC_ENABLE_TEST_HOOKS: '1',
      },
      startTimeoutMs: 5_000,
    });
    assert.equal(
      hub.port,
      PHASE3_PORT,
      `Phase 3 must use temporary hub port ${PHASE3_PORT}; got ${hub.port}`,
    );
    return hub;
  } catch (error) {
    await stopHub(hub);
    throw error;
  }
}

function hubLog(hub) {
  return hub?.stderrChunks?.join('') ?? '';
}

async function postSend(hub, { from, to, content }) {
  const response = await httpRequest(hub.port, {
    method: 'POST',
    path: '/send',
    json: { from, to, content },
  });
  assert.equal(
    response.statusCode,
    200,
    `POST /send failed: ${JSON.stringify(response.body)}\n${hubLog(hub)}`,
  );
  assert.equal(response.body.accepted, true, JSON.stringify(response.body));
  return response.body;
}

async function waitUntil(probe, { timeoutMs = 3_000, intervalMs = 25, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;

  while (Date.now() < deadline) {
    lastValue = await probe();
    if (lastValue) return lastValue;
    await sleep(intervalMs);
  }

  throw new Error(`timeout waiting for ${label}; last=${JSON.stringify(lastValue)}`);
}

async function attachMockAppServer(hub, options) {
  return await workerRequest(hub.worker, 'attachMockCodexAppServer', options, 3_000);
}

async function getMockAppServer(hub, sessionName) {
  return await workerRequest(hub.worker, 'getMockCodexAppServer', { sessionName }, 3_000);
}

async function waitForMockCall(hub, sessionName, predicate, label) {
  return await waitUntil(
    async () => {
      const state = await getMockAppServer(hub, sessionName);
      return state.calls.find(predicate) ?? false;
    },
    { label },
  );
}

function querySqliteEvidence(dbPath, marker) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const like = `%${marker}%`;
    const messages = db
      .prepare('SELECT id, "from", "to", content, ts FROM messages WHERE content LIKE ?')
      .all(like);
    const inbox = db
      .prepare('SELECT session_name, message, ts FROM inbox WHERE message LIKE ?')
      .all(like);
    return { messages, inbox };
  } finally {
    db.close();
  }
}

function writeFakeCodexExecutable() {
  const dir = mkdtempSync(join(tmpdir(), 'phase3-fake-codex-'));
  const packageUrl = pathToFileURL(join(ROOT_DIR, 'package.json')).href;
  const script = `
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
const require = createRequire(${JSON.stringify(packageUrl)}), WebSocket = require('ws');
const args = process.argv.slice(2), sessionName = process.env.IPC_NAME || 'ac5-test';
const threadId = process.env.PHASE3_FAKE_CODEX_THREAD_ID || '00000000-0000-4000-8000-000000000005';
function ok(id, result = {}) { process.stdout.write(JSON.stringify({ id, result }) + '\\n'); }
if (args[0] === 'app-server') { const rl = createInterface({ input: process.stdin }); rl.on('line', (line) => {
  if (!line.trim()) return; let request; try { request = JSON.parse(line); } catch { return; }
  if (request.method === 'initialize') return ok(request.id, { codexHome: process.cwd() });
  if (request.method === 'thread/start' || request.method === 'thread/read') return ok(request.id, { thread: { id: threadId, status: { type: 'idle' } } });
  if (request.method === 'thread/inject_items' || request.method === 'turn/steer') return ok(request.id, { ok: true }); ok(request.id);
}); setInterval(() => {}, 1_000); } else if (args[0] === 'exec') {
  const host = process.env.IPC_HUB_HOST || '127.0.0.1', port = process.env.IPC_PORT || '31791', ws = new WebSocket('ws://' + host + ':' + port + '/ws?name=' + encodeURIComponent(sessionName) + '&force=1');
  ws.on('open', () => ws.send(JSON.stringify({ type: 'register', name: sessionName, runtime: 'codex', pid: process.pid, cwd: process.cwd(), appServerThreadId: threadId })));
  ws.on('message', (raw) => { let msg; try { msg = JSON.parse(raw.toString()); } catch { return; } if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' })); });
  setInterval(() => {}, 1_000);
} else { process.stderr.write('fake codex invoked with ' + args.join(' ') + '\\n'); setInterval(() => {}, 1_000); }
`;
  writeFileSync(join(dir, 'fake-codex.mjs'), script, 'utf8');

  if (process.platform === 'win32') {
    writeFileSync(join(dir, 'codex.cmd'), '@echo off\r\nnode "%~dp0fake-codex.mjs" %*\r\n', 'utf8');
  } else {
    const executable = join(dir, 'codex');
    writeFileSync(
      executable,
      '#!/usr/bin/env sh\nnode "$(dirname "$0")/fake-codex.mjs" "$@"\n',
      'utf8',
    );
    chmodSync(executable, 0o755);
  }

  return {
    dir,
    path: `${dir}${delimiter}${process.env.PATH ?? ''}`,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {}
}

function pidIsAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function spawnFakeCodexPair(hub, { sessionName }) {
  const fakeCodex = writeFakeCodexExecutable();
  const oldEnv = {
    PATH: process.env.PATH,
    IPC_PORT: process.env.IPC_PORT,
    IPC_HUB_HOST: process.env.IPC_HUB_HOST,
    IPC_NAME: process.env.IPC_NAME,
    PHASE3_FAKE_CODEX_THREAD_ID: process.env.PHASE3_FAKE_CODEX_THREAD_ID,
  };
  const threadId = randomUUID();

  try {
    process.env.PATH = fakeCodex.path;
    process.env.IPC_PORT = String(hub.port);
    process.env.IPC_HUB_HOST = '127.0.0.1';
    process.env.IPC_NAME = 'phase3-harness';
    process.env.PHASE3_FAKE_CODEX_THREAD_ID = threadId;

    const moduleUrl = `${pathToFileURL(join(ROOT_DIR, 'mcp-server.mjs')).href}?phase3=${Date.now()}-${Math.random()}`;
    const mcpServer = await import(moduleUrl);
    const result = await mcpServer.spawnSession({
      name: sessionName,
      runtime: 'codex',
      interactive: false,
      task: 'exit immediately',
      cwd: ROOT_DIR,
    });
    await waitUntil(
      async () => {
        const response = await httpRequest(hub.port, { method: 'GET', path: '/sessions' });
        return response.body.find((session) => session.name === sessionName) ?? false;
      },
      { timeoutMs: 5_000, label: `${sessionName} in /sessions` },
    );
    return { result, fakeCodex, threadId, mcpServer };
  } finally {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function listListeningPorts(pid) {
  if (!pid) return [];
  if (process.platform === 'win32') {
    const command =
      `Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue ` +
      '| Select-Object -Property LocalAddress,LocalPort,OwningProcess | ConvertTo-Json -Compress';
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0 || result.stdout.trim() === '') return [];
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  const result = spawnSync('sh', ['-c', `lsof -Pan -p ${pid} -iTCP -sTCP:LISTEN 2>/dev/null`], {
    encoding: 'utf8',
  });
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(1);
}

describe('Phase 3 integration AC suite', { concurrency: false }, () => {
  test('AC-3 broadcast reaches claude WebSocket and codex App Server receiver', async () => {
    const hub = await startPhase3Hub('phase3-ac3');
    const sockets = [];
    try {
      const cc = await connectSession(hub.port, 'mock-cc-3', {
        register: { runtime: 'claude' },
      });
      const codexThreadId = randomUUID();
      const codex = await connectSession(hub.port, 'mock-codex-3', {
        register: { runtime: 'codex', appServerThreadId: codexThreadId },
      });
      const sender = await connectSession(hub.port, 'mock-sender-3', {
        register: { runtime: 'claude' },
      });
      sockets.push(cc, codex, sender);
      await attachMockAppServer(hub, { sessionName: 'mock-codex-3', threadId: codexThreadId });

      const marker = `[AC-3 BROADCAST] ${Date.now()}`;
      const ccReceived = waitForWebSocketMessage(
        cc,
        (message) => message.type === 'message' && message.content === marker,
        3_000,
      );
      sender.send(
        JSON.stringify({
          id: `ac3_${Date.now()}`,
          type: 'message',
          from: 'mock-sender-3',
          to: '*',
          content: marker,
          ts: Date.now(),
        }),
      );

      const ccMessage = await ccReceived;
      const codexCall = await waitForMockCall(
        hub,
        'mock-codex-3',
        (call) => call.method === 'threadInjectItems' && call.content.includes(marker),
        'AC-3 codex App Server injection',
      );

      assert.equal(ccMessage.content, marker);
      assert.match(codexCall.threadId, UUID_RE);
      console.log(JSON.stringify({ ac: 'AC-3', cc: true, codexMethod: codexCall.method }));
    } finally {
      await Promise.all(sockets.map((socket) => closeWebSocket(socket)));
      await stopHub(hub);
    }
  });

  test('AC-5 codex spawn creates process pair and registers thread/start id', async () => {
    const hub = await startPhase3Hub('phase3-ac5');
    let spawned;
    try {
      spawned = await spawnFakeCodexPair(hub, { sessionName: 'ac5-test' });
      const response = await httpRequest(hub.port, { method: 'GET', path: '/sessions' });
      const session = response.body.find((entry) => entry.name === 'ac5-test');

      assert.equal(session.runtime, 'codex', JSON.stringify(response.body));
      assert.match(session.appServerThreadId, UUID_RE, JSON.stringify(session));
      assert.equal(spawned.result.runtime, 'codex');
      assert.match(spawned.result.appServerThreadId, UUID_RE);
      assert.equal(pidIsAlive(spawned.result.pid), true, JSON.stringify(spawned.result));
      assert.equal(pidIsAlive(spawned.result.appServerPid), true, JSON.stringify(spawned.result));
      console.log(
        JSON.stringify({
          ac: 'AC-5',
          pid: spawned.result.pid,
          appServerPid: spawned.result.appServerPid,
          threadId: spawned.result.appServerThreadId,
        }),
      );
    } finally {
      if (spawned) {
        spawned.mcpServer.stopCodexThreadKeepalive('ac5-test', 'phase3-test-cleanup');
        killProcessTree(spawned.result?.pid);
        killProcessTree(spawned.result?.appServerPid);
        spawned.fakeCodex.cleanup();
      }
      await stopHub(hub);
    }
  });

  test('AC-6 App Server failure falls back to SQLite inbox without message loss', async () => {
    const hub = await startPhase3Hub('phase3-ac6');
    const sockets = [];
    try {
      const threadId = randomUUID();
      const codex = await connectSession(hub.port, 'ac6-test', {
        register: { runtime: 'codex', appServerThreadId: threadId },
      });
      sockets.push(codex);
      await attachMockAppServer(hub, {
        sessionName: 'ac6-test',
        threadId,
        failPush: true,
      });

      const marker = '[AC-6 FAIL-OVER]';
      await postSend(hub, { from: 'sender-ac6', to: 'ac6-test', content: marker });
      const evidence = await waitUntil(
        () => {
          const rows = querySqliteEvidence(hub.dbPath, marker);
          return rows.inbox.length > 0 ? rows : false;
        },
        { timeoutMs: 5_000, label: 'AC-6 SQLite inbox fallback' },
      );
      const appServerState = await getMockAppServer(hub, 'ac6-test');

      assert.equal(evidence.messages.length, 1, JSON.stringify(evidence));
      assert.equal(evidence.inbox.length, 1, JSON.stringify(evidence));
      assert.ok(
        appServerState.calls.some((call) => call.error?.includes('mock app server push failed')),
        JSON.stringify({ appServerState, log: hubLog(hub) }),
      );
      console.log(
        JSON.stringify({
          ac: 'AC-6',
          messages: evidence.messages.length,
          inbox: evidence.inbox.length,
        }),
      );
    } finally {
      await Promise.all(sockets.map((socket) => closeWebSocket(socket)));
      await stopHub(hub);
    }
  });

  test('AC-7 active turn IPC push latency stays under failure threshold', async () => {
    const hub = await startPhase3Hub('phase3-ac7');
    const sockets = [];
    try {
      const threadId = randomUUID();
      const activeTurnId = randomUUID();
      const codex = await connectSession(hub.port, 'ac7-test', {
        register: { runtime: 'codex', appServerThreadId: threadId },
      });
      sockets.push(codex);
      await attachMockAppServer(hub, { sessionName: 'ac7-test', threadId, activeTurnId });

      const marker = '[AC-7 PERF]';
      const startedAt = performance.now();
      await postSend(hub, { from: 'sender-ac7', to: 'ac7-test', content: marker });
      const call = await waitForMockCall(
        hub,
        'ac7-test',
        (entry) => entry.method === 'turnSteer' && entry.content.includes(marker),
        'AC-7 turn/steer',
      );
      const deltaMs = performance.now() - startedAt;

      assert.equal(call.expectedTurnId, activeTurnId, JSON.stringify(call));
      assert.ok(deltaMs < 500, `PERF_FAIL delta=${deltaMs.toFixed(1)}ms; hubLog=${hubLog(hub)}`);
      console.log(
        JSON.stringify({
          ac: 'AC-7',
          deltaMs: Number(deltaMs.toFixed(1)),
          status: deltaMs < 200 ? 'PERF_PASS' : 'PERF_ACCEPTABLE',
        }),
      );
    } finally {
      await Promise.all(sockets.map((socket) => closeWebSocket(socket)));
      await stopHub(hub);
    }
  });

  test('AC-8 codex app-server transport exposes zero TCP listen ports', async () => {
    const hub = await startPhase3Hub('phase3-ac8');
    let spawned;
    try {
      spawned = await spawnFakeCodexPair(hub, { sessionName: 'ac8-test' });
      const listening = listListeningPorts(spawned.result.appServerPid);

      assert.deepEqual(
        listening,
        [],
        `AC-8 expected stdio-only app-server, found LISTEN ports: ${JSON.stringify(listening)}`,
      );
      console.log(
        JSON.stringify({ ac: 'AC-8', appServerPid: spawned.result.appServerPid, listening }),
      );
    } finally {
      if (spawned) {
        spawned.mcpServer.stopCodexThreadKeepalive('ac8-test', 'phase3-test-cleanup');
        killProcessTree(spawned.result?.pid);
        killProcessTree(spawned.result?.appServerPid);
        spawned.fakeCodex.cleanup();
      }
      await stopHub(hub);
    }
  });
});
