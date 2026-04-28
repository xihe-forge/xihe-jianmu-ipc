import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAppServerClient, formatInjectItem } from '../../lib/codex-app-server-client.mjs';
import { createRouter } from '../../lib/router.mjs';

const codexVersion =
  process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/c', 'codex', '--version'], { encoding: 'utf8', windowsHide: true })
    : spawnSync('codex', ['--version'], { encoding: 'utf8', windowsHide: true });
const liveSkipReason =
  codexVersion.status === 0 ? false : 'INTEGRATION_SKIPPED: codex CLI unavailable';

function waitFor(client, predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for ${label}`));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      client.off('notification', onNotification);
    }
    function onNotification(message) {
      try {
        if (!predicate(message)) return;
        cleanup();
        resolve(message);
      } catch (error) {
        cleanup();
        reject(error);
      }
    }
    client.on('notification', onNotification);
  });
}

function collectText(message) {
  const item = message.params?.item;
  if (message.method === 'item/agentMessage/delta') return message.params?.delta ?? '';
  if (item?.type === 'agentMessage') return item.text ?? '';
  if (item?.type === 'message' && Array.isArray(item.content)) {
    return item.content.map((part) => part?.text ?? part?.output_text ?? '').join('');
  }
  return '';
}

async function waitForTurnText(client, threadId, turnId) {
  let text = '';
  client.on('notification', (message) => {
    const params = message.params ?? {};
    if (params.threadId !== threadId || params.turnId !== turnId) return;
    text += collectText(message);
  });
  await waitFor(
    client,
    (message) =>
      message.method === 'turn/completed' &&
      message.params?.threadId === threadId &&
      message.params?.turn?.id === turnId,
    300000,
    `turn/completed ${turnId}`,
  );
  return text;
}

async function createLiveClient() {
  const client = createAppServerClient({
    cwd: process.cwd(),
    env: { ...process.env, RUST_LOG: 'warn', LOG_FORMAT: 'json', NO_COLOR: '1', FORCE_COLOR: '0' },
    requestTimeoutMs: 60000,
  });
  await client.initialize({ clientInfo: { name: 'xihe-ipc-integration', version: '0.1.0' } });
  const { threadId } = await client.threadStart({
    cwd: process.cwd(),
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    experimentalRawEvents: true,
    persistExtendedHistory: true,
    model: process.env.CODEX_APP_SERVER_TEST_MODEL ?? 'gpt-5.5',
  });
  return { client, threadId };
}

test(
  'AC-1 active turn steer surfaces marker',
  { timeout: 360000, skip: liveSkipReason },
  async () => {
    const { client, threadId } = await createLiveClient();
    try {
      const start = await client.turnStart(
        threadId,
        'Wait briefly for an incoming steer marker, then answer with every marker you saw.',
      );
      await waitFor(
        client,
        (message) => message.method === 'turn/started' && message.params?.turn?.id === start.turnId,
        60000,
        'turn/started',
      );
      await client.turnSteer(threadId, start.turnId, '[AC-1 STEER] integration marker');
      const text = await waitForTurnText(client, threadId, start.turnId);
      assert.match(text, /\[AC-1 STEER\]/);
    } finally {
      await client.close();
    }
  },
);

test(
  'AC-2 idle inject schema 4 surfaces on next turn',
  { timeout: 360000, skip: liveSkipReason },
  async () => {
    const { client, threadId } = await createLiveClient();
    try {
      await client.threadInjectItems(threadId, [formatInjectItem('[AC-2 INJECT] idle marker')]);
      const start = await client.turnStart(
        threadId,
        'List all AC-2 markers visible in this thread. Include the marker verbatim.',
      );
      const text = await waitForTurnText(client, threadId, start.turnId);
      assert.match(text, /\[AC-2 INJECT\]/);
    } finally {
      await client.close();
    }
  },
);

test('AC-4 claude runtime keeps WebSocket push path', { timeout: 5000 }, async () => {
  const pushed = [];
  const appServerCalls = [];
  const ctx = {
    sessions: new Map(),
    deliveredMessageIds: new Map(),
    ackPending: new Map(),
    feishuApps: [],
    getFeishuToken: async () => 'token',
    isOpenClawSession: () => false,
    deliverToOpenClaw: async () => true,
    enqueueOpenClawRetry: () => {},
    stderr: () => {},
    audit: () => {},
    saveMessage: () => {},
    saveInboxMessage: () => {},
    getInboxMessages: () => [],
    findPendingRebind: () => null,
    appendBufferedMessage: () => 0,
    clearInbox: () => {},
    appServerClients: new Map([['codex-agent', { threadStatus: () => ({ activeTurnId: null }) }]]),
  };
  const ws = { readyState: 1, OPEN: 1, send: (payload) => pushed.push(JSON.parse(payload)) };
  ctx.sessions.set('claude-agent', {
    name: 'claude-agent',
    runtime: 'claude',
    ws,
    connectedAt: Date.now(),
    topics: new Set(),
    inbox: [],
    inboxExpiry: null,
  });
  ctx.sessions.set('codex-agent', {
    name: 'codex-agent',
    runtime: 'codex',
    appServerThreadId: 'thread-1',
    ws,
    connectedAt: Date.now(),
    topics: new Set(),
    inbox: [],
    inboxExpiry: null,
  });
  ctx.appServerClients.set('codex-agent', {
    threadStatus: () => ({ activeTurnId: null }),
    threadInjectItems: async () => appServerCalls.push('inject'),
  });

  createRouter(ctx).routeMessage(
    { id: 'ac4', type: 'message', from: 'harness', to: 'claude-agent', content: '[AC-4 CC-CC]' },
    { name: 'harness' },
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].content, '[AC-4 CC-CC]');
  assert.deepEqual(appServerCalls, []);
});
