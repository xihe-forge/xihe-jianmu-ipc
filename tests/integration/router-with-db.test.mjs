import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB_PATH = join(
  tmpdir(),
  `ipc-router-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.db`,
);
process.env.IPC_DB_PATH = DB_PATH;

const db = await import('../../lib/db.mjs');
const { createRouter } = await import('../../lib/router.mjs');
const { INBOX_MAX_SIZE } = await import('../../lib/constants.mjs');

const TEST_TIMEOUT = 10_000;
let seq = 0;

function unique(prefix = 'id') {
  seq += 1;
  return `${prefix}-${process.pid}-${Date.now()}-${seq}`;
}

function createMockWs(readyState = 1) {
  const sent = [];
  return {
    readyState,
    OPEN: 1,
    send: (data) => sent.push(JSON.parse(data)),
    _sent: sent,
  };
}

function createSession(name, options = {}) {
  return {
    name,
    ws: Object.hasOwn(options, 'ws') ? options.ws : createMockWs(),
    connectedAt: Date.now(),
    topics: new Set(options.topics ?? []),
    inbox: [...(options.inbox ?? [])],
    inboxExpiry: null,
  };
}

function createRealCtx(overrides = {}) {
  const logs = [];
  const audits = [];
  const openClawDeliveries = [];
  const openClawRetries = [];

  return {
    sessions: new Map(),
    deliveredMessageIds: new Map(),
    ackPending: new Map(),
    feishuApps: [],
    getFeishuToken: async () => null,
    isOpenClawSession: (name) => name.startsWith('openclaw'),
    deliverToOpenClaw: async (msg) => {
      openClawDeliveries.push(msg);
      return true;
    },
    enqueueOpenClawRetry: (msg) => openClawRetries.push(msg),
    stderr: (msg) => logs.push(msg),
    audit: (event, detail) => audits.push({ event, ...detail }),
    saveMessage: db.saveMessage,
    saveInboxMessage: db.saveInboxMessage,
    getInboxMessages: db.getInboxMessages,
    clearInbox: db.clearInbox,
    _logs: logs,
    _audits: audits,
    _openClawDeliveries: openClawDeliveries,
    _openClawRetries: openClawRetries,
    ...overrides,
  };
}

function makeMessage(overrides = {}) {
  return {
    id: unique('msg'),
    type: 'message',
    from: unique('sender'),
    to: unique('receiver'),
    content: unique('content'),
    contentType: 'text',
    topic: null,
    ts: Date.now(),
    ...overrides,
  };
}

function makeTask(overrides = {}) {
  const ts = Date.now();
  return {
    id: unique('task'),
    from: unique('pm'),
    to: unique('agent'),
    title: unique('title'),
    description: unique('desc'),
    status: 'pending',
    priority: 3,
    deadline: null,
    payload: { marker: unique('payload') },
    ts,
    ...overrides,
  };
}

function getTaskStatusCount(status) {
  return db.getTaskStats().find((row) => row.status === status)?.count ?? 0;
}

after(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${DB_PATH}${suffix}`;
    if (existsSync(file)) {
      rmSync(file, { force: true });
    }
  }
});

test('routeMessage: 直接消息写入 SQLite messages，可通过 getMessages 查询', { timeout: TEST_TIMEOUT }, () => {
  const ctx = createRealCtx();
  const { routeMessage } = createRouter(ctx);
  const receiver = createSession(unique('receiver'));
  ctx.sessions.set(receiver.name, receiver);

  const msg = makeMessage({ from: unique('alice'), to: receiver.name, content: 'persist-direct' });

  routeMessage(msg, { name: msg.from });

  const rows = db.getMessages({ from: msg.from, to: receiver.name, limit: 10 });
  const saved = rows.find((row) => row.id === msg.id);
  assert.ok(saved);
  assert.equal(saved.content, 'persist-direct');
  assert.equal(receiver.ws._sent.length, 1);
});

test('routeMessage: topic fanout 向所有订阅 session 投递，SQLite 仅记录一条', { timeout: TEST_TIMEOUT }, () => {
  const ctx = createRealCtx();
  const { routeMessage } = createRouter(ctx);
  const topic = unique('topic');
  const a = createSession(unique('topic-a'), { topics: [topic] });
  const b = createSession(unique('topic-b'), { topics: [topic] });
  const c = createSession(unique('topic-c'), { topics: [unique('other-topic')] });
  ctx.sessions.set(a.name, a);
  ctx.sessions.set(b.name, b);
  ctx.sessions.set(c.name, c);

  const msg = makeMessage({ from: unique('sender'), to: '*', topic, content: 'topic-hit' });

  routeMessage(msg, { name: msg.from });

  assert.equal(a.ws._sent.length, 1);
  assert.equal(b.ws._sent.length, 1);
  assert.equal(c.ws._sent.length, 0);
  assert.equal(db.getMessages({ peer: msg.from, limit: 20 }).filter((row) => row.id === msg.id).length, 1);
});

test('routeMessage: 广播 to="*" 后所有 session 收到，SQLite 只记一次', { timeout: TEST_TIMEOUT }, () => {
  const ctx = createRealCtx();
  const { routeMessage } = createRouter(ctx);
  const a = createSession(unique('broadcast-a'));
  const b = createSession(unique('broadcast-b'));
  ctx.sessions.set(a.name, a);
  ctx.sessions.set(b.name, b);

  const sender = unique('sender');
  const msg = makeMessage({ from: sender, to: '*', content: 'broadcast-all' });

  routeMessage(msg, { name: sender });

  assert.equal(a.ws._sent.length, 1);
  assert.equal(b.ws._sent.length, 1);
  assert.equal(db.getMessages({ peer: sender, limit: 20 }).filter((row) => row.id === msg.id).length, 1);
});

test('pushInbox: 离线消息写入 SQLite inbox，getInboxMessages 可查出', { timeout: TEST_TIMEOUT }, () => {
  const ctx = createRealCtx();
  const { pushInbox } = createRouter(ctx);
  const session = createSession(unique('offline'), { ws: null });
  const msg = makeMessage({ to: session.name, content: 'offline-buffered' });

  pushInbox(session, msg);

  assert.equal(session.inbox.length, 1);
  assert.deepEqual(db.getInboxMessages(session.name).map((row) => row.id), [msg.id]);
});

test('pushInbox: 超过 INBOX_MAX_SIZE 时仅淘汰内存最旧消息，SQLite 仍保留全部记录', { timeout: TEST_TIMEOUT }, () => {
  const ctx = createRealCtx();
  const { pushInbox } = createRouter(ctx);
  const session = createSession(unique('bounded'), { ws: null });

  for (let i = 0; i <= INBOX_MAX_SIZE; i += 1) {
    pushInbox(session, makeMessage({ id: `${session.name}-msg-${i}`, to: session.name, ts: i + 1 }));
  }

  const persisted = db.getInboxMessages(session.name);
  assert.equal(session.inbox.length, INBOX_MAX_SIZE);
  assert.equal(session.inbox[0].id, `${session.name}-msg-1`);
  assert.equal(persisted.length, INBOX_MAX_SIZE + 1);
  assert.equal(persisted[0].id, `${session.name}-msg-0`);
});

test('flushInbox: 合并内存与 SQLite inbox 后发送，并清空 SQLite inbox', { timeout: TEST_TIMEOUT }, () => {
  const ctx = createRealCtx();
  const { flushInbox } = createRouter(ctx);
  const session = createSession(unique('flush-merge'));
  const persisted = makeMessage({ id: unique('persisted'), to: session.name, ts: 10 });
  const memory = makeMessage({ id: unique('memory'), to: session.name, ts: 20 });

  db.saveInboxMessage(session.name, persisted);
  session.inbox.push(memory);

  flushInbox(session);

  assert.equal(session.ws._sent.length, 1);
  assert.deepEqual(session.ws._sent[0].messages.map((row) => row.id), [persisted.id, memory.id]);
  assert.deepEqual(db.getInboxMessages(session.name), []);
});

test('Hub 重启后 flushInbox 可从 SQLite 恢复之前 pushInbox 的离线消息', { timeout: TEST_TIMEOUT }, () => {
  const sessionName = unique('restart-agent');
  const msg = makeMessage({ to: sessionName, ts: 100 });

  const ctx1 = createRealCtx();
  const router1 = createRouter(ctx1);
  router1.pushInbox(createSession(sessionName, { ws: null }), msg);

  const ctx2 = createRealCtx();
  const router2 = createRouter(ctx2);
  const reconnected = createSession(sessionName);
  ctx2.sessions.set(sessionName, reconnected);

  router2.flushInbox(reconnected);

  assert.equal(reconnected.ws._sent.length, 1);
  assert.deepEqual(reconnected.ws._sent[0].messages.map((row) => row.id), [msg.id]);
  assert.deepEqual(db.getInboxMessages(sessionName), []);
});

test('routeMessage: 同一 msg.id 重复路由时 saveMessage 只写一次', { timeout: TEST_TIMEOUT }, () => {
  const ctx = createRealCtx();
  const { routeMessage } = createRouter(ctx);
  const receiver = createSession(unique('dup-receiver'));
  ctx.sessions.set(receiver.name, receiver);

  const msg = makeMessage({ from: unique('dup-sender'), to: receiver.name, content: 'dup-once' });

  routeMessage(msg, { name: msg.from });
  routeMessage(msg, { name: msg.from });

  assert.equal(receiver.ws._sent.length, 1);
  assert.equal(db.getMessages({ from: msg.from, to: receiver.name, limit: 20 }).filter((row) => row.id === msg.id).length, 1);
});

test('pushInbox: 并发写入不同 session 时，SQLite inbox 正确隔离', { timeout: TEST_TIMEOUT }, async () => {
  const ctx = createRealCtx();
  const { pushInbox } = createRouter(ctx);
  const left = createSession(unique('left'), { ws: null });
  const right = createSession(unique('right'), { ws: null });
  const leftMsg = makeMessage({ to: left.name });
  const rightMsg = makeMessage({ to: right.name });

  await Promise.all([
    Promise.resolve().then(() => pushInbox(left, leftMsg)),
    Promise.resolve().then(() => pushInbox(right, rightMsg)),
  ]);

  assert.deepEqual(db.getInboxMessages(left.name).map((row) => row.id), [leftMsg.id]);
  assert.deepEqual(db.getInboxMessages(right.name).map((row) => row.id), [rightMsg.id]);
});

test('clearInbox: 删除指定 session 的所有 inbox 消息', { timeout: TEST_TIMEOUT }, () => {
  const sessionName = unique('clear-inbox');
  db.saveInboxMessage(sessionName, makeMessage({ to: sessionName, ts: 1 }));
  db.saveInboxMessage(sessionName, makeMessage({ to: sessionName, ts: 2 }));

  db.clearInbox(sessionName);

  assert.deepEqual(db.getInboxMessages(sessionName), []);
});

test('clearExpiredInbox: 只删除过期消息，保留未过期消息', { timeout: TEST_TIMEOUT }, () => {
  const expiredSession = unique('expired');
  const freshSession = unique('fresh');
  const oldMsg = makeMessage({ to: expiredSession, ts: Date.now() - 10_000 });
  const freshMsg = makeMessage({ to: freshSession, ts: Date.now() });

  db.saveInboxMessage(expiredSession, oldMsg);
  db.saveInboxMessage(freshSession, freshMsg);
  db.clearExpiredInbox(1_000);

  assert.deepEqual(db.getInboxMessages(expiredSession), []);
  assert.deepEqual(db.getInboxMessages(freshSession).map((row) => row.id), [freshMsg.id]);
});

test('routeMessage: 给离线 session 发消息时，messages 表与 inbox 表都落库', { timeout: TEST_TIMEOUT }, () => {
  const ctx = createRealCtx();
  const { routeMessage } = createRouter(ctx);
  const receiver = createSession(unique('offline-target'), { ws: null });
  ctx.sessions.set(receiver.name, receiver);

  const msg = makeMessage({ from: unique('sender'), to: receiver.name, content: 'offline-chain' });

  routeMessage(msg, { name: msg.from });

  assert.equal(db.getMessages({ from: msg.from, to: receiver.name, limit: 10 }).filter((row) => row.id === msg.id).length, 1);
  assert.deepEqual(db.getInboxMessages(receiver.name).map((row) => row.id), [msg.id]);
  assert.equal(receiver.inbox.length, 1);
});

test('routeMessage: 广播时跳过 openclaw session', { timeout: TEST_TIMEOUT }, () => {
  const ctx = createRealCtx();
  const { routeMessage } = createRouter(ctx);
  const normal = createSession(unique('normal'));
  const openclaw = createSession(`openclaw-${unique('worker')}`, { ws: null });
  ctx.sessions.set(normal.name, normal);
  ctx.sessions.set(openclaw.name, openclaw);

  const sender = unique('sender');
  routeMessage(makeMessage({ from: sender, to: '*', content: 'skip-openclaw' }), { name: sender });

  assert.equal(normal.ws._sent.length, 1);
  assert.equal(openclaw.inbox.length, 0);
  assert.deepEqual(db.getInboxMessages(openclaw.name), []);
});

test('routeMessage: topic fanout 时跳过 openclaw session', { timeout: TEST_TIMEOUT }, () => {
  const ctx = createRealCtx();
  const { routeMessage } = createRouter(ctx);
  const topic = unique('topic');
  const normal = createSession(unique('topic-normal'), { topics: [topic] });
  const openclaw = createSession(`openclaw-${unique('topic-worker')}`, { ws: null, topics: [topic] });
  ctx.sessions.set(normal.name, normal);
  ctx.sessions.set(openclaw.name, openclaw);

  const sender = unique('sender');
  routeMessage(makeMessage({ from: sender, to: '*', topic, content: 'topic-skip-openclaw' }), { name: sender });

  assert.equal(normal.ws._sent.length, 1);
  assert.equal(openclaw.inbox.length, 0);
  assert.deepEqual(db.getInboxMessages(openclaw.name), []);
});

test('routeMessage: 广播时 ws 非 OPEN 的 session 消息进入 inbox', { timeout: TEST_TIMEOUT }, () => {
  const ctx = createRealCtx();
  const { routeMessage } = createRouter(ctx);
  const closed = createSession(unique('closed-broadcast'), { ws: createMockWs(3) });
  ctx.sessions.set(closed.name, closed);

  const sender = unique('sender');
  const msg = makeMessage({ from: sender, to: '*', content: 'broadcast-to-inbox' });

  routeMessage(msg, { name: sender });

  assert.equal(closed.inbox.length, 1);
  assert.deepEqual(db.getInboxMessages(closed.name).map((row) => row.id), [msg.id]);
});

test('routeMessage: topic fanout 时 ws 非 OPEN 的 session 消息进入 inbox', { timeout: TEST_TIMEOUT }, () => {
  const ctx = createRealCtx();
  const { routeMessage } = createRouter(ctx);
  const topic = unique('topic');
  const closed = createSession(unique('closed-topic'), { ws: createMockWs(0), topics: [topic] });
  ctx.sessions.set(closed.name, closed);

  const sender = unique('sender');
  const msg = makeMessage({ from: sender, to: '*', topic, content: 'topic-to-inbox' });

  routeMessage(msg, { name: sender });

  assert.equal(closed.inbox.length, 1);
  assert.deepEqual(db.getInboxMessages(closed.name).map((row) => row.id), [msg.id]);
});

test('routeMessage: 未知 to 创建 stub session，并持久化到 SQLite inbox', { timeout: TEST_TIMEOUT }, () => {
  const ctx = createRealCtx();
  const { routeMessage } = createRouter(ctx);
  const target = unique('stub-target');
  const msg = makeMessage({ from: unique('sender'), to: target, content: 'stub-persisted' });

  routeMessage(msg, { name: msg.from });

  const stub = ctx.sessions.get(target);
  assert.ok(stub);
  assert.equal(stub.inbox.length, 1);
  assert.deepEqual(db.getInboxMessages(target).map((row) => row.id), [msg.id]);
});

test('flushInbox: 执行后清空内存 inbox 和 SQLite inbox', { timeout: TEST_TIMEOUT }, () => {
  const ctx = createRealCtx();
  const { pushInbox, flushInbox } = createRouter(ctx);
  const session = createSession(unique('flush-clear'), { ws: null });
  const msg = makeMessage({ to: session.name, content: 'to-be-flushed' });

  pushInbox(session, msg);
  session.ws = createMockWs();
  flushInbox(session);

  assert.equal(session.inbox.length, 0);
  assert.deepEqual(db.getInboxMessages(session.name), []);
  assert.equal(session.ws._sent.length, 1);
});

test('saveTask + getTask + updateTaskStatus: 完整流程可持久化状态变更', { timeout: TEST_TIMEOUT }, () => {
  const task = makeTask();

  db.saveTask(task);
  db.updateTaskStatus(task.id, 'started');
  db.updateTaskStatus(task.id, 'completed');

  const found = db.getTask(task.id);
  assert.ok(found);
  assert.equal(found.status, 'completed');
  assert.ok(found.completed_at != null);
  assert.deepEqual(found.payload, task.payload);
});

test('listTasks: 按 agent 过滤', { timeout: TEST_TIMEOUT }, () => {
  const agent = unique('agent-filter');
  const ownTask = makeTask({ to: agent });
  const otherTask = makeTask({ to: unique('other-agent') });

  db.saveTask(ownTask);
  db.saveTask(otherTask);

  const rows = db.listTasks({ agent, limit: 20 });
  assert.ok(rows.some((row) => row.id === ownTask.id));
  assert.ok(rows.every((row) => row.to === agent));
});

test('listTasks: 按 status 过滤', { timeout: TEST_TIMEOUT }, () => {
  const cancelled = makeTask();
  const pending = makeTask();
  db.saveTask(cancelled);
  db.saveTask(pending);
  db.updateTaskStatus(cancelled.id, 'cancelled');

  const rows = db.listTasks({ status: 'cancelled', limit: 20 });
  assert.ok(rows.some((row) => row.id === cancelled.id));
  assert.ok(rows.every((row) => row.status === 'cancelled'));
});

test('getTaskStats: 返回状态统计并反映新增任务', { timeout: TEST_TIMEOUT }, () => {
  const before = getTaskStatusCount('pending');
  db.saveTask(makeTask({ status: 'pending' }));

  const after = getTaskStatusCount('pending');
  assert.equal(after, before + 1);
});

test('cleanup: 删除 cutoff 之前的旧消息', { timeout: TEST_TIMEOUT }, () => {
  const from = unique('cleanup-from');
  const to = unique('cleanup-to');
  const oldMsg = makeMessage({ id: unique('old-msg'), from, to, ts: Date.now() - 10_000 });
  const freshMsg = makeMessage({ id: unique('fresh-msg'), from, to, ts: Date.now() });

  db.saveMessage(oldMsg);
  db.saveMessage(freshMsg);
  db.cleanup(1_000);

  const ids = db.getMessages({ from, to, limit: 10 }).map((row) => row.id);
  assert.ok(ids.includes(freshMsg.id));
  assert.ok(!ids.includes(oldMsg.id));
});

test('getMessageCount: 返回正确的消息数量增量', { timeout: TEST_TIMEOUT }, () => {
  const before = db.getMessageCount();
  db.saveMessage(makeMessage({ from: unique('count-from'), to: unique('count-to') }));
  db.saveMessage(makeMessage({ from: unique('count-from'), to: unique('count-to') }));

  assert.equal(db.getMessageCount(), before + 2);
});

test('getMessageCountByAgent: 按发送者聚合消息数', { timeout: TEST_TIMEOUT }, () => {
  const agent = unique('stats-agent');
  db.saveMessage(makeMessage({ from: agent, to: unique('peer-a') }));
  db.saveMessage(makeMessage({ from: agent, to: unique('peer-b') }));

  const counts = db.getMessageCountByAgent(60 * 60 * 1000);
  const row = counts.find((item) => item.name === agent);
  assert.ok(row);
  assert.equal(row.count, 2);
});

test('routeMessage: type="message" 时调用 saveMessage', { timeout: TEST_TIMEOUT }, () => {
  const saved = [];
  const ctx = createRealCtx({
    saveMessage: (msg) => {
      saved.push(msg.id);
      db.saveMessage(msg);
    },
  });
  const { routeMessage } = createRouter(ctx);
  const receiver = createSession(unique('save-msg-target'));
  ctx.sessions.set(receiver.name, receiver);
  const msg = makeMessage({ from: unique('sender'), to: receiver.name });

  routeMessage(msg, { name: msg.from });

  assert.deepEqual(saved, [msg.id]);
  assert.equal(db.getMessages({ from: msg.from, to: receiver.name, limit: 10 }).filter((row) => row.id === msg.id).length, 1);
});

test('routeMessage: type="system" 时不调用 saveMessage', { timeout: TEST_TIMEOUT }, () => {
  const saved = [];
  const sender = unique('system-sender');
  const receiverName = unique('system-target');
  const ctx = createRealCtx({
    saveMessage: (msg) => {
      saved.push(msg.id);
      db.saveMessage(msg);
    },
  });
  const { routeMessage } = createRouter(ctx);
  const receiver = createSession(receiverName);
  ctx.sessions.set(receiver.name, receiver);
  const msg = makeMessage({ type: 'system', from: sender, to: receiverName, content: 'system-only' });

  routeMessage(msg, { name: sender });

  assert.deepEqual(saved, []);
  assert.equal(db.getMessages({ from: sender, to: receiverName, limit: 10 }).filter((row) => row.id === msg.id).length, 0);
  assert.equal(receiver.ws._sent.length, 1);
});

test('routeMessage: ackPending 记录待确认消息', { timeout: TEST_TIMEOUT }, () => {
  const ctx = createRealCtx();
  const { routeMessage } = createRouter(ctx);
  const receiver = createSession(unique('ack-target'));
  ctx.sessions.set(receiver.name, receiver);
  const sender = unique('ack-sender');
  const msg = makeMessage({ from: sender, to: receiver.name });

  routeMessage(msg, { name: sender });

  const pending = ctx.ackPending.get(msg.id);
  assert.ok(pending);
  assert.equal(pending.sender, sender);
  assert.equal(typeof pending.ts, 'number');
});

test('routeMessage: deliveredMessageIds 去重生效', { timeout: TEST_TIMEOUT }, () => {
  const ctx = createRealCtx();
  const { routeMessage } = createRouter(ctx);
  const receiver = createSession(unique('delivered-target'));
  ctx.sessions.set(receiver.name, receiver);
  const sender = unique('delivered-sender');
  const msg = makeMessage({ from: sender, to: receiver.name });

  routeMessage(msg, { name: sender });
  routeMessage(msg, { name: sender });

  assert.ok(ctx.deliveredMessageIds.has(msg.id));
  assert.equal(ctx.deliveredMessageIds.size, 1);
  assert.equal(receiver.ws._sent.length, 1);
});

test('flushInbox: 离线 session 重连后按 ts 升序发送消息', { timeout: TEST_TIMEOUT }, () => {
  const ctx = createRealCtx();
  const { flushInbox } = createRouter(ctx);
  const session = createSession(unique('ordered-flush'));
  const laterPersisted = makeMessage({ id: unique('persist-late'), to: session.name, ts: 300 });
  const earliestMemory = makeMessage({ id: unique('memory-early'), to: session.name, ts: 100 });
  const middlePersisted = makeMessage({ id: unique('persist-mid'), to: session.name, ts: 200 });

  db.saveInboxMessage(session.name, laterPersisted);
  db.saveInboxMessage(session.name, middlePersisted);
  session.inbox.push(earliestMemory);

  flushInbox(session);

  assert.equal(session.ws._sent.length, 1);
  assert.deepEqual(
    session.ws._sent[0].messages.map((row) => row.id),
    [earliestMemory.id, middlePersisted.id, laterPersisted.id],
  );
});
