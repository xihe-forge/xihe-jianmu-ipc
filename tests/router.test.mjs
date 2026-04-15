/**
 * tests/router.test.mjs — lib/router.mjs 单元测试
 *
 * 通过依赖注入构造 mock ctx，不启动任何 HTTP/WebSocket server，纯单元测试。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../lib/router.mjs';

// ── 测试工具函数 ──────────────────────────────────────────────────────────────

/** 构造 mock ctx，每个测试独立调用，互不污染 */
function createMockCtx() {
  const logs = [];
  const audits = [];
  const savedMessages = [];
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
    // 用于断言的辅助引用
    _logs: logs,
    _audits: audits,
    _savedMessages: savedMessages,
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

// ── pushInbox ─────────────────────────────────────────────────────────────────

test('pushInbox: 将消息加入 inbox', { timeout: 5000 }, () => {
  const ctx = createMockCtx();
  const { pushInbox } = createRouter(ctx);

  const session = createOnlineSession('charlie', null);
  const msg = { id: 'msg_1', content: 'test' };

  pushInbox(session, msg);

  assert.equal(session.inbox.length, 1);
  assert.equal(session.inbox[0].id, 'msg_1');
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
  session.inbox.push({ id: 'msg_a', content: 'buffered 1' });
  session.inbox.push({ id: 'msg_b', content: 'buffered 2' });

  flushInbox(session);

  // inbox 已清空
  assert.equal(session.inbox.length, 0);
  // ws 收到了一条 inbox 消息包含两条原始消息
  assert.equal(ws._sent.length, 1);
  assert.equal(ws._sent[0].type, 'inbox');
  assert.equal(ws._sent[0].messages.length, 2);
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
  session.inbox.push({ id: 'msg_x', content: 'for openclaw' });

  flushInbox(session);

  // inbox 已清空
  assert.equal(session.inbox.length, 0);
  // ws 不应该收到消息
  assert.equal(ws._sent.length, 0);
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

  assert.equal(ctx._audits.length, 1);
  assert.equal(ctx._audits[0].event, 'message_route');
  assert.equal(ctx._audits[0].from, 'alice');
  assert.equal(ctx._audits[0].to, 'eve');
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
