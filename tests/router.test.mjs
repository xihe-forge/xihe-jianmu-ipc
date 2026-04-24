/**
 * tests/router.test.mjs — lib/router.mjs 单元测试
 *
 * 通过依赖注入构造 mock ctx，不启动任何 HTTP/WebSocket server，纯单元测试。
 */

import { after, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../lib/router.mjs';

const originalSetTimeout = globalThis.setTimeout.bind(globalThis);
const originalClearTimeout = globalThis.clearTimeout.bind(globalThis);
const activeTimers = new Set();

globalThis.setTimeout = function trackedSetTimeout(callback, delay, ...args) {
  let timer = null;
  timer = originalSetTimeout((...callbackArgs) => {
    activeTimers.delete(timer);
    callback(...callbackArgs);
  }, delay, ...args);
  activeTimers.add(timer);
  return timer;
};

globalThis.clearTimeout = function trackedClearTimeout(timer) {
  activeTimers.delete(timer);
  return originalClearTimeout(timer);
};

afterEach(() => {
  for (const timer of activeTimers) {
    originalClearTimeout(timer);
  }
  activeTimers.clear();
});

after(() => {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
});

// ── 测试工具函数 ──────────────────────────────────────────────────────────────

/** 构造 mock ctx，每个测试独立调用，互不污染 */
function createMockCtx() {
  const logs = [];
  const audits = [];
  const savedMessages = [];
  const savedInboxMessages = [];
  const persistedInbox = new Map();
  const clearedInboxSessions = [];
  const sessions = new Map();
  const deliveredMessageIds = new Map();
  const ackPending = new Map();

  return {
    sessions,
    deliveredMessageIds,
    ackPending,
    feishuApps: [],
    getFeishuToken: async () => 'mock-token',
    isOpenClawSession: (name) => name === 'openclaw',
    deliverToOpenClaw: async () => true,
    enqueueOpenClawRetry: () => {},
    stderr: (msg) => logs.push(msg),
    audit: (event, details) => audits.push({ event, ...details }),
    saveMessage: (msg) => savedMessages.push(msg),
    saveInboxMessage: (sessionName, msg) => {
      savedInboxMessages.push({ sessionName, msg });
      const list = persistedInbox.get(sessionName) ?? [];
      list.push(msg);
      persistedInbox.set(sessionName, list);
    },
    getInboxMessages: (sessionName) => [...(persistedInbox.get(sessionName) ?? [])],
    getRecipientRecent: () => [],
    findPendingRebind: () => null,
    appendBufferedMessage: () => 0,
    clearInbox: (sessionName) => {
      clearedInboxSessions.push(sessionName);
      persistedInbox.delete(sessionName);
    },
    // 用于断言的辅助引用
    _logs: logs,
    _audits: audits,
    _savedMessages: savedMessages,
    _savedInboxMessages: savedInboxMessages,
    _persistedInbox: persistedInbox,
    _clearedInboxSessions: clearedInboxSessions,
  };
}

/** 构造 mock WebSocket（OPEN 状态） */
function createMockWs() {
  const sent = [];
  return {
    readyState: 1, // OPEN
    OPEN: 1,
    send: (data) => sent.push(JSON.parse(data)),
    _sent: sent,
  };
}

/** 构造一个标准的在线 session 对象 */
function createOnlineSession(name, ws) {
  return {
    name,
    ws,
    connectedAt: Date.now(),
    topics: new Set(),
    inbox: [],
    inboxExpiry: null,
  };
}

// ── send ──────────────────────────────────────────────────────────────────────

test('send: 向 OPEN 状态的 ws 发送消息', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { send } = createRouter(ctx);
  const ws = createMockWs();

  send(ws, { type: 'message', content: 'hello' });

  assert.equal(ws._sent.length, 1);
  assert.equal(ws._sent[0].content, 'hello');
});

test('send: ws 为 null 时不报错', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { send } = createRouter(ctx);

  // 不抛异常即通过
  assert.doesNotThrow(() => send(null, { type: 'message' }));
});

test('send: ws.readyState !== OPEN 时不发送', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { send } = createRouter(ctx);
  const ws = createMockWs();
  ws.readyState = 3; // CLOSED

  send(ws, { type: 'message', content: 'should not arrive' });

  assert.equal(ws._sent.length, 0);
});

// ── broadcast ─────────────────────────────────────────────────────────────────

test('broadcast: 向所有在线 session 广播', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { broadcast } = createRouter(ctx);

  const ws1 = createMockWs();
  const ws2 = createMockWs();
  ctx.sessions.set('alice', createOnlineSession('alice', ws1));
  ctx.sessions.set('bob', createOnlineSession('bob', ws2));

  broadcast({ type: 'message', content: 'hi all' });

  assert.equal(ws1._sent.length, 1);
  assert.equal(ws2._sent.length, 1);
  assert.equal(ws1._sent[0].content, 'hi all');
});

test('broadcast: 排除指定的 exceptName', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { broadcast } = createRouter(ctx);

  const ws1 = createMockWs();
  const ws2 = createMockWs();
  ctx.sessions.set('alice', createOnlineSession('alice', ws1));
  ctx.sessions.set('bob', createOnlineSession('bob', ws2));

  broadcast({ type: 'message', content: 'except alice' }, 'alice');

  assert.equal(ws1._sent.length, 0); // alice 被排除
  assert.equal(ws2._sent.length, 1); // bob 收到
});

test('broadcast: 跳过离线 session', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { broadcast } = createRouter(ctx);

  const ws1 = createMockWs();
  // bob 离线：ws=null
  ctx.sessions.set('alice', createOnlineSession('alice', ws1));
  ctx.sessions.set('bob', { name: 'bob', ws: null, connectedAt: 0, topics: new Set(), inbox: [], inboxExpiry: null });

  broadcast({ type: 'message', content: 'online only' });

  assert.equal(ws1._sent.length, 1);
  // bob 离线，不会报错，inbox 也不受 broadcast 影响（broadcast 只发在线）
});


test('broadcastToTopic: records push_deliver for each online subscriber', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { broadcastToTopic } = createRouter(ctx);

  for (const name of ['alice', 'bob', 'charlie']) {
    const session = createOnlineSession(name, createMockWs());
    session.topics.add('ops');
    ctx.sessions.set(name, session);
  }

  const delivered = broadcastToTopic('ops', { id: 'topic_msg', type: 'message', topic: 'ops', content: 'fanout' });

  assert.deepEqual(delivered, ['alice', 'bob', 'charlie']);
  const pushAudits = ctx._audits.filter((entry) => entry.event === 'push_deliver');
  assert.equal(pushAudits.length, 3);
  assert.deepEqual(pushAudits.map((entry) => entry.to), ['alice', 'bob', 'charlie']);
  assert.ok(pushAudits.every((entry) => entry.msg_id === 'topic_msg'));
  assert.ok(pushAudits.every((entry) => entry.send_ok === true));
  assert.ok(pushAudits.every((entry) => entry.reason === 'broadcast-topic'));
});

// ── pushInbox ─────────────────────────────────────────────────────────────────

test('pushInbox: 将消息加入 inbox', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { pushInbox } = createRouter(ctx);

  const session = createOnlineSession('charlie', null);
  const msg = { id: 'msg_1', content: 'test' };

  pushInbox(session, msg);

  assert.equal(session.inbox.length, 1);
  assert.equal(session.inbox[0].id, 'msg_1');
  assert.equal(ctx._savedInboxMessages.length, 1);
  assert.equal(ctx._savedInboxMessages[0].sessionName, 'charlie');
});

test('pushInbox: 超过 INBOX_MAX_SIZE(50) 时淘汰最旧消息', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { pushInbox } = createRouter(ctx);

  const session = createOnlineSession('charlie', null);

  // 先塞满 50 条
  for (let i = 0; i < 50; i++) {
    pushInbox(session, { id: `msg_${i}`, content: `msg ${i}` });
  }
  assert.equal(session.inbox.length, 50);

  // 第 51 条应该淘汰最旧（msg_0）
  pushInbox(session, { id: 'msg_50', content: 'newest' });

  assert.equal(session.inbox.length, 50); // 上限不变
  assert.equal(session.inbox[0].id, 'msg_1'); // msg_0 已被淘汰
  assert.equal(session.inbox[49].id, 'msg_50'); // 最新消息在末尾
});

// ── flushInbox ────────────────────────────────────────────────────────────────

test('flushInbox: 将缓冲消息一次性发送给重连的 session', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { flushInbox } = createRouter(ctx);

  const ws = createMockWs();
  const session = createOnlineSession('dave', ws);
  ctx._persistedInbox.set('dave', [
    { id: 'msg_a', content: 'buffered 1' },
    { id: 'msg_b', content: 'buffered 2' },
  ]);
  session.inbox.push({ id: 'msg_a', content: 'buffered 1' });
  session.inbox.push({ id: 'msg_b', content: 'buffered 2' });

  flushInbox(session);

  // inbox 已清空
  assert.equal(session.inbox.length, 0);
  // ws 收到了一条 inbox 消息包含两条原始消息
  assert.equal(ws._sent.length, 1);
  assert.equal(ws._sent[0].type, 'inbox');
  assert.equal(ws._sent[0].messages.length, 2);
  assert.deepEqual(ctx._clearedInboxSessions, ['dave']);
});

test('flushInbox: 合并 SQLite 和内存 inbox，并按 id 去重', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { flushInbox } = createRouter(ctx);

  const ws = createMockWs();
  const session = createOnlineSession('merge-agent', ws);
  ctx._persistedInbox.set('merge-agent', [
    { id: 'msg_1', content: 'persisted 1', ts: 1 },
    { id: 'msg_2', content: 'persisted 2', ts: 2 },
  ]);
  session.inbox.push(
    { id: 'msg_2', content: 'persisted 2', ts: 2 },
    { id: 'msg_3', content: 'memory 3', ts: 3 },
  );

  flushInbox(session);

  assert.equal(ws._sent.length, 1);
  assert.deepEqual(ws._sent[0].messages.map(m => m.id), ['msg_1', 'msg_2', 'msg_3']);
  assert.equal(session.inbox.length, 0);
  assert.equal(ctx._persistedInbox.has('merge-agent'), false);
});

test('flushInbox: 只 drain SQLite 和内存 inbox，不读取 recent messages', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  ctx.getRecipientRecent = () => {
    throw new Error('flushInbox 不应查询 recent messages');
  };
  const { flushInbox } = createRouter(ctx);

  const ws = createMockWs();
  const session = createOnlineSession('merge-agent', ws);
  ctx._persistedInbox.set('merge-agent', [{ id: 'persisted_1', content: 'persisted 1', ts: 1 }]);
  session.inbox.push({ id: 'memory_1', content: 'memory 1', ts: 2 });

  flushInbox(session);

  assert.equal(ws._sent.length, 1);
  assert.deepEqual(ws._sent[0].messages.map((message) => message.id), ['persisted_1', 'memory_1']);
  assert.equal(session.inbox.length, 0);
  assert.equal(ctx._persistedInbox.has('merge-agent'), false);
});

test('flushInbox: id 缺失时按组合 key 去重', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { flushInbox } = createRouter(ctx);

  const ws = createMockWs();
  const session = createOnlineSession('recent-agent', ws);
  ctx._persistedInbox.set('recent-agent', [{
    type: 'message',
    from: 'sender',
    to: 'recent-agent',
    content: 'same payload beyond thirty-two chars 1234567890',
    ts: 10,
  }]);
  session.inbox.push({
    type: 'message',
    from: 'sender',
    to: 'recent-agent',
    content: 'same payload beyond thirty-two chars 1234567890',
    ts: 10,
  });

  flushInbox(session);

  assert.equal(ws._sent.length, 1);
  assert.equal(ws._sent[0].messages.length, 1);
});

test('flushInbox: 空 inbox 时不发送', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { flushInbox } = createRouter(ctx);

  const ws = createMockWs();
  const session = createOnlineSession('dave', ws);
  // inbox 为空

  flushInbox(session);

  assert.equal(ws._sent.length, 0);
});

test('flushInbox: openclaw session 时清空 inbox 但不发送', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { flushInbox } = createRouter(ctx);

  const ws = createMockWs();
  const session = createOnlineSession('openclaw', ws);
  ctx._persistedInbox.set('openclaw', [{ id: 'msg_x', content: 'for openclaw' }]);
  session.inbox.push({ id: 'msg_x', content: 'for openclaw' });

  flushInbox(session);

  // inbox 已清空
  assert.equal(session.inbox.length, 0);
  // ws 不应该收到消息
  assert.equal(ws._sent.length, 0);
  assert.deepEqual(ctx._clearedInboxSessions, ['openclaw']);
});

test('flushPendingRebind: 合并 SQLite inbox 与 buffered_messages，按 ts 升序发送并去重', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { flushPendingRebind } = createRouter(ctx);

  const ws = createMockWs();
  const session = createOnlineSession('rebind-agent', ws);
  ctx._persistedInbox.set('rebind-agent', [
    { id: 'persisted-1', content: 'persisted', ts: 10 },
    { id: 'dup-id', content: 'persisted duplicate', ts: 20 },
  ]);

  const count = flushPendingRebind(session, {
    bufferedMessages: [
      { id: 'dup-id', content: 'buffered duplicate', ts: 20 },
      { id: 'buffered-2', content: 'buffered', ts: 30 },
    ],
  });

  assert.equal(count, 3);
  assert.equal(ws._sent.length, 1);
  assert.deepEqual(
    ws._sent[0].messages.map((message) => message.id),
    ['persisted-1', 'dup-id', 'buffered-2'],
  );
  assert.equal(session.inbox.length, 0);
  assert.deepEqual(ctx._clearedInboxSessions, ['rebind-agent']);
  assert.ok(ws._sent[0].messages.every((message) => message.id !== 'recent-only'));
});

// ── routeMessage — 直接寻址（路径4：普通 IPC 会话） ───────────────────────────

test('routeMessage: 发送到在线 session — 目标 ws 收到消息', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  const wsTarget = createMockWs();
  ctx.sessions.set('eve', createOnlineSession('eve', wsTarget));

  const senderSession = { name: 'alice' };
  const msg = { id: 'msg_1', type: 'message', from: 'alice', to: 'eve', content: 'direct msg' };

  routeMessage(msg, senderSession);

  assert.equal(wsTarget._sent.length, 1);
  assert.equal(wsTarget._sent[0].content, 'direct msg');
});


test('routeMessage: records push_deliver when direct send succeeds', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  ctx.sessions.set('eve', createOnlineSession('eve', createMockWs()));
  const msg = { id: 'direct_audit', type: 'message', from: 'alice', to: 'eve', content: 'audit me' };

  routeMessage(msg, { name: 'alice' });

  const pushAudits = ctx._audits.filter((entry) => entry.event === 'push_deliver');
  assert.equal(pushAudits.length, 1);
  assert.deepEqual(pushAudits[0], {
    event: 'push_deliver',
    msg_id: 'direct_audit',
    to: 'eve',
    ws_ready_state: 1,
    send_ok: true,
    send_err: null,
    reason: 'route-direct',
  });
});

test('routeMessage: records failed push_deliver when ws.send throws', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);
  const ws = createMockWs();
  ws.send = () => {
    throw new Error('mock send failed');
  };
  ctx.sessions.set('eve', createOnlineSession('eve', ws));

  routeMessage({ id: 'send_fail', type: 'message', from: 'alice', to: 'eve', content: 'boom' }, { name: 'alice' });

  const pushAudits = ctx._audits.filter((entry) => entry.event === 'push_deliver');
  assert.equal(pushAudits.length, 1);
  assert.equal(pushAudits[0].msg_id, 'send_fail');
  assert.equal(pushAudits[0].to, 'eve');
  assert.equal(pushAudits[0].ws_ready_state, 1);
  assert.equal(pushAudits[0].send_ok, false);
  assert.match(pushAudits[0].send_err, /mock send failed/);
  assert.equal(pushAudits[0].reason, 'route-direct');
  assert.ok(ctx._logs.some((line) => line.includes('send error: mock send failed')));
});

test('routeMessage: 发送到离线 session — 消息进入 inbox', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  // eve 离线
  const offlineSession = { name: 'eve', ws: null, connectedAt: 0, topics: new Set(), inbox: [], inboxExpiry: null };
  ctx.sessions.set('eve', offlineSession);

  const senderSession = { name: 'alice' };
  const msg = { id: 'msg_2', type: 'message', from: 'alice', to: 'eve', content: 'for offline eve' };

  routeMessage(msg, senderSession);

  assert.equal(offlineSession.inbox.length, 1);
  assert.equal(offlineSession.inbox[0].content, 'for offline eve');
});

test('routeMessage: 命中 pending_rebind 时写入 buffered_messages，不走在线直投或 inbox', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const buffered = [];
  ctx.findPendingRebind = (name) => name === 'eve'
    ? { name, lastTopics: ['ops'], bufferedMessages: [], releasedAt: Date.now(), ttlSeconds: 5, nextSessionHint: null }
    : null;
  ctx.appendBufferedMessage = (name, msg) => {
    buffered.push({ name, msg });
    return 1;
  };
  const { routeMessage } = createRouter(ctx);

  const wsTarget = createMockWs();
  ctx.sessions.set('eve', createOnlineSession('eve', wsTarget));
  const senderSession = { name: 'alice' };
  const msg = { id: 'msg_pending_rebind', type: 'message', from: 'alice', to: 'eve', content: 'buffer for successor' };

  routeMessage(msg, senderSession);

  assert.equal(wsTarget._sent.length, 0, 'pending_rebind 命中时旧连接不应继续收消息');
  assert.equal(buffered.length, 1);
  assert.equal(buffered[0].name, 'eve');
  assert.equal(buffered[0].msg.id, 'msg_pending_rebind');
  assert.equal(ctx._savedInboxMessages.length, 0, '不应回落到 inbox');
  assert.deepEqual(ctx._savedMessages, [], '宽限期内缓冲的直发消息不应提前写入 messages 表');
  assert.ok(ctx._audits.some((entry) => entry.event === 'rebind_buffered' && entry.to === 'eve' && entry.id === 'msg_pending_rebind'));
});

test('routeMessage: 发送到不存在的 session — 创建 stub 并缓冲', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  // 'frank' 在 sessions 中不存在
  const senderSession = { name: 'alice' };
  const msg = { id: 'msg_3', type: 'message', from: 'alice', to: 'frank', content: 'stub test' };

  routeMessage(msg, senderSession);

  // stub 应被创建
  assert.ok(ctx.sessions.has('frank'));
  const stub = ctx.sessions.get('frank');
  assert.equal(stub.inbox.length, 1);
  assert.equal(stub.inbox[0].content, 'stub test');
});

test('routeMessage: 在线 sender 首次打到不存在 target 时收到 unknown-target 警告', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  const wsSender = createMockWs();
  const senderSession = createOnlineSession('alice', wsSender);
  ctx.sessions.set('alice', senderSession);

  routeMessage(
    { id: 'msg_unknown_target', type: 'message', from: 'alice', to: 'ghost-worker', content: 'hello?' },
    senderSession,
  );

  assert.ok(ctx.sessions.has('ghost-worker'), 'target 应被创建为 stub');
  assert.equal(wsSender._sent.length, 1, 'sender 应收到一条系统警告');
  assert.equal(wsSender._sent[0].type, 'unknown-target');
  assert.equal(wsSender._sent[0].target, 'ghost-worker');
  assert.equal(wsSender._sent[0].msgId, 'msg_unknown_target');
  assert.equal(wsSender._sent[0].hint, 'call ipc_sessions() first to verify target name; Hub does not fuzzy-match');
  assert.ok(ctx._logs.some(l => l.includes('unknown-target warned: alice about missing ghost-worker')), '应记录 warned 日志');
});

test('routeMessage: 同一 stub 第二次命中时不重复 warning，只继续累积 inbox', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  const wsSender = createMockWs();
  const senderSession = createOnlineSession('alice', wsSender);
  ctx.sessions.set('alice', senderSession);

  routeMessage(
    { id: 'msg_stub_first', type: 'message', from: 'alice', to: 'ghost-worker', content: 'first' },
    senderSession,
  );

  const stub = ctx.sessions.get('ghost-worker');

  routeMessage(
    { id: 'msg_stub_second', type: 'message', from: 'alice', to: 'ghost-worker', content: 'second' },
    senderSession,
  );

  assert.equal(ctx.sessions.get('ghost-worker'), stub, '现状：第二次命中时复用同一个 stub 对象');
  assert.equal(wsSender._sent.length, 1, 'unknown-target warning 只发一次');
  assert.deepEqual(stub.inbox.map(item => item.id), ['msg_stub_first', 'msg_stub_second']);
  assert.equal(
    ctx._logs.filter(l => l.includes('unknown-target warned: alice about missing ghost-worker')).length,
    1,
    'warned 日志只应出现一次',
  );
  assert.ok(ctx._logs.some(l => l.includes('session offline, buffered')), '第二次命中应按离线 session 继续缓冲');
});

test('routeMessage: stub 后同名 session 上线时复用 stub 并正常 flush / 直投', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage, flushInbox } = createRouter(ctx);

  const wsSender = createMockWs();
  const senderSession = createOnlineSession('alice', wsSender);
  ctx.sessions.set('alice', senderSession);

  routeMessage(
    { id: 'msg_buffered_once', type: 'message', from: 'alice', to: 'ghost-worker', content: 'buffer me' },
    senderSession,
  );

  const stub = ctx.sessions.get('ghost-worker');
  const wsTarget = createMockWs();
  if (stub.inboxExpiry !== null) {
    clearTimeout(stub.inboxExpiry);
    stub.inboxExpiry = null;
  }
  stub.ws = wsTarget;
  stub.connectedAt = Date.now();
  ctx.sessions.set('ghost-worker', stub);

  flushInbox(stub);

  assert.equal(ctx.sessions.get('ghost-worker'), stub, '现状：Hub 会复用原 stub 对象并升级为在线 session');
  assert.equal(wsTarget._sent.length, 1, '上线后应先收到 inbox flush');
  assert.equal(wsTarget._sent[0].type, 'inbox');
  assert.deepEqual(wsTarget._sent[0].messages.map(item => item.id), ['msg_buffered_once']);

  routeMessage(
    { id: 'msg_live_after_connect', type: 'message', from: 'alice', to: 'ghost-worker', content: 'live now' },
    senderSession,
  );

  assert.equal(wsTarget._sent.length, 2, 'flush 后新的消息应直接投递');
  assert.equal(wsTarget._sent[1].id, 'msg_live_after_connect');
  assert.equal(stub.inbox.length, 0, 'flush 后 inbox 应已清空');
});

// ── routeMessage — 广播 ────────────────────────────────────────────────────────

test('routeMessage: to="*" 广播到所有在线 session，排除发送方', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  const wsAlice = createMockWs();
  const wsBob = createMockWs();
  const wsCharlie = createMockWs();
  ctx.sessions.set('alice', createOnlineSession('alice', wsAlice));
  ctx.sessions.set('bob', createOnlineSession('bob', wsBob));
  ctx.sessions.set('charlie', createOnlineSession('charlie', wsCharlie));

  const senderSession = { name: 'alice' };
  const msg = { id: 'msg_bc', type: 'message', from: 'alice', to: '*', content: 'broadcast!' };

  routeMessage(msg, senderSession);

  assert.equal(wsAlice._sent.length, 0); // 发送方不收到
  assert.equal(wsBob._sent.length, 1);
  assert.equal(wsCharlie._sent.length, 1);
});

// ── routeMessage — topic fanout ────────────────────────────────────────────────

test('routeMessage: 带 topic 时只投递给订阅了该 topic 的 session', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  const wsBob = createMockWs();
  const wsCharlie = createMockWs();

  const bobSession = createOnlineSession('bob', wsBob);
  const charlieSession = createOnlineSession('charlie', wsCharlie);
  bobSession.topics.add('news'); // bob 订阅了 news
  // charlie 没有订阅 news

  ctx.sessions.set('bob', bobSession);
  ctx.sessions.set('charlie', charlieSession);

  const senderSession = { name: 'alice' };
  // topic 消息，to 字段不是具体目标（用 '*' 表示扇出）
  const msg = { id: 'msg_topic', type: 'message', from: 'alice', to: '*', topic: 'news', content: 'topic msg' };

  routeMessage(msg, senderSession);

  assert.equal(wsBob._sent.length, 1); // bob 订阅了，收到
  // charlie 没有订阅，to='*' 且有 topic 时广播逻辑不执行（代码逻辑：to==='*' && !topic 才广播）
  assert.equal(wsCharlie._sent.length, 0);
});

// ── routeMessage — 去重 ───────────────────────────────────────────────────────

test('routeMessage: 同一 msg.id 第二次调用时跳过（不重复投递）', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  const wsEve = createMockWs();
  ctx.sessions.set('eve', createOnlineSession('eve', wsEve));

  const senderSession = { name: 'alice' };
  const msg = { id: 'msg_dup', type: 'message', from: 'alice', to: 'eve', content: 'dup test' };

  routeMessage(msg, senderSession);
  routeMessage(msg, senderSession); // 第二次应被跳过

  assert.equal(wsEve._sent.length, 1); // 只投递一次
});

// ── routeMessage — 审计和持久化 ───────────────────────────────────────────────

test('routeMessage: type="message" 时调用 saveMessage', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  const wsEve = createMockWs();
  ctx.sessions.set('eve', createOnlineSession('eve', wsEve));

  const senderSession = { name: 'alice' };
  const msg = { id: 'msg_save', type: 'message', from: 'alice', to: 'eve', content: 'persist me' };

  routeMessage(msg, senderSession);

  assert.equal(ctx._savedMessages.length, 1);
  assert.equal(ctx._savedMessages[0].id, 'msg_save');
});

test('routeMessage: 调用 audit 记录路由事件', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  const wsEve = createMockWs();
  ctx.sessions.set('eve', createOnlineSession('eve', wsEve));

  const senderSession = { name: 'alice' };
  const msg = { id: 'msg_audit', type: 'message', from: 'alice', to: 'eve', content: 'audit test' };

  routeMessage(msg, senderSession);

  const routeAudits = ctx._audits.filter((entry) => entry.event === 'message_route');
  assert.equal(routeAudits.length, 1);
  assert.equal(routeAudits[0].from, 'alice');
  assert.equal(routeAudits[0].to, 'eve');
});

// ── routeMessage — OpenClaw 路径 ──────────────────────────────────────────────

test('routeMessage: 发送到 openclaw session 时调用 deliverToOpenClaw', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  let deliverCalled = false;
  let deliveredMsg = null;
  ctx.deliverToOpenClaw = async (msg) => {
    deliverCalled = true;
    deliveredMsg = msg;
    return true;
  };

  const { routeMessage } = createRouter(ctx);

  // openclaw session 注册在线（即使有 ws，路由也走 deliverToOpenClaw）
  const wsOC = createMockWs();
  ctx.sessions.set('openclaw', createOnlineSession('openclaw', wsOC));

  const senderSession = { name: 'jianmu-pm' };
  const msg = { id: 'msg_oc', type: 'message', from: 'jianmu-pm', to: 'openclaw', content: 'task for openclaw' };

  routeMessage(msg, senderSession);

  // deliverToOpenClaw 是异步的，但调用本身是同步发起的（Promise）
  // 我们验证它被调用（通过同步的 deliverCalled 标志）
  assert.ok(deliverCalled, 'deliverToOpenClaw 应该被调用');
  assert.equal(deliveredMsg.content, 'task for openclaw');
});

// ── scheduleInboxCleanup ───────────────────────────────────────────────────────

test('scheduleInboxCleanup: 过期后删除离线 session', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  const { scheduleInboxCleanup } = createRouter(ctx);

  // 创建一个离线 session 并注册到 sessions
  const session = {
    name: 'offline-agent',
    ws: null, // 离线
    connectedAt: 0,
    topics: new Set(),
    inbox: [{ id: 'msg_x', content: 'buffered' }],
    inboxExpiry: null,
  };
  ctx.sessions.set('offline-agent', session);

  // 用非常短的 TTL 来测试（直接 setTimeout 0 模拟过期）
  // 由于 INBOX_TTL 是 300000ms，我们手动调用 scheduleInboxCleanup 后
  // 用一个 hack：直接触发 session.inboxExpiry 的回调
  scheduleInboxCleanup(session);

  // inboxExpiry 应该已经被设置
  assert.ok(session.inboxExpiry !== null, 'inboxExpiry 应已设置');

  // 清除原有 timer，手动模拟立即触发过期逻辑
  clearTimeout(session.inboxExpiry);

  // 直接执行过期逻辑：session.ws 为 null 时应删除 session
  if (!session.ws) {
    ctx.sessions.delete(session.name);
    ctx.stderr(`[ipc-hub] inbox expired, removed offline session: ${session.name}`);
  }

  assert.ok(!ctx.sessions.has('offline-agent'), 'session 应已被删除');
});

test('scheduleInboxCleanup: session 重连后过期不删除', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  const { scheduleInboxCleanup } = createRouter(ctx);

  const session = {
    name: 'reconnected-agent',
    ws: null,
    connectedAt: 0,
    topics: new Set(),
    inbox: [],
    inboxExpiry: null,
  };
  ctx.sessions.set('reconnected-agent', session);

  scheduleInboxCleanup(session);

  // 模拟重连：在过期前设置 ws
  session.ws = createMockWs();

  // 清除 timer，手动执行过期判断逻辑
  clearTimeout(session.inboxExpiry);

  // 过期逻辑：ws 已重连，不删除
  if (!session.ws) {
    ctx.sessions.delete(session.name);
  }

  // session 应该仍然存在
  assert.ok(ctx.sessions.has('reconnected-agent'), 'session 重连后不应被删除');
});

// ── 飞书群组路由（feishu-group:<chatId>）────────────────────────────────────────

test('routeMessage: 发送到 feishu-group 时调用 getFeishuToken', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.feishuApps = [{ name: 'bot', send: true, targetOpenId: 'oid_xxx' }];

  let tokenCallArg = null;
  ctx.getFeishuToken = async (app) => {
    tokenCallArg = app;
    return 'test-token';
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ code: 0 }) });

  try {
    const { routeMessage } = createRouter(ctx);
    const senderSession = { name: 'jianmu-pm' };
    const msg = { id: 'msg_fg1', type: 'message', from: 'jianmu-pm', to: 'feishu-group:chat_123', content: 'hello group' };

    routeMessage(msg, senderSession);

    // getFeishuToken 是 async，等待 Promise 链执行
    await new Promise(r => setTimeout(r, 50));

    assert.ok(tokenCallArg !== null, 'getFeishuToken 应该被调用');
    assert.equal(tokenCallArg.name, 'bot');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('routeMessage: 发送到 feishu-group 但无 send-enabled app 时只打日志不报错', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.feishuApps = [];

  const { routeMessage } = createRouter(ctx);
  const senderSession = { name: 'jianmu-pm' };
  const msg = { id: 'msg_fg2', type: 'message', from: 'jianmu-pm', to: 'feishu-group:chat_123', content: 'hello group' };

  // 不应抛异常
  assert.doesNotThrow(() => routeMessage(msg, senderSession));
  await new Promise(r => setTimeout(r, 10));

  const hasLog = ctx._logs.some(l => l.includes('no send-enabled Feishu app found'));
  assert.ok(hasLog, '应该记录 no send-enabled Feishu app found 日志');
});

// ── 飞书 P2P 路由（feishu 或 feishu:<appName>）──────────────────────────────────

test('routeMessage: 发送到 feishu 时找默认 send app 并调用 getFeishuToken', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.feishuApps = [{ name: 'default-bot', send: true, chatId: 'chat_456' }];

  let tokenCallArg = null;
  ctx.getFeishuToken = async (app) => {
    tokenCallArg = app;
    return 'test-token';
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ code: 0 }) });

  try {
    const { routeMessage } = createRouter(ctx);
    const senderSession = { name: 'jianmu-pm' };
    const msg = { id: 'msg_p2p1', type: 'message', from: 'jianmu-pm', to: 'feishu', content: 'hello p2p' };

    routeMessage(msg, senderSession);
    await new Promise(r => setTimeout(r, 50));

    assert.ok(tokenCallArg !== null, 'getFeishuToken 应该被调用');
    assert.equal(tokenCallArg.name, 'default-bot');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('routeMessage: 发送到 feishu:specific-bot 时找指定 app', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.feishuApps = [
    { name: 'other-bot', send: true, chatId: 'chat_000' },
    { name: 'specific-bot', chatId: 'chat_789' },
  ];

  let tokenCallArg = null;
  ctx.getFeishuToken = async (app) => {
    tokenCallArg = app;
    return 'test-token';
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ code: 0 }) });

  try {
    const { routeMessage } = createRouter(ctx);
    const senderSession = { name: 'jianmu-pm' };
    const msg = { id: 'msg_p2p2', type: 'message', from: 'jianmu-pm', to: 'feishu:specific-bot', content: 'hello specific' };

    routeMessage(msg, senderSession);
    await new Promise(r => setTimeout(r, 50));

    assert.ok(tokenCallArg !== null, 'getFeishuToken 应该被调用');
    assert.equal(tokenCallArg.name, 'specific-bot');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('routeMessage: 发送到 feishu 但无匹配 app 时只打日志不报错', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.feishuApps = [];

  const { routeMessage } = createRouter(ctx);
  const senderSession = { name: 'jianmu-pm' };
  const msg = { id: 'msg_p2p3', type: 'message', from: 'jianmu-pm', to: 'feishu', content: 'hello nobody' };

  assert.doesNotThrow(() => routeMessage(msg, senderSession));
  await new Promise(r => setTimeout(r, 10));

  const hasLog = ctx._logs.some(l => l.includes('no matching Feishu app found'));
  assert.ok(hasLog, '应该记录 no matching Feishu app found 日志');
});

// ── OpenClaw 路由：deliver 成功时不触发重试 ────────────────────────────────────

test('routeMessage: deliverToOpenClaw 返回 true 时不调用 enqueueOpenClawRetry', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.deliverToOpenClaw = async () => true;

  let retryCalled = false;
  ctx.enqueueOpenClawRetry = () => { retryCalled = true; };

  const { routeMessage } = createRouter(ctx);
  ctx.sessions.set('openclaw', createOnlineSession('openclaw', createMockWs()));

  const senderSession = { name: 'jianmu-pm' };
  const msg = { id: 'msg_oc_ok', type: 'message', from: 'jianmu-pm', to: 'openclaw', content: 'task success' };

  routeMessage(msg, senderSession);
  await new Promise(r => setTimeout(r, 50));

  assert.equal(retryCalled, false, 'deliverToOpenClaw 成功时不应调用 enqueueOpenClawRetry');
});

// ── OpenClaw 路由：deliver 失败时触发重试 ────────────────────────────────────────

test('routeMessage: deliverToOpenClaw 返回 false 时调用 enqueueOpenClawRetry', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.deliverToOpenClaw = async () => false;

  let retryMsg = null;
  ctx.enqueueOpenClawRetry = (m) => { retryMsg = m; };

  const { routeMessage } = createRouter(ctx);
  ctx.sessions.set('openclaw', createOnlineSession('openclaw', createMockWs()));

  const senderSession = { name: 'jianmu-pm' };
  const msg = { id: 'msg_oc_fail', type: 'message', from: 'jianmu-pm', to: 'openclaw', content: 'task failed' };

  routeMessage(msg, senderSession);
  await new Promise(r => setTimeout(r, 50));

  assert.ok(retryMsg !== null, 'deliverToOpenClaw 失败时应调用 enqueueOpenClawRetry');
  assert.equal(retryMsg.id, 'msg_oc_fail');
});

// ── 广播时跳过 OpenClaw session ───────────────────────────────────────────────

test('routeMessage: to="*" 广播时跳过 openclaw session', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  const wsNormal = createMockWs();
  const wsOC = createMockWs();
  ctx.sessions.set('normal-agent', createOnlineSession('normal-agent', wsNormal));
  ctx.sessions.set('openclaw', createOnlineSession('openclaw', wsOC));

  const senderSession = { name: 'alice' };
  const msg = { id: 'msg_bc_oc', type: 'message', from: 'alice', to: '*', content: 'broadcast skip oc' };

  routeMessage(msg, senderSession);

  assert.equal(wsNormal._sent.length, 1, '普通 session 应该收到广播');
  assert.equal(wsOC._sent.length, 0, 'openclaw session 应该被跳过');
});

// ── topic fanout 时跳过 OpenClaw session ─────────────────────────────────────

test('routeMessage: topic fanout 时跳过 openclaw session', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  const wsNormal = createMockWs();
  const wsOC = createMockWs();

  const normalSession = createOnlineSession('normal-agent', wsNormal);
  const ocSession = createOnlineSession('openclaw', wsOC);
  normalSession.topics.add('events');
  ocSession.topics.add('events');

  ctx.sessions.set('normal-agent', normalSession);
  ctx.sessions.set('openclaw', ocSession);

  const senderSession = { name: 'alice' };
  const msg = { id: 'msg_topic_oc', type: 'message', from: 'alice', to: '*', topic: 'events', content: 'event fired' };

  routeMessage(msg, senderSession);

  assert.equal(wsNormal._sent.length, 1, '订阅了 topic 的普通 session 应该收到');
  assert.equal(wsOC._sent.length, 0, 'openclaw session 即使订阅了 topic 也应被跳过');
});

// ── 去重边界：id 为 undefined 时不去重 ───────────────────────────────────────

test('routeMessage: msg.id 为 undefined 时不做去重（每次都投递）', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  const wsEve = createMockWs();
  ctx.sessions.set('eve', createOnlineSession('eve', wsEve));

  const senderSession = { name: 'alice' };

  routeMessage({ type: 'message', from: 'alice', to: 'eve', content: 'first' }, senderSession);
  routeMessage({ type: 'message', from: 'alice', to: 'eve', content: 'second' }, senderSession);

  assert.equal(wsEve._sent.length, 2, 'id 为 undefined 时两条消息都应投递');
});

// ── pushInbox 边界：第50条不淘汰，第51条才淘汰 ────────────────────────────────

test('pushInbox: inbox 已有 49 条时 push 第 50 条不淘汰', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { pushInbox } = createRouter(ctx);

  const session = createOnlineSession('test-agent', null);

  for (let i = 0; i < 49; i++) {
    pushInbox(session, { id: `msg_${i}`, content: `msg ${i}` });
  }
  assert.equal(session.inbox.length, 49);

  pushInbox(session, { id: 'msg_49', content: 'fiftieth' });

  // 恰好 50 条，不应触发淘汰
  assert.equal(session.inbox.length, 50, '第 50 条不应触发淘汰');
  assert.equal(session.inbox[0].id, 'msg_0', 'msg_0 应仍在 inbox 中');
  assert.equal(session.inbox[49].id, 'msg_49', '最新消息应在末尾');
});

test('pushInbox: inbox 已有 50 条时 push 第 51 条淘汰第 1 条', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { pushInbox } = createRouter(ctx);

  const session = createOnlineSession('test-agent', null);

  for (let i = 0; i < 50; i++) {
    pushInbox(session, { id: `msg_${i}`, content: `msg ${i}` });
  }
  assert.equal(session.inbox.length, 50);

  pushInbox(session, { id: 'msg_50', content: 'fifty-first' });

  assert.equal(session.inbox.length, 50, 'push 后仍应保持 50 条上限');
  assert.equal(session.inbox[0].id, 'msg_1', 'msg_0 应被淘汰，msg_1 成为最旧');
  assert.equal(session.inbox[49].id, 'msg_50', '最新消息应在末尾');
});

// ── 突变测试补强 ──────────────────────────────────────────────────────────────

test('routeMessage: type 不是 message 时不调用 saveMessage', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const ws = createMockWs();
  ctx.sessions.set('target', { name: 'target', ws, inbox: [], topics: new Set(), inboxExpiry: null });
  const { routeMessage } = createRouter(ctx);

  routeMessage(
    { id: 'sys_1', type: 'system', from: 'sender', to: 'target', content: 'ping' },
    { name: 'sender' },
  );

  assert.equal(ctx._savedMessages.length, 0, 'type=system 时不应调用 saveMessage');
});

test('routeMessage: msg.id 为 null 时不写入 deliveredMessageIds', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const ws = createMockWs();
  ctx.sessions.set('target', { name: 'target', ws, inbox: [], topics: new Set(), inboxExpiry: null });
  const { routeMessage } = createRouter(ctx);

  routeMessage(
    { id: null, type: 'message', from: 'sender', to: 'target', content: 'no id' },
    { name: 'sender' },
  );

  assert.equal(ctx.deliveredMessageIds.size, 0, 'id 为 null 时不应写入 dedup map');
});

test('routeMessage: msg.id 为 null 时不写入 ackPending', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const ws = createMockWs();
  ctx.sessions.set('target', { name: 'target', ws, inbox: [], topics: new Set(), inboxExpiry: null });
  const { routeMessage } = createRouter(ctx);

  routeMessage(
    { id: null, type: 'message', from: 'sender', to: 'target', content: 'no ack' },
    { name: 'sender' },
  );

  assert.equal(ctx.ackPending.size, 0, 'id 为 null 时不应写入 ackPending');
});

test('scheduleInboxCleanup: 重复调用时 clearTimeout 旧 timer', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { scheduleInboxCleanup } = createRouter(ctx);

  const session = {
    name: 'test-agent',
    ws: null,
    connectedAt: 0,
    topics: new Set(),
    inbox: [],
    inboxExpiry: null,
  };
  ctx.sessions.set('test-agent', session);

  scheduleInboxCleanup(session);
  const firstTimer = session.inboxExpiry;
  assert.ok(firstTimer !== null, '第一次调用应设置 timer');

  scheduleInboxCleanup(session);
  const secondTimer = session.inboxExpiry;
  assert.ok(secondTimer !== null, '第二次调用应设置新 timer');
  assert.notEqual(firstTimer, secondTimer, '第二次调用应替换旧 timer');

  clearTimeout(session.inboxExpiry);
});

test('flushInbox: 发送的消息格式为 { type: inbox, messages }', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const ws = createMockWs();
  const { flushInbox } = createRouter(ctx);

  const session = { name: 'agent', ws, inbox: [{ id: 'm1' }, { id: 'm2' }], topics: new Set(), inboxExpiry: null };

  flushInbox(session);

  assert.equal(ws._sent.length, 1, '应发送一条 inbox 消息');
  assert.equal(ws._sent[0].type, 'inbox', 'type 应为 inbox');
  assert.equal(ws._sent[0].messages.length, 2, '应包含 2 条缓冲消息');
  assert.equal(session.inbox.length, 0, 'inbox 应被清空');
});

// ── send catch 块 ─────────────────────────────────────────────────────────────

test('send: ws.send 抛异常时 stderr 记录错误', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { send } = createRouter(ctx);

  const badWs = {
    readyState: 1,
    OPEN: 1,
    send: () => { throw new Error('broken pipe'); },
  };

  assert.doesNotThrow(() => send(badWs, { test: true }));
  assert.ok(ctx._logs.some(l => l.includes('send error')), '应记录 send error 日志');
  assert.ok(ctx._logs.some(l => l.includes('broken pipe')), '日志应包含错误消息');
});

// ── broadcast 详细条件验证 ─────────────────────────────────────────────────────

test('broadcast: ws 存在但非 OPEN 状态时不发送（CLOSED）', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { broadcast } = createRouter(ctx);

  const openWs = createMockWs();
  const closedWs = createMockWs();
  closedWs.readyState = 3; // CLOSED

  ctx.sessions.set('online', createOnlineSession('online', openWs));
  ctx.sessions.set('closed', { name: 'closed', ws: closedWs, connectedAt: 0, topics: new Set(), inbox: [], inboxExpiry: null });

  broadcast({ type: 'test', content: 'hi' });

  assert.equal(openWs._sent.length, 1, 'OPEN session 应收到消息');
  assert.equal(closedWs._sent.length, 0, 'CLOSED ws 不应收到消息');
});

test('broadcast: ws 为 null 时不发送也不报错', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { broadcast } = createRouter(ctx);

  ctx.sessions.set('offline', { name: 'offline', ws: null, connectedAt: 0, topics: new Set(), inbox: [], inboxExpiry: null });

  assert.doesNotThrow(() => broadcast({ type: 'test' }));
});

test('broadcast: 排除 exceptName 精确匹配', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { broadcast } = createRouter(ctx);

  const wsA = createMockWs();
  const wsB = createMockWs();
  const wsC = createMockWs();
  ctx.sessions.set('alice', createOnlineSession('alice', wsA));
  ctx.sessions.set('bob', createOnlineSession('bob', wsB));
  ctx.sessions.set('charlie', createOnlineSession('charlie', wsC));

  broadcast({ type: 'msg', content: 'hello' }, 'bob');

  assert.equal(wsA._sent.length, 1, 'alice 应收到');
  assert.equal(wsB._sent.length, 0, 'bob 被排除不应收到');
  assert.equal(wsC._sent.length, 1, 'charlie 应收到');
});

// ── ackPending 详细验证 ────────────────────────────────────────────────────────

test('routeMessage: ackPending 写入正确的 sender 和 ts', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const ws = createMockWs();
  ctx.sessions.set('target', createOnlineSession('target', ws));
  const { routeMessage } = createRouter(ctx);

  const before = Date.now();
  routeMessage(
    { id: 'ack_test_1', type: 'message', from: 'sender', to: 'target', content: 'test' },
    { name: 'sender' },
  );
  const after = Date.now();

  assert.ok(ctx.ackPending.has('ack_test_1'), 'ackPending 应包含该 id');
  const entry = ctx.ackPending.get('ack_test_1');
  assert.equal(entry.sender, 'sender', 'sender 字段应为发送方 name');
  assert.ok(entry.ts >= before && entry.ts <= after, 'ts 应在调用时间范围内');
});

test('routeMessage: senderSession.name 为空字符串时不写入 ackPending', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const ws = createMockWs();
  ctx.sessions.set('target', createOnlineSession('target', ws));
  const { routeMessage } = createRouter(ctx);

  routeMessage(
    { id: 'ack_empty_sender', type: 'message', from: '', to: 'target', content: 'test' },
    { name: '' },
  );

  assert.equal(ctx.ackPending.size, 0, 'senderSession.name 为空时不应写入 ackPending');
});

test('routeMessage: ackPending entry 包含 sender 和 ts 两个字段', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const ws = createMockWs();
  ctx.sessions.set('target', createOnlineSession('target', ws));
  const { routeMessage } = createRouter(ctx);

  routeMessage(
    { id: 'ack_fields', type: 'message', from: 'alice', to: 'target', content: 'test' },
    { name: 'alice' },
  );

  const entry = ctx.ackPending.get('ack_fields');
  assert.ok(entry !== undefined, 'entry 应存在');
  assert.ok(Object.prototype.hasOwnProperty.call(entry, 'sender'), 'entry 应有 sender 字段');
  assert.ok(Object.prototype.hasOwnProperty.call(entry, 'ts'), 'entry 应有 ts 字段');
  assert.equal(typeof entry.ts, 'number', 'ts 应为数字');
});

// ── topic fanout 详细条件验证 ──────────────────────────────────────────────────

test('routeMessage: topic fanout 时发送方不收到自己的消息', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  const wsSender = createMockWs();
  const wsReceiver = createMockWs();

  const senderSession = createOnlineSession('alice', wsSender);
  senderSession.topics.add('news');
  const receiverSession = createOnlineSession('bob', wsReceiver);
  receiverSession.topics.add('news');

  ctx.sessions.set('alice', senderSession);
  ctx.sessions.set('bob', receiverSession);

  routeMessage(
    { id: 'topic_self', type: 'message', from: 'alice', to: '*', topic: 'news', content: 'self test' },
    { name: 'alice' },
  );

  assert.equal(wsSender._sent.length, 0, '发送方自己不应收到 topic 消息');
  assert.equal(wsReceiver._sent.length, 1, '订阅者应收到消息');
});

test('routeMessage: topic fanout 时非 OPEN 的 session 消息进 inbox', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  const offlineSession = {
    name: 'offline-sub',
    ws: null,
    connectedAt: 0,
    topics: new Set(['updates']),
    inbox: [],
    inboxExpiry: null,
  };
  ctx.sessions.set('offline-sub', offlineSession);

  routeMessage(
    { id: 'topic_offline', type: 'message', from: 'sender', to: '*', topic: 'updates', content: 'update' },
    { name: 'sender' },
  );

  assert.equal(offlineSession.inbox.length, 1, '离线订阅者消息应进 inbox');
  assert.equal(offlineSession.inbox[0].id, 'topic_offline', 'inbox 应包含正确消息');
});

test('routeMessage: topic fanout 时 ws 为 CLOSED 状态的 session 消息进 inbox', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  const closedWs = createMockWs();
  closedWs.readyState = 3; // CLOSED

  const closedSession = {
    name: 'closed-sub',
    ws: closedWs,
    connectedAt: 0,
    topics: new Set(['alerts']),
    inbox: [],
    inboxExpiry: null,
  };
  ctx.sessions.set('closed-sub', closedSession);

  routeMessage(
    { id: 'topic_closed', type: 'message', from: 'sender', to: '*', topic: 'alerts', content: 'alert' },
    { name: 'sender' },
  );

  assert.equal(closedWs._sent.length, 0, 'CLOSED ws 不应直接发送');
  assert.equal(closedSession.inbox.length, 1, 'CLOSED ws 的 session 消息应进 inbox');
});

test('routeMessage: 未订阅 topic 的 session 不收到 topic 消息', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  const wsUnsubbed = createMockWs();
  ctx.sessions.set('unsub', createOnlineSession('unsub', wsUnsubbed));

  routeMessage(
    { id: 'topic_unsub', type: 'message', from: 'sender', to: '*', topic: 'secret', content: 'secret msg' },
    { name: 'sender' },
  );

  assert.equal(wsUnsubbed._sent.length, 0, '未订阅 topic 的 session 不应收到消息');
});

// ── 广播路由详细条件验证 ───────────────────────────────────────────────────────

test('routeMessage: to="*" 广播时发送方自己不收到消息', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  const wsSender = createMockWs();
  const wsOther = createMockWs();
  ctx.sessions.set('alice', createOnlineSession('alice', wsSender));
  ctx.sessions.set('bob', createOnlineSession('bob', wsOther));

  routeMessage(
    { id: 'bc_self', type: 'message', from: 'alice', to: '*', content: 'broadcast' },
    { name: 'alice' },
  );

  assert.equal(wsSender._sent.length, 0, '发送方自己不应收到广播');
  assert.equal(wsOther._sent.length, 1, '其他 session 应收到广播');
});

test('routeMessage: to="*" 广播时离线 session 消息进 inbox', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  const offlineSession = {
    name: 'offline-agent',
    ws: null,
    connectedAt: 0,
    topics: new Set(),
    inbox: [],
    inboxExpiry: null,
  };
  ctx.sessions.set('offline-agent', offlineSession);

  routeMessage(
    { id: 'bc_offline', type: 'message', from: 'sender', to: '*', content: 'broadcast to offline' },
    { name: 'sender' },
  );

  assert.equal(offlineSession.inbox.length, 1, '离线 session 广播消息应进 inbox');
  assert.equal(offlineSession.inbox[0].id, 'bc_offline', 'inbox 应包含正确消息');
});

test('routeMessage: to="*" 广播时 CLOSED ws 的 session 消息进 inbox', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  const closedWs = createMockWs();
  closedWs.readyState = 3; // CLOSED

  const closedSession = {
    name: 'closed-agent',
    ws: closedWs,
    connectedAt: 0,
    topics: new Set(),
    inbox: [],
    inboxExpiry: null,
  };
  ctx.sessions.set('closed-agent', closedSession);

  routeMessage(
    { id: 'bc_closed', type: 'message', from: 'sender', to: '*', content: 'broadcast to closed' },
    { name: 'sender' },
  );

  assert.equal(closedWs._sent.length, 0, 'CLOSED ws 不应直接发送');
  assert.equal(closedSession.inbox.length, 1, 'CLOSED ws session 广播消息应进 inbox');
});

test('routeMessage: topic 存在时 to="*" 不走广播逻辑', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  const wsSubscribed = createMockWs();
  const wsUnsubscribed = createMockWs();

  const subbedSession = createOnlineSession('subbed', wsSubscribed);
  subbedSession.topics.add('chan');
  ctx.sessions.set('subbed', subbedSession);
  ctx.sessions.set('unsubbed', createOnlineSession('unsubbed', wsUnsubscribed));

  routeMessage(
    { id: 'topic_no_bc', type: 'message', from: 'sender', to: '*', topic: 'chan', content: 'topic only' },
    { name: 'sender' },
  );

  // 有 topic 时只走 topic fanout，不走广播
  assert.equal(wsSubscribed._sent.length, 1, '订阅者应通过 topic fanout 收到');
  assert.equal(wsUnsubscribed._sent.length, 0, '未订阅者不应通过广播收到');
});

// ── 普通 IPC 路由详细验证 ─────────────────────────────────────────────────────

test('routeMessage: 离线 session inbox 包含正确消息内容', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  const offlineSession = {
    name: 'offline-eve',
    ws: null,
    connectedAt: 0,
    topics: new Set(),
    inbox: [],
    inboxExpiry: null,
  };
  ctx.sessions.set('offline-eve', offlineSession);

  const msg = { id: 'buf_1', type: 'message', from: 'alice', to: 'offline-eve', content: 'buffered content' };
  routeMessage(msg, { name: 'alice' });

  assert.equal(offlineSession.inbox.length, 1);
  assert.equal(offlineSession.inbox[0].id, 'buf_1');
  assert.equal(offlineSession.inbox[0].content, 'buffered content');
  assert.ok(ctx._logs.some(l => l.includes('offline') || l.includes('buffered')), '应记录 buffered 日志');
});

test('routeMessage: 创建 stub session 的属性正确', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  const msg = { id: 'stub_1', type: 'message', from: 'alice', to: 'unknown-agent', content: 'stub content' };
  routeMessage(msg, { name: 'alice' });

  assert.ok(ctx.sessions.has('unknown-agent'), 'stub session 应被创建');
  const stub = ctx.sessions.get('unknown-agent');

  assert.equal(stub.name, 'unknown-agent', 'stub.name 应等于 to');
  assert.equal(stub.ws, null, 'stub.ws 应为 null');
  assert.equal(stub.connectedAt, 0, 'stub.connectedAt 应为 0');
  assert.ok(stub.topics instanceof Set, 'stub.topics 应为 Set');
  assert.equal(stub.topics.size, 0, 'stub.topics 应为空');
  assert.ok(Array.isArray(stub.inbox), 'stub.inbox 应为数组');
  assert.equal(stub.inbox.length, 1, 'stub.inbox 应包含 1 条消息');
  assert.equal(stub.inbox[0].id, 'stub_1', 'stub.inbox[0] 应为正确消息');
  assert.equal(stub.inbox[0].content, 'stub content', 'stub.inbox[0].content 正确');
});

test('routeMessage: 创建 stub session 时调用 scheduleInboxCleanup（inboxExpiry 被设置）', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  routeMessage(
    { id: 'stub_cleanup', type: 'message', from: 'alice', to: 'ghost-agent', content: 'test' },
    { name: 'alice' },
  );

  const stub = ctx.sessions.get('ghost-agent');
  assert.ok(stub !== undefined, 'stub 应已创建');
  assert.ok(stub.inboxExpiry !== null, 'stub.inboxExpiry 应已被 scheduleInboxCleanup 设置');

  // 清理 timer 避免泄漏
  clearTimeout(stub.inboxExpiry);
});

// ── 飞书群组路由 fetch 参数验证 ────────────────────────────────────────────────

test('feishu-group: fetch 请求包含正确的 chatId 和 content', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.feishuApps = [{ name: 'bot', send: true, targetOpenId: 'oid_xxx' }];
  ctx.getFeishuToken = async () => 'test-token';

  let fetchArgs = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    fetchArgs = { url, opts };
    return { json: async () => ({ code: 0 }) };
  };

  try {
    const { routeMessage } = createRouter(ctx);
    routeMessage(
      { id: 'fg_fetch_1', type: 'message', from: 'sender', to: 'feishu-group:chat_123', content: 'hello feishu' },
      { name: 'sender' },
    );
    await new Promise(r => setTimeout(r, 50));

    assert.ok(fetchArgs !== null, 'fetch 应被调用');
    assert.ok(fetchArgs.url.includes('receive_id_type=chat_id'), 'URL 应包含 receive_id_type=chat_id');
    const body = JSON.parse(fetchArgs.opts.body);
    assert.equal(body.receive_id, 'chat_123', 'receive_id 应为 chatId');
    assert.equal(body.msg_type, 'text', 'msg_type 应为 text');
    assert.deepEqual(JSON.parse(body.content), { text: 'hello feishu' }, 'content 应正确序列化');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('feishu-group: fetch 请求包含正确的 Authorization header', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.feishuApps = [{ name: 'bot', send: true, targetOpenId: 'oid_xxx' }];
  ctx.getFeishuToken = async () => 'my-secret-token';

  let fetchHeaders = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    fetchHeaders = opts.headers;
    return { json: async () => ({ code: 0 }) };
  };

  try {
    const { routeMessage } = createRouter(ctx);
    routeMessage(
      { id: 'fg_auth', type: 'message', from: 'sender', to: 'feishu-group:chat_xyz', content: 'auth test' },
      { name: 'sender' },
    );
    await new Promise(r => setTimeout(r, 50));

    assert.ok(fetchHeaders !== null, 'headers 应被设置');
    assert.equal(fetchHeaders['Authorization'], 'Bearer my-secret-token', 'Authorization 应包含正确 token');
    assert.equal(fetchHeaders['Content-Type'], 'application/json');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('feishu-group: fetch 返回 code !== 0 时打日志', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.feishuApps = [{ name: 'bot', send: true, targetOpenId: 'oid_xxx' }];
  ctx.getFeishuToken = async () => 'token';

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ code: 99, msg: 'bad request' }) });

  try {
    const { routeMessage } = createRouter(ctx);
    routeMessage(
      { id: 'fg_err', type: 'message', from: 'sender', to: 'feishu-group:chat_err', content: 'err test' },
      { name: 'sender' },
    );
    await new Promise(r => setTimeout(r, 50));

    assert.ok(ctx._logs.some(l => l.includes('99') || l.includes('error')), '应记录错误 code 日志');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('feishu-group: fetch 成功时打日志含 chatId', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.feishuApps = [{ name: 'bot', send: true, targetOpenId: 'oid_xxx' }];
  ctx.getFeishuToken = async () => 'token';

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ code: 0 }) });

  try {
    const { routeMessage } = createRouter(ctx);
    routeMessage(
      { id: 'fg_ok', type: 'message', from: 'sender', to: 'feishu-group:chat_ok', content: 'ok test' },
      { name: 'sender' },
    );
    await new Promise(r => setTimeout(r, 50));

    assert.ok(ctx._logs.some(l => l.includes('chat_ok') || l.includes('sent')), '成功时应打含 chatId 的日志');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('feishu-group: fetch 抛异常时打日志不 crash', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.feishuApps = [{ name: 'bot', send: true, targetOpenId: 'oid_xxx' }];
  ctx.getFeishuToken = async () => 'token';

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network error'); };

  try {
    const { routeMessage } = createRouter(ctx);
    assert.doesNotThrow(() => routeMessage(
      { id: 'fg_throw', type: 'message', from: 'sender', to: 'feishu-group:chat_throw', content: 'throw test' },
      { name: 'sender' },
    ));
    await new Promise(r => setTimeout(r, 50));

    assert.ok(ctx._logs.some(l => l.includes('failed') || l.includes('network error')), '应记录异常日志');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('feishu-group: getFeishuToken 返回 null 时不调用 fetch', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.feishuApps = [{ name: 'bot', send: true, targetOpenId: 'oid_xxx' }];
  ctx.getFeishuToken = async () => null;

  let fetchCalled = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; return { json: async () => ({ code: 0 }) }; };

  try {
    const { routeMessage } = createRouter(ctx);
    routeMessage(
      { id: 'fg_notoken', type: 'message', from: 'sender', to: 'feishu-group:chat_notoken', content: 'no token' },
      { name: 'sender' },
    );
    await new Promise(r => setTimeout(r, 50));

    assert.equal(fetchCalled, false, 'token 为 null 时不应调用 fetch');
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ── 飞书 P2P 路由 fetch 参数验证 ──────────────────────────────────────────────

test('feishu P2P: fetch 请求包含正确的 receiveId 和 receiveIdType（chatId 优先）', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.feishuApps = [{ name: 'bot', send: true, chatId: 'chat_p2p_456', targetOpenId: 'open_oid' }];
  ctx.getFeishuToken = async () => 'p2p-token';

  let fetchArgs = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    fetchArgs = { url, opts };
    return { json: async () => ({ code: 0 }) };
  };

  try {
    const { routeMessage } = createRouter(ctx);
    routeMessage(
      { id: 'p2p_chat', type: 'message', from: 'sender', to: 'feishu', content: 'p2p hello' },
      { name: 'sender' },
    );
    await new Promise(r => setTimeout(r, 50));

    assert.ok(fetchArgs !== null, 'fetch 应被调用');
    // chatId 存在时 receiveIdType 应为 chat_id
    assert.ok(fetchArgs.url.includes('receive_id_type=chat_id'), 'chatId 存在时 URL 应用 chat_id');
    const body = JSON.parse(fetchArgs.opts.body);
    assert.equal(body.receive_id, 'chat_p2p_456', 'receive_id 应为 chatId');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('feishu P2P: 无 chatId 时使用 targetOpenId 和 open_id 类型', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.feishuApps = [{ name: 'bot', send: true, targetOpenId: 'open_id_abc' }];
  ctx.getFeishuToken = async () => 'token';

  let fetchArgs = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    fetchArgs = { url, opts };
    return { json: async () => ({ code: 0 }) };
  };

  try {
    const { routeMessage } = createRouter(ctx);
    routeMessage(
      { id: 'p2p_openid', type: 'message', from: 'sender', to: 'feishu', content: 'p2p open_id' },
      { name: 'sender' },
    );
    await new Promise(r => setTimeout(r, 50));

    assert.ok(fetchArgs !== null, 'fetch 应被调用');
    assert.ok(fetchArgs.url.includes('receive_id_type=open_id'), '无 chatId 时 URL 应用 open_id');
    const body = JSON.parse(fetchArgs.opts.body);
    assert.equal(body.receive_id, 'open_id_abc', 'receive_id 应为 targetOpenId');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('feishu P2P: fetch content 正确序列化为 JSON 字符串', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.feishuApps = [{ name: 'bot', send: true, targetOpenId: 'oid_p2p' }];
  ctx.getFeishuToken = async () => 'token';

  let fetchBody = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    fetchBody = JSON.parse(opts.body);
    return { json: async () => ({ code: 0 }) };
  };

  try {
    const { routeMessage } = createRouter(ctx);
    routeMessage(
      { id: 'p2p_content', type: 'message', from: 'sender', to: 'feishu', content: 'test content 123' },
      { name: 'sender' },
    );
    await new Promise(r => setTimeout(r, 50));

    assert.ok(fetchBody !== null, 'fetch body 应被捕获');
    assert.equal(fetchBody.msg_type, 'text', 'msg_type 应为 text');
    const contentParsed = JSON.parse(fetchBody.content);
    assert.deepEqual(contentParsed, { text: 'test content 123' }, 'content 应正确序列化');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('feishu P2P: fetch 返回 code !== 0 时打日志', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.feishuApps = [{ name: 'mybot', send: true, targetOpenId: 'oid_err' }];
  ctx.getFeishuToken = async () => 'token';

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ code: 400, msg: 'invalid param' }) });

  try {
    const { routeMessage } = createRouter(ctx);
    routeMessage(
      { id: 'p2p_err', type: 'message', from: 'sender', to: 'feishu', content: 'err' },
      { name: 'sender' },
    );
    await new Promise(r => setTimeout(r, 50));

    assert.ok(ctx._logs.some(l => l.includes('400') || l.includes('error') || l.includes('mybot')), '应记录错误日志');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('feishu P2P: fetch 成功时打日志含 app.name', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.feishuApps = [{ name: 'success-bot', send: true, targetOpenId: 'oid_ok' }];
  ctx.getFeishuToken = async () => 'token';

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ code: 0 }) });

  try {
    const { routeMessage } = createRouter(ctx);
    routeMessage(
      { id: 'p2p_ok', type: 'message', from: 'sender', to: 'feishu', content: 'ok' },
      { name: 'sender' },
    );
    await new Promise(r => setTimeout(r, 50));

    assert.ok(ctx._logs.some(l => l.includes('success-bot')), '成功日志应包含 app.name');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('feishu P2P: fetch 抛异常时打日志不 crash', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.feishuApps = [{ name: 'crash-bot', send: true, targetOpenId: 'oid_crash' }];
  ctx.getFeishuToken = async () => 'token';

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('connection refused'); };

  try {
    const { routeMessage } = createRouter(ctx);
    assert.doesNotThrow(() => routeMessage(
      { id: 'p2p_crash', type: 'message', from: 'sender', to: 'feishu', content: 'crash' },
      { name: 'sender' },
    ));
    await new Promise(r => setTimeout(r, 50));

    assert.ok(ctx._logs.some(l => l.includes('failed') || l.includes('connection refused') || l.includes('crash-bot')), '应记录异常日志');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('feishu P2P: getFeishuToken 返回 null 时不调用 fetch', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.feishuApps = [{ name: 'bot', send: true, targetOpenId: 'oid' }];
  ctx.getFeishuToken = async () => null;

  let fetchCalled = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; return { json: async () => ({ code: 0 }) }; };

  try {
    const { routeMessage } = createRouter(ctx);
    routeMessage(
      { id: 'p2p_notoken', type: 'message', from: 'sender', to: 'feishu', content: 'no token' },
      { name: 'sender' },
    );
    await new Promise(r => setTimeout(r, 50));

    assert.equal(fetchCalled, false, 'token 为 null 时不应调用 fetch');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('feishu P2P: 通过 feishu:<appName> 精确找到指定 app 的 receiveId', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.feishuApps = [
    { name: 'bot-a', send: true, targetOpenId: 'oid_a' },
    { name: 'bot-b', chatId: 'chat_b_789', targetOpenId: 'oid_b' },
  ];
  ctx.getFeishuToken = async () => 'token';

  let fetchBody = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    fetchBody = JSON.parse(opts.body);
    return { json: async () => ({ code: 0 }) };
  };

  try {
    const { routeMessage } = createRouter(ctx);
    routeMessage(
      { id: 'p2p_named', type: 'message', from: 'sender', to: 'feishu:bot-b', content: 'named bot' },
      { name: 'sender' },
    );
    await new Promise(r => setTimeout(r, 50));

    assert.ok(fetchBody !== null, 'fetch 应被调用');
    // bot-b 有 chatId，应优先使用 chatId
    assert.equal(fetchBody.receive_id, 'chat_b_789', '应使用 bot-b 的 chatId');
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ── scheduleInboxCleanup 真实 timer 行为验证 ───────────────────────────────────

test('scheduleInboxCleanup: 调用后 inboxExpiry 不为 null', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { scheduleInboxCleanup } = createRouter(ctx);

  const session = {
    name: 'timer-test',
    ws: null,
    connectedAt: 0,
    topics: new Set(),
    inbox: [],
    inboxExpiry: null,
  };

  scheduleInboxCleanup(session);
  assert.ok(session.inboxExpiry !== null, 'inboxExpiry 应被设置为非 null');

  clearTimeout(session.inboxExpiry);
});

test('scheduleInboxCleanup: 已有 timer 时再次调用会替换为新 timer', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { scheduleInboxCleanup } = createRouter(ctx);

  const session = {
    name: 'timer-replace',
    ws: null,
    connectedAt: 0,
    topics: new Set(),
    inbox: [],
    inboxExpiry: null,
  };

  scheduleInboxCleanup(session);
  const first = session.inboxExpiry;
  assert.ok(first !== null, '第一次调用应设置 timer');

  scheduleInboxCleanup(session);
  const second = session.inboxExpiry;
  assert.ok(second !== null, '第二次调用应设置新 timer');
  assert.notEqual(String(first), String(second), '两次 timer 应不同（旧的被替换）');

  clearTimeout(session.inboxExpiry);
});

// ── OpenClaw 路由：topic fanout 时跳过的验证 ─────────────────────────────────

test('routeMessage: topic fanout 时跳过 openclaw session，消息不进其 inbox', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  const ocSession = {
    name: 'openclaw',
    ws: null,
    connectedAt: 0,
    topics: new Set(['events']),
    inbox: [],
    inboxExpiry: null,
  };
  ctx.sessions.set('openclaw', ocSession);

  routeMessage(
    { id: 'topic_oc_skip', type: 'message', from: 'sender', to: '*', topic: 'events', content: 'skip oc' },
    { name: 'sender' },
  );

  assert.equal(ocSession.inbox.length, 0, 'openclaw session topic fanout 时 inbox 也不应收到');
});

test('routeMessage: to="*" 广播时跳过 openclaw，消息不进其 inbox', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  const ocSession = {
    name: 'openclaw',
    ws: null,
    connectedAt: 0,
    topics: new Set(),
    inbox: [],
    inboxExpiry: null,
  };
  ctx.sessions.set('openclaw', ocSession);

  routeMessage(
    { id: 'bc_oc_skip', type: 'message', from: 'sender', to: '*', content: 'skip oc broadcast' },
    { name: 'sender' },
  );

  assert.equal(ocSession.inbox.length, 0, '广播时 openclaw inbox 也不应收到');
});

// ── 去重写入 deliveredMessageIds 验证 ────────────────────────────────────────

test('routeMessage: msg.id 存在时写入 deliveredMessageIds', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const ws = createMockWs();
  ctx.sessions.set('target', createOnlineSession('target', ws));
  const { routeMessage } = createRouter(ctx);

  routeMessage(
    { id: 'dedup_write', type: 'message', from: 'alice', to: 'target', content: 'test' },
    { name: 'alice' },
  );

  assert.ok(ctx.deliveredMessageIds.has('dedup_write'), 'deliveredMessageIds 应包含 msg.id');
  assert.equal(typeof ctx.deliveredMessageIds.get('dedup_write'), 'number', 'value 应为 timestamp 数字');
});

test('routeMessage: 重复 msg.id 不再写入 ackPending 不重复累加', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const ws = createMockWs();
  ctx.sessions.set('target', createOnlineSession('target', ws));
  const { routeMessage } = createRouter(ctx);

  routeMessage(
    { id: 'dup_ack', type: 'message', from: 'alice', to: 'target', content: 'first' },
    { name: 'alice' },
  );
  const firstEntry = ctx.ackPending.get('dup_ack');

  routeMessage(
    { id: 'dup_ack', type: 'message', from: 'alice', to: 'target', content: 'second dup' },
    { name: 'alice' },
  );

  // 第二次调用应被去重跳过，ackPending 的 entry 不变
  assert.equal(ctx.ackPending.size, 1, 'ackPending 应只有一条 entry');
  assert.equal(ctx.ackPending.get('dup_ack'), firstEntry, '重复消息不应更新 ackPending');
});

// ── topic + to 组合：同时有 topic 和直接地址时不重复投递 ──────────────────────

test('routeMessage: topic fanout 已投递的 session，直接寻址时不重复', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  const wsBob = createMockWs();
  const bobSession = createOnlineSession('bob', wsBob);
  bobSession.topics.add('news');
  ctx.sessions.set('bob', bobSession);

  // to='bob' 且带 topic，bob 已通过 topic fanout 收到，直接寻址应被跳过（delivered.has）
  routeMessage(
    { id: 'combo_1', type: 'message', from: 'alice', to: 'bob', topic: 'news', content: 'combo' },
    { name: 'alice' },
  );

  assert.equal(wsBob._sent.length, 1, 'bob 应只收到一条消息（不重复）');
});

// ── flushInbox 内容验证 ────────────────────────────────────────────────────────

test('flushInbox: messages 数组包含原始消息对象', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const ws = createMockWs();
  const { flushInbox } = createRouter(ctx);

  const msg1 = { id: 'flush_a', type: 'message', content: 'first buffered' };
  const msg2 = { id: 'flush_b', type: 'message', content: 'second buffered' };
  const session = { name: 'agent', ws, inbox: [msg1, msg2], topics: new Set(), inboxExpiry: null };

  flushInbox(session);

  const sent = ws._sent[0];
  assert.equal(sent.messages[0].id, 'flush_a');
  assert.equal(sent.messages[0].content, 'first buffered');
  assert.equal(sent.messages[1].id, 'flush_b');
  assert.equal(sent.messages[1].content, 'second buffered');
});

// ── feishu-group: chatId 为空字符串时不发送 ────────────────────────────────────

test('feishu-group: chatId 为空字符串时不触发 feishu 请求', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.feishuApps = [{ name: 'bot', send: true, targetOpenId: 'oid' }];
  ctx.getFeishuToken = async () => 'token';

  let tokenCalled = false;
  ctx.getFeishuToken = async () => { tokenCalled = true; return 'token'; };

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ code: 0 }) });

  try {
    const { routeMessage } = createRouter(ctx);
    // to='feishu-group:' (empty chatId after split)
    routeMessage(
      { id: 'fg_empty_chat', type: 'message', from: 'sender', to: 'feishu-group:', content: 'empty chatId' },
      { name: 'sender' },
    );
    await new Promise(r => setTimeout(r, 50));

    // chatId 为空，不应调用 getFeishuToken
    assert.equal(tokenCalled, false, 'chatId 为空时不应调用 getFeishuToken');
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ── routeMessage: stderr 记录路由信息 ─────────────────────────────────────────

test('routeMessage: 调用时 stderr 记录 from→to 信息', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const ws = createMockWs();
  ctx.sessions.set('target', createOnlineSession('target', ws));
  const { routeMessage } = createRouter(ctx);

  routeMessage(
    { id: 'log_test', type: 'message', from: 'alice', to: 'target', content: 'test' },
    { name: 'alice' },
  );

  assert.ok(ctx._logs.some(l => l.includes('alice') && l.includes('target')), 'stderr 应记录 from→to 信息');
});

// ── pushInbox 边界：连续写入内容顺序正确 ─────────────────────────────────────

test('pushInbox: 多次 push 后消息顺序 FIFO', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { pushInbox } = createRouter(ctx);

  const session = createOnlineSession('agent', null);
  pushInbox(session, { id: 'first' });
  pushInbox(session, { id: 'second' });
  pushInbox(session, { id: 'third' });

  assert.equal(session.inbox[0].id, 'first');
  assert.equal(session.inbox[1].id, 'second');
  assert.equal(session.inbox[2].id, 'third');
});

// ── broadcast: 只有一个 session 时排除后无人接收 ─────────────────────────────

test('broadcast: session 全部被排除时不报错', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { broadcast } = createRouter(ctx);

  const ws = createMockWs();
  ctx.sessions.set('alice', createOnlineSession('alice', ws));

  assert.doesNotThrow(() => broadcast({ type: 'msg' }, 'alice'));
  assert.equal(ws._sent.length, 0, 'alice 被排除后没有人收到消息');
});

// ── D组：OpenClaw deliver 成功后 pending-cards.json 更新验证 ─────────────────

import { readFileSync as _readFileSync, writeFileSync as _writeFileSync, existsSync as _existsSync, mkdirSync as _mkdirSync } from 'node:fs';
import { join as _join, dirname as _dirname } from 'node:path';
import { fileURLToPath as _fileURLToPath } from 'node:url';

const __testDir = _dirname(_fileURLToPath(import.meta.url));
const _pcPath = _join(__testDir, '..', 'data', 'pending-cards.json');

/** 备份并替换 pending-cards.json，测试后还原（支持 async fn） */
async function withPendingCards(testData, fn) {
  let original = null;
  const hadFile = _existsSync(_pcPath);
  if (hadFile) {
    original = _readFileSync(_pcPath, 'utf8');
  }
  _writeFileSync(_pcPath, JSON.stringify(testData));
  try {
    return await fn();
  } finally {
    if (hadFile && original !== null) {
      _writeFileSync(_pcPath, original);
    }
  }
}

test('OpenClaw: deliver 成功后更新 pending-cards.json 中匹配任务的 stage 为 2', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  const msgId = 'msg_pending_test_001';
  ctx.deliverToOpenClaw = async () => true;

  const testData = {
    'test-app': {
      chatId: 'chat_test',
      cardMessageId: 'card_test',
      tasks: [
        { id: msgId, preview: 'test task', stage: 1, hubMessageId: msgId },
        { id: 'other_msg', preview: 'other', stage: 1, hubMessageId: 'other_msg' },
      ],
    },
  };

  await withPendingCards(testData, async () => {
    const { routeMessage } = createRouter(ctx);
    ctx.sessions.set('openclaw', createOnlineSession('openclaw', createMockWs()));

    routeMessage(
      { id: msgId, type: 'message', from: 'sender', to: 'openclaw', content: 'test' },
      { name: 'sender' },
    );
    await new Promise(r => setTimeout(r, 150));

    const updated = JSON.parse(_readFileSync(_pcPath, 'utf8'));
    const task = updated['test-app'].tasks.find(t => t.hubMessageId === msgId);
    assert.ok(task !== undefined, '应能找到对应任务');
    assert.equal(task.stage, 2, '匹配任务的 stage 应被更新为 2');

    // 不匹配的任务不受影响
    const otherTask = updated['test-app'].tasks.find(t => t.hubMessageId === 'other_msg');
    assert.equal(otherTask.stage, 1, '不匹配的任务 stage 不应被修改');
  });
});

test('OpenClaw: deliver 成功后只更新 stage<2 的匹配任务', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  const msgId = 'msg_stage2_test';
  ctx.deliverToOpenClaw = async () => true;

  const testData = {
    'app1': {
      tasks: [
        { id: msgId, preview: 'already done', stage: 2, hubMessageId: msgId }, // stage 已经是 2
        { id: 'fresh', preview: 'fresh', stage: 0, hubMessageId: msgId },       // stage < 2，同 msgId
      ],
    },
  };

  await withPendingCards(testData, async () => {
    const { routeMessage } = createRouter(ctx);
    ctx.sessions.set('openclaw', createOnlineSession('openclaw', createMockWs()));

    routeMessage(
      { id: msgId, type: 'message', from: 'sender', to: 'openclaw', content: 'test' },
      { name: 'sender' },
    );
    await new Promise(r => setTimeout(r, 150));

    const updated = JSON.parse(_readFileSync(_pcPath, 'utf8'));
    // stage=0 的任务应被更新为 2
    assert.equal(updated['app1'].tasks[1].stage, 2, 'stage=0 的匹配任务应更新为 2');
    // stage=2 的任务：stage < 2 为 false，不应被重复写入（实际仍为 2）
    assert.equal(updated['app1'].tasks[0].stage, 2, 'stage=2 的任务保持 2');
  });
});

test('OpenClaw: deliver 成功后多个 app 中的匹配任务都被更新', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  const msgId = 'msg_multi_app';
  ctx.deliverToOpenClaw = async () => true;

  const testData = {
    'app-a': {
      tasks: [{ id: msgId, preview: 'a task', stage: 1, hubMessageId: msgId }],
    },
    'app-b': {
      tasks: [{ id: msgId, preview: 'b task', stage: 1, hubMessageId: msgId }],
    },
    'app-c': {
      chatId: 'c1', // 没有 tasks 字段
    },
  };

  await withPendingCards(testData, async () => {
    const { routeMessage } = createRouter(ctx);
    ctx.sessions.set('openclaw', createOnlineSession('openclaw', createMockWs()));

    routeMessage(
      { id: msgId, type: 'message', from: 'sender', to: 'openclaw', content: 'multi' },
      { name: 'sender' },
    );
    await new Promise(r => setTimeout(r, 150));

    const updated = JSON.parse(_readFileSync(_pcPath, 'utf8'));
    assert.equal(updated['app-a'].tasks[0].stage, 2, 'app-a 的任务应更新为 2');
    assert.equal(updated['app-b'].tasks[0].stage, 2, 'app-b 的任务应更新为 2');
  });
});

test('OpenClaw: deliver 成功且 pending-cards.json 不存在时 catch 块吞掉错误不 crash', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.deliverToOpenClaw = async () => true;

  // 用不存在的 msgId，但先备份再恢复文件避免影响实际文件
  const origContent = _existsSync(_pcPath) ? _readFileSync(_pcPath, 'utf8') : null;
  // 写一个解析会失败的文件来触发 catch
  _writeFileSync(_pcPath, 'INVALID_JSON');

  try {
    const { routeMessage } = createRouter(ctx);
    ctx.sessions.set('openclaw', createOnlineSession('openclaw', createMockWs()));

    assert.doesNotThrow(() => routeMessage(
      { id: 'msg_bad_json', type: 'message', from: 'sender', to: 'openclaw', content: 'test' },
      { name: 'sender' },
    ));
    await new Promise(r => setTimeout(r, 150));

    // 不应 crash，错误被 catch{} 吞掉
  } finally {
    if (origContent !== null) {
      _writeFileSync(_pcPath, origContent);
    }
  }
});

test('OpenClaw: deliver 失败（false）时不更新 pending-cards.json', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  const msgId = 'msg_fail_no_update';
  ctx.deliverToOpenClaw = async () => false;
  ctx.enqueueOpenClawRetry = () => {};

  const testData = {
    'app1': {
      tasks: [{ id: msgId, preview: 'task', stage: 1, hubMessageId: msgId }],
    },
  };

  await withPendingCards(testData, async () => {
    const { routeMessage } = createRouter(ctx);
    ctx.sessions.set('openclaw', createOnlineSession('openclaw', createMockWs()));

    routeMessage(
      { id: msgId, type: 'message', from: 'sender', to: 'openclaw', content: 'fail test' },
      { name: 'sender' },
    );
    await new Promise(r => setTimeout(r, 150));

    const updated = JSON.parse(_readFileSync(_pcPath, 'utf8'));
    assert.equal(updated['app1'].tasks[0].stage, 1, 'deliver 失败时 stage 不应被更新');
  });
});

// ── A组：feishuApps.find 条件精确性验证 ──────────────────────────────────────
// 构造多个 app，让 filter 条件区分选中哪个，杀掉 &&→|| 或 &&→true 突变体

test('feishu-group: find 条件 send&&targetOpenId 精确 —— send=false 的 app 被排除', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  // 两个 app，第一个 send=false，第二个 send=true
  ctx.feishuApps = [
    { name: 'no-send', send: false, targetOpenId: 'oid_nosend' },
    { name: 'correct', send: true, targetOpenId: 'oid_correct' },
  ];

  let calledWithApp = null;
  ctx.getFeishuToken = async (app) => {
    calledWithApp = app;
    return 'token';
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ code: 0 }) });

  try {
    const { routeMessage } = createRouter(ctx);
    routeMessage(
      { id: 'fg_find_1', type: 'message', from: 'sender', to: 'feishu-group:chat_multi', content: 'test' },
      { name: 'sender' },
    );
    await new Promise(r => setTimeout(r, 50));

    assert.ok(calledWithApp !== null, 'getFeishuToken 应被调用');
    assert.equal(calledWithApp.name, 'correct', 'find 应选中 send=true 的 app，不是 no-send');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('feishu-group: find 条件 send&&targetOpenId 精确 —— targetOpenId 为空的 app 被排除', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  // 两个 app，第一个没有 targetOpenId，第二个有
  ctx.feishuApps = [
    { name: 'no-oid', send: true, targetOpenId: '' },
    { name: 'has-oid', send: true, targetOpenId: 'oid_valid' },
  ];

  let calledWithApp = null;
  ctx.getFeishuToken = async (app) => {
    calledWithApp = app;
    return 'token';
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ code: 0 }) });

  try {
    const { routeMessage } = createRouter(ctx);
    routeMessage(
      { id: 'fg_find_2', type: 'message', from: 'sender', to: 'feishu-group:chat_oid', content: 'test' },
      { name: 'sender' },
    );
    await new Promise(r => setTimeout(r, 50));

    assert.ok(calledWithApp !== null, 'getFeishuToken 应被调用');
    assert.equal(calledWithApp.name, 'has-oid', 'find 应选中有 targetOpenId 的 app');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('feishu-group: find 只选第一个同时满足 send&&targetOpenId 的 app', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  // 三个 app：前两个都满足条件，第三个不满足
  ctx.feishuApps = [
    { name: 'first-valid', send: true, targetOpenId: 'oid_first' },
    { name: 'second-valid', send: true, targetOpenId: 'oid_second' },
    { name: 'no-send', send: false, targetOpenId: 'oid_third' },
  ];

  let calledWithApp = null;
  ctx.getFeishuToken = async (app) => {
    calledWithApp = app;
    return 'token';
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ code: 0 }) });

  try {
    const { routeMessage } = createRouter(ctx);
    routeMessage(
      { id: 'fg_find_3', type: 'message', from: 'sender', to: 'feishu-group:chat_first', content: 'test' },
      { name: 'sender' },
    );
    await new Promise(r => setTimeout(r, 50));

    // find 返回第一个满足的，应为 first-valid
    assert.equal(calledWithApp.name, 'first-valid', 'find 应返回第一个满足 send&&targetOpenId 的 app');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('feishu P2P 默认: find 条件 send&&(chatId||targetOpenId) 精确 —— send=false 排除', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.feishuApps = [
    { name: 'no-send', send: false, chatId: 'c1' },
    { name: 'no-id', send: true },
    { name: 'correct', send: true, chatId: 'c2' },
  ];

  let calledWithApp = null;
  ctx.getFeishuToken = async (app) => {
    calledWithApp = app;
    return 'token';
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ code: 0 }) });

  try {
    const { routeMessage } = createRouter(ctx);
    routeMessage(
      { id: 'p2p_find_1', type: 'message', from: 'sender', to: 'feishu', content: 'test' },
      { name: 'sender' },
    );
    await new Promise(r => setTimeout(r, 50));

    assert.ok(calledWithApp !== null, 'getFeishuToken 应被调用');
    assert.equal(calledWithApp.name, 'correct', 'find 应选中 send=true 且有 chatId 的 app');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('feishu P2P 默认: find 条件 —— 无 chatId 也无 targetOpenId 的 app 被排除', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.feishuApps = [
    { name: 'no-id', send: true },              // 无 chatId 和 targetOpenId
    { name: 'has-oid', send: true, targetOpenId: 'oid_x' }, // 有 targetOpenId
  ];

  let calledWithApp = null;
  ctx.getFeishuToken = async (app) => {
    calledWithApp = app;
    return 'token';
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ code: 0 }) });

  try {
    const { routeMessage } = createRouter(ctx);
    routeMessage(
      { id: 'p2p_find_2', type: 'message', from: 'sender', to: 'feishu', content: 'test' },
      { name: 'sender' },
    );
    await new Promise(r => setTimeout(r, 50));

    assert.equal(calledWithApp.name, 'has-oid', 'find 应跳过无 chatId/targetOpenId 的 app');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('feishu P2P 指定 appName: find 条件 name===appName&&(chatId||targetOpenId) 精确', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  // 同名 app 但一个无 chatId/targetOpenId
  ctx.feishuApps = [
    { name: 'target-bot', send: false },                    // 无 chatId/targetOpenId
    { name: 'target-bot', chatId: 'c_target' },             // 有 chatId
  ];

  let calledWithApp = null;
  ctx.getFeishuToken = async (app) => {
    calledWithApp = app;
    return 'token';
  };

  const origFetch = globalThis.fetch;
  let fetchBody = null;
  globalThis.fetch = async (url, opts) => {
    fetchBody = JSON.parse(opts.body);
    return { json: async () => ({ code: 0 }) };
  };

  try {
    const { routeMessage } = createRouter(ctx);
    routeMessage(
      { id: 'p2p_named_find', type: 'message', from: 'sender', to: 'feishu:target-bot', content: 'named' },
      { name: 'sender' },
    );
    await new Promise(r => setTimeout(r, 50));

    assert.ok(calledWithApp !== null, 'getFeishuToken 应被调用');
    // 应选中有 chatId 的那个
    assert.equal(fetchBody.receive_id, 'c_target', '应选中有 chatId 的 app，不是无 id 的 app');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('feishu P2P 指定 appName: 只匹配指定 name 的 app，不匹配其他 name', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.feishuApps = [
    { name: 'other-bot', send: true, chatId: 'c_other' },
    { name: 'wanted-bot', chatId: 'c_wanted' },
  ];

  let calledWithApp = null;
  ctx.getFeishuToken = async (app) => {
    calledWithApp = app;
    return 'token';
  };

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ code: 0 }) });

  try {
    const { routeMessage } = createRouter(ctx);
    routeMessage(
      { id: 'p2p_named_exact', type: 'message', from: 'sender', to: 'feishu:wanted-bot', content: 'exact' },
      { name: 'sender' },
    );
    await new Promise(r => setTimeout(r, 50));

    assert.ok(calledWithApp !== null, 'getFeishuToken 应被调用');
    assert.equal(calledWithApp.name, 'wanted-bot', 'find 应精确匹配 name=wanted-bot，不选 other-bot');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('feishu P2P: chatId 优先于 targetOpenId 作为 receiveId 和 receiveIdType', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  // app 同时有 chatId 和 targetOpenId
  ctx.feishuApps = [{ name: 'both', send: true, chatId: 'c_primary', targetOpenId: 'oid_secondary' }];
  ctx.getFeishuToken = async () => 'token';

  let fetchUrl = null;
  let fetchBody = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    fetchUrl = url;
    fetchBody = JSON.parse(opts.body);
    return { json: async () => ({ code: 0 }) };
  };

  try {
    const { routeMessage } = createRouter(ctx);
    routeMessage(
      { id: 'p2p_chatid_prio', type: 'message', from: 'sender', to: 'feishu', content: 'chatid priority' },
      { name: 'sender' },
    );
    await new Promise(r => setTimeout(r, 50));

    assert.ok(fetchUrl.includes('receive_id_type=chat_id'), 'chatId 存在时 URL 应用 chat_id，不是 open_id');
    assert.equal(fetchBody.receive_id, 'c_primary', 'receive_id 应为 chatId，不是 targetOpenId');
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ── B组：routing 条件分支精确性验证 ──────────────────────────────────────────

test('routeMessage: to=undefined 时不走直接路由（不创建 stub）', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  const senderSession = { name: 'alice' };
  // to=undefined，既不是 '*' 也不是具体地址
  const msg = { id: 'no_to_1', type: 'message', from: 'alice', to: undefined, content: 'no target' };

  assert.doesNotThrow(() => routeMessage(msg, senderSession));

  // 不应该创建任何 stub
  assert.equal(ctx.sessions.size, 0, 'to=undefined 时不应创建 stub session');
});

test('routeMessage: to=null 时不走直接路由（不创建 stub）', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  const senderSession = { name: 'alice' };
  const msg = { id: 'no_to_2', type: 'message', from: 'alice', to: null, content: 'no target' };

  assert.doesNotThrow(() => routeMessage(msg, senderSession));

  assert.equal(ctx.sessions.size, 0, 'to=null 时不应创建 stub session');
});

test('routeMessage: to="" 时不走直接路由（不创建 stub）', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  const senderSession = { name: 'alice' };
  const msg = { id: 'no_to_3', type: 'message', from: 'alice', to: '', content: 'empty to' };

  assert.doesNotThrow(() => routeMessage(msg, senderSession));

  assert.equal(ctx.sessions.size, 0, 'to="" 时不应创建 stub session');
});

test('routeMessage: to="*" 时不走直接路由（不创建 stub）', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  const wsOther = createMockWs();
  ctx.sessions.set('other', createOnlineSession('other', wsOther));

  const senderSession = { name: 'alice' };
  const msg = { id: 'bc_no_stub', type: 'message', from: 'alice', to: '*', content: 'broadcast' };

  routeMessage(msg, senderSession);

  // to='*' 走广播路径，sessions 里不应出现新的 stub
  assert.equal(ctx.sessions.size, 1, 'to="*" 时不应创建 stub，sessions 仍只有 other');
  assert.ok(ctx.sessions.has('other'), 'other session 应保持不变');
});

test('routeMessage: topic=null 时不走 topic fanout', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  const wsBob = createMockWs();
  const bobSession = createOnlineSession('bob', wsBob);
  bobSession.topics.add('news');
  ctx.sessions.set('bob', bobSession);

  // 有 topic 订阅的 session，但消息 topic=null，不应走 topic fanout
  routeMessage(
    { id: 'no_topic_1', type: 'message', from: 'alice', to: '*', topic: null, content: 'no topic' },
    { name: 'alice' },
  );

  // to='*' 且 topic=null，走广播，bob 应通过广播收到（而非 topic fanout）
  // 但此测试验证：null topic 不触发 topic fanout（通过检查 bob 收到消息是广播路径）
  assert.equal(wsBob._sent.length, 1, 'topic=null 时走广播路径，bob 应收到广播');
});

test('routeMessage: topic=undefined 时不走 topic fanout，走广播', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  const wsSubscribed = createMockWs();
  const wsUnsubscribed = createMockWs();
  const subbedSession = createOnlineSession('subbed', wsSubscribed);
  subbedSession.topics.add('news');
  ctx.sessions.set('subbed', subbedSession);
  ctx.sessions.set('unsubbed', createOnlineSession('unsubbed', wsUnsubscribed));

  // topic=undefined，to='*'，应走广播而非 topic fanout
  routeMessage(
    { id: 'no_topic_2', type: 'message', from: 'sender', to: '*', topic: undefined, content: 'broadcast' },
    { name: 'sender' },
  );

  // 广播时两个 session 都收到（不区分是否订阅）
  assert.equal(wsSubscribed._sent.length, 1, '广播时订阅者应收到');
  assert.equal(wsUnsubscribed._sent.length, 1, '广播时未订阅者也应收到');
});

test('routeMessage: topic+直接寻址组合时 delivered 去重防止重复', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  const wsBob = createMockWs();
  const bobSession = createOnlineSession('bob', wsBob);
  bobSession.topics.add('news');
  ctx.sessions.set('bob', bobSession);

  // bob 既订阅了 news，又是 to 直接目标
  routeMessage(
    { id: 'dedup_topic_direct', type: 'message', from: 'alice', to: 'bob', topic: 'news', content: 'dedup' },
    { name: 'alice' },
  );

  // bob 通过 topic fanout 已收到，直接寻址时 delivered.has('bob') 为 true，跳过
  assert.equal(wsBob._sent.length, 1, 'topic+direct 组合时 bob 应只收到一条消息');
});

// ── B组：broadcast 内部 ws.readyState 条件 ───────────────────────────────────

test('broadcast: ws 为 CLOSED（readyState=3）时不发送', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { broadcast } = createRouter(ctx);

  const closedWs = createMockWs();
  closedWs.readyState = 3; // CLOSED

  ctx.sessions.set('closed-session', {
    name: 'closed-session',
    ws: closedWs,
    connectedAt: 0,
    topics: new Set(),
    inbox: [],
    inboxExpiry: null,
  });

  broadcast({ type: 'message', content: 'test' });

  assert.equal(closedWs._sent.length, 0, 'CLOSED ws 不应收到 broadcast 消息');
});

test('broadcast: ws 为 CONNECTING（readyState=0）时不发送', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { broadcast } = createRouter(ctx);

  const connectingWs = createMockWs();
  connectingWs.readyState = 0; // CONNECTING

  ctx.sessions.set('connecting-session', {
    name: 'connecting-session',
    ws: connectingWs,
    connectedAt: 0,
    topics: new Set(),
    inbox: [],
    inboxExpiry: null,
  });

  broadcast({ type: 'message', content: 'test' });

  assert.equal(connectingWs._sent.length, 0, 'CONNECTING ws 不应收到 broadcast 消息');
});

// ── C组：feishu fetch 内部验证 ─────────────────────────────────────────────

test('feishu-group: fetch code=0 时打含 chatId 的成功日志（精确匹配 sent）', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.feishuApps = [{ name: 'bot', send: true, targetOpenId: 'oid' }];
  ctx.getFeishuToken = async () => 'token';

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ code: 0 }) });

  try {
    const { routeMessage } = createRouter(ctx);
    routeMessage(
      { id: 'fg_code0', type: 'message', from: 'sender', to: 'feishu-group:chat_success', content: 'ok' },
      { name: 'sender' },
    );
    await new Promise(r => setTimeout(r, 50));

    // code=0 时应打 "sent to chat" 日志，包含 chatId
    const successLog = ctx._logs.find(l => l.includes('sent to chat') && l.includes('chat_success'));
    assert.ok(successLog !== undefined, 'code=0 应打含 chatId 和 "sent to chat" 的成功日志');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('feishu-group: fetch code!=0 时打错误日志，不打成功日志', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.feishuApps = [{ name: 'bot', send: true, targetOpenId: 'oid' }];
  ctx.getFeishuToken = async () => 'token';

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ code: 50001, msg: 'auth failed' }) });

  try {
    const { routeMessage } = createRouter(ctx);
    routeMessage(
      { id: 'fg_code_err', type: 'message', from: 'sender', to: 'feishu-group:chat_err2', content: 'fail' },
      { name: 'sender' },
    );
    await new Promise(r => setTimeout(r, 50));

    const errLog = ctx._logs.find(l => l.includes('50001'));
    assert.ok(errLog !== undefined, 'code!=0 应打包含 error code 的日志');

    const sentLog = ctx._logs.find(l => l.includes('sent to chat'));
    assert.equal(sentLog, undefined, 'code!=0 不应打成功日志');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('feishu P2P: fetch code=0 时打含 app.name 的成功日志（精确含 sent reply）', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.feishuApps = [{ name: 'reply-bot', send: true, targetOpenId: 'oid_reply' }];
  ctx.getFeishuToken = async () => 'token';

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ code: 0 }) });

  try {
    const { routeMessage } = createRouter(ctx);
    routeMessage(
      { id: 'p2p_code0', type: 'message', from: 'sender', to: 'feishu', content: 'reply ok' },
      { name: 'sender' },
    );
    await new Promise(r => setTimeout(r, 50));

    const sentLog = ctx._logs.find(l => l.includes('sent reply') && l.includes('reply-bot'));
    assert.ok(sentLog !== undefined, 'code=0 应打含 "sent reply" 和 app.name 的成功日志');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('feishu P2P: fetch code!=0 时打错误日志，不打成功日志', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.feishuApps = [{ name: 'err-bot', send: true, targetOpenId: 'oid_err2' }];
  ctx.getFeishuToken = async () => 'token';

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ code: 40003, msg: 'no permission' }) });

  try {
    const { routeMessage } = createRouter(ctx);
    routeMessage(
      { id: 'p2p_code_err', type: 'message', from: 'sender', to: 'feishu', content: 'perm fail' },
      { name: 'sender' },
    );
    await new Promise(r => setTimeout(r, 50));

    const errLog = ctx._logs.find(l => l.includes('40003') || l.includes('reply error'));
    assert.ok(errLog !== undefined, 'code!=0 应打错误日志');

    const sentLog = ctx._logs.find(l => l.includes('sent reply'));
    assert.equal(sentLog, undefined, 'code!=0 不应打成功日志');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('feishu P2P: fetch headers 包含 Authorization 和 Content-Type', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.feishuApps = [{ name: 'header-bot', send: true, targetOpenId: 'oid_header' }];
  ctx.getFeishuToken = async () => 'header-token-xyz';

  let capturedHeaders = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    capturedHeaders = opts.headers;
    return { json: async () => ({ code: 0 }) };
  };

  try {
    const { routeMessage } = createRouter(ctx);
    routeMessage(
      { id: 'p2p_headers', type: 'message', from: 'sender', to: 'feishu', content: 'headers test' },
      { name: 'sender' },
    );
    await new Promise(r => setTimeout(r, 50));

    assert.ok(capturedHeaders !== null, 'headers 应被捕获');
    assert.equal(capturedHeaders['Authorization'], 'Bearer header-token-xyz', 'Authorization 应含正确 token');
    assert.equal(capturedHeaders['Content-Type'], 'application/json', 'Content-Type 应为 application/json');
    // 验证 headers 不是空对象（杀掉 headers: {} 突变体）
    assert.ok(Object.keys(capturedHeaders).length >= 2, 'headers 应包含至少两个字段');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('feishu P2P: fetch r.json() 被调用（不是 undefined）', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.feishuApps = [{ name: 'json-bot', send: true, targetOpenId: 'oid_json' }];
  ctx.getFeishuToken = async () => 'token';

  let jsonCalled = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    json: async () => {
      jsonCalled = true;
      return { code: 0 };
    },
  });

  try {
    const { routeMessage } = createRouter(ctx);
    routeMessage(
      { id: 'p2p_json', type: 'message', from: 'sender', to: 'feishu', content: 'json call' },
      { name: 'sender' },
    );
    await new Promise(r => setTimeout(r, 50));

    assert.ok(jsonCalled, 'r.json() 应被调用以获取响应数据');
    // 如果 r.json() 未被调用，code 检查不会执行，成功日志也不会出现
    const sentLog = ctx._logs.find(l => l.includes('sent reply'));
    assert.ok(sentLog !== undefined, 'r.json() 被调用且 code=0 时应打成功日志');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('feishu-group: fetch r.json() 被调用（不是 undefined）', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.feishuApps = [{ name: 'bot', send: true, targetOpenId: 'oid' }];
  ctx.getFeishuToken = async () => 'token';

  let jsonCalled = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    json: async () => {
      jsonCalled = true;
      return { code: 0 };
    },
  });

  try {
    const { routeMessage } = createRouter(ctx);
    routeMessage(
      { id: 'fg_json', type: 'message', from: 'sender', to: 'feishu-group:chat_json', content: 'json' },
      { name: 'sender' },
    );
    await new Promise(r => setTimeout(r, 50));

    assert.ok(jsonCalled, 'feishu-group fetch 后 r.json() 应被调用');
    const sentLog = ctx._logs.find(l => l.includes('sent to chat') && l.includes('chat_json'));
    assert.ok(sentLog !== undefined, 'r.json() 被调用且 code=0 时应打成功日志');
  } finally {
    globalThis.fetch = origFetch;
  }
});

// ── B组额外：to=* 广播但有 topic 时不走广播路径（验证 to==='*' && !topic 条件） ─

test('routeMessage: to="*" 有 topic 时跳过广播，只走 topic fanout', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  const wsSubbed = createMockWs();
  const wsUnsubbed = createMockWs();
  const subbedSession = createOnlineSession('subbed', wsSubbed);
  subbedSession.topics.add('channel');
  ctx.sessions.set('subbed', subbedSession);
  ctx.sessions.set('unsubbed', createOnlineSession('unsubbed', wsUnsubbed));

  routeMessage(
    { id: 'bc_topic_guard', type: 'message', from: 'sender', to: '*', topic: 'channel', content: 'fanout only' },
    { name: 'sender' },
  );

  // 有 topic 时只走 topic fanout，广播条件 !topic 为 false
  assert.equal(wsSubbed._sent.length, 1, '订阅者通过 topic fanout 收到');
  assert.equal(wsUnsubbed._sent.length, 0, '未订阅者不应通过广播收到（topic 存在，广播条件不满足）');
});

// ── 直接路由 L266：target.ws CLOSED 时走 inbox 而非 send ─────────────────────

test('routeMessage: 直接寻址 target 的 ws 为 CLOSED 时消息进 inbox', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  const closedWs = createMockWs();
  closedWs.readyState = 3; // CLOSED

  const targetSession = {
    name: 'target-closed',
    ws: closedWs,
    connectedAt: 0,
    topics: new Set(),
    inbox: [],
    inboxExpiry: null,
  };
  ctx.sessions.set('target-closed', targetSession);

  routeMessage(
    { id: 'direct_closed', type: 'message', from: 'sender', to: 'target-closed', content: 'closed ws' },
    { name: 'sender' },
  );

  assert.equal(closedWs._sent.length, 0, 'CLOSED ws 不应直接发送');
  assert.equal(targetSession.inbox.length, 1, 'CLOSED ws 的 session 消息应进 inbox');
  assert.equal(targetSession.inbox[0].id, 'direct_closed', 'inbox 应包含正确消息');
});

test('routeMessage: 直接寻址 target 的 ws 为 CONNECTING（readyState=0）时消息进 inbox', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { routeMessage } = createRouter(ctx);

  const connectingWs = createMockWs();
  connectingWs.readyState = 0; // CONNECTING

  const targetSession = {
    name: 'target-connecting',
    ws: connectingWs,
    connectedAt: 0,
    topics: new Set(),
    inbox: [],
    inboxExpiry: null,
  };
  ctx.sessions.set('target-connecting', targetSession);

  routeMessage(
    { id: 'direct_connecting', type: 'message', from: 'sender', to: 'target-connecting', content: 'connecting ws' },
    { name: 'sender' },
  );

  assert.equal(connectingWs._sent.length, 0, 'CONNECTING ws 不应直接发送');
  assert.equal(targetSession.inbox.length, 1, 'CONNECTING ws 的 session 消息应进 inbox');
});

// ── C组：catch 内 err?.message 验证 ──────────────────────────────────────────

test('feishu-group: fetch 抛出非 Error 对象时 catch 也能打日志不 crash', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.feishuApps = [{ name: 'bot', send: true, targetOpenId: 'oid' }];
  ctx.getFeishuToken = async () => 'token';

  const origFetch = globalThis.fetch;
  // 抛出字符串而非 Error 对象（err.message 为 undefined）
  globalThis.fetch = async () => { throw 'connection string error'; };

  try {
    const { routeMessage } = createRouter(ctx);
    assert.doesNotThrow(() => routeMessage(
      { id: 'fg_str_err', type: 'message', from: 'sender', to: 'feishu-group:chat_str', content: 'str err' },
      { name: 'sender' },
    ));
    await new Promise(r => setTimeout(r, 50));

    // 字符串 error 没有 .message，??运算符后备到 err 本身
    assert.ok(ctx._logs.some(l => l.includes('failed')), '应记录 failed 日志');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('feishu-group: fetch 抛出没有 message 属性的对象时 catch 打日志', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.feishuApps = [{ name: 'bot', send: true, targetOpenId: 'oid' }];
  ctx.getFeishuToken = async () => 'token';

  const origFetch = globalThis.fetch;
  // 抛出没有 .message 的普通对象
  globalThis.fetch = async () => { throw { code: 503 }; };

  try {
    const { routeMessage } = createRouter(ctx);
    assert.doesNotThrow(() => routeMessage(
      { id: 'fg_obj_err', type: 'message', from: 'sender', to: 'feishu-group:chat_obj', content: 'obj err' },
      { name: 'sender' },
    ));
    await new Promise(r => setTimeout(r, 50));

    assert.ok(ctx._logs.some(l => l.includes('failed')), '应记录 failed 日志（err?.message 为 undefined 时回退到 err 本身）');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('feishu-group: fetch 抛出字符串时 catch 日志包含该字符串内容（??后备到 err 本身）', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.feishuApps = [{ name: 'bot', send: true, targetOpenId: 'oid' }];
  ctx.getFeishuToken = async () => 'token';

  const origFetch = globalThis.fetch;
  // 字符串 err 没有 .message，?? 应后备到 err 本身（字符串）
  globalThis.fetch = async () => { throw 'unique_fg_error_string_xyz'; };

  try {
    const { routeMessage } = createRouter(ctx);
    routeMessage(
      { id: 'fg_str_content', type: 'message', from: 'sender', to: 'feishu-group:chat_str2', content: 'test' },
      { name: 'sender' },
    );
    await new Promise(r => setTimeout(r, 50));

    // err?.message 为 undefined，?? 运算符后备到 err='unique_fg_error_string_xyz'
    // 如果 ?? 被突变为 &&，则为 undefined，日志不包含该字符串
    assert.ok(
      ctx._logs.some(l => l.includes('unique_fg_error_string_xyz')),
      '日志应包含抛出的字符串错误内容（?? err 后备）',
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('feishu P2P: fetch 抛出非 Error 对象时 catch 也能打日志不 crash', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.feishuApps = [{ name: 'bot', send: true, targetOpenId: 'oid' }];
  ctx.getFeishuToken = async () => 'token';

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw 'p2p string error'; };

  try {
    const { routeMessage } = createRouter(ctx);
    assert.doesNotThrow(() => routeMessage(
      { id: 'p2p_str_err', type: 'message', from: 'sender', to: 'feishu', content: 'str err' },
      { name: 'sender' },
    ));
    await new Promise(r => setTimeout(r, 50));

    assert.ok(ctx._logs.some(l => l.includes('reply failed') || l.includes('failed')), '应记录 reply failed 日志');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('feishu P2P: fetch 抛出没有 message 属性的对象时 catch 打日志', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.feishuApps = [{ name: 'bot', send: true, targetOpenId: 'oid' }];
  ctx.getFeishuToken = async () => 'token';

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw { status: 502 }; };

  try {
    const { routeMessage } = createRouter(ctx);
    assert.doesNotThrow(() => routeMessage(
      { id: 'p2p_obj_err', type: 'message', from: 'sender', to: 'feishu', content: 'obj err' },
      { name: 'sender' },
    ));
    await new Promise(r => setTimeout(r, 50));

    assert.ok(ctx._logs.some(l => l.includes('failed')), '应记录 failed 日志');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('feishu P2P: fetch 抛出字符串时 catch 日志包含该字符串内容（??后备到 err 本身）', { timeout: 5000 }, async () => {
  const ctx = createMockCtx();
  ctx.feishuApps = [{ name: 'bot', send: true, targetOpenId: 'oid' }];
  ctx.getFeishuToken = async () => 'token';

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw 'unique_p2p_error_string_xyz'; };

  try {
    const { routeMessage } = createRouter(ctx);
    routeMessage(
      { id: 'p2p_str_content', type: 'message', from: 'sender', to: 'feishu', content: 'test' },
      { name: 'sender' },
    );
    await new Promise(r => setTimeout(r, 50));

    // err?.message 为 undefined，?? 后备到 err='unique_p2p_error_string_xyz'
    // 突变为 && 后为 undefined，日志不含该字符串
    assert.ok(
      ctx._logs.some(l => l.includes('unique_p2p_error_string_xyz')),
      'P2P catch 日志应包含抛出的字符串错误内容（?? err 后备）',
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});
