import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, existsSync } from 'node:fs';
import { getTempDbPath } from '../helpers/temp-path.mjs';

// 必须在 import db.mjs 之前设好环境变量
const DB_PATH = getTempDbPath('db-integration');
process.env.IPC_DB_PATH = DB_PATH;

const db = await import('../../lib/db.mjs');

// 工具函数：生成唯一消息对象
function makeMsg(id, from = 'alice', to = 'bob') {
  return { id, type: 'message', from, to, content: `content-${id}`, contentType: 'text', topic: null, ts: Date.now() };
}

function makeTask(id, from = 'pm', to = 'dev') {
  return { id, from, to, title: `task-${id}`, description: '', status: 'pending', priority: 3, deadline: null, payload: null, ts: Date.now() };
}

function wait(ms = 5) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── saveMessage + getMessages ─────────────────────────────────────────────────

test('saveMessage + getMessages: 保存后可查询', () => {
  const msg = makeMsg(`msg_save_${Date.now()}`);
  db.saveMessage(msg);
  const rows = db.getMessages({ peer: 'alice', limit: 10 });
  const found = rows.find(r => r.id === msg.id);
  assert.ok(found, '保存的消息应可查询到');
  assert.equal(found.from, 'alice');
});

test('saveMessage: 重复ID不报错', () => {
  const msg = makeMsg(`msg_dup_${Date.now()}`);
  db.saveMessage(msg);
  assert.doesNotThrow(() => db.saveMessage(msg));
});

test('getMessages: from+to 双向查询', () => {
  const ts = Date.now();
  const id1 = `msg_bt1_${ts}`;
  const id2 = `msg_bt2_${ts}`;
  db.saveMessage(makeMsg(id1, 'charlie', 'dave'));
  db.saveMessage(makeMsg(id2, 'dave', 'charlie'));
  const rows = db.getMessages({ from: 'charlie', to: 'dave', limit: 10 });
  const ids = rows.map(r => r.id);
  assert.ok(ids.includes(id1));
  assert.ok(ids.includes(id2));
});

test('getMessages: 无参数返回最近消息', () => {
  const rows = db.getMessages({});
  assert.ok(Array.isArray(rows));
});

// ── saveTask + getTask ────────────────────────────────────────────────────────

test('saveTask + getTask: 保存后可查询', () => {
  const task = makeTask(`task_get_${Date.now()}`);
  db.saveTask(task);
  const found = db.getTask(task.id);
  assert.ok(found, '保存的任务应可查询到');
  assert.equal(found.title, task.title);
  assert.equal(found.status, 'pending');
});

test('getTask: 不存在的ID返回null', () => {
  const result = db.getTask('task_nonexistent_999999');
  assert.equal(result, null);
});

test('saveTask: payload对象自动JSON序列化/反序列化', () => {
  const task = { ...makeTask(`task_payload_${Date.now()}`), payload: { key: 'value', num: 42 } };
  db.saveTask(task);
  const found = db.getTask(task.id);
  assert.deepEqual(found.payload, { key: 'value', num: 42 });
});

// ── updateTaskStatus ──────────────────────────────────────────────────────────

test('updateTaskStatus: pending→started 更新成功', () => {
  const task = makeTask(`task_upd1_${Date.now()}`);
  db.saveTask(task);
  db.updateTaskStatus(task.id, 'started');
  const found = db.getTask(task.id);
  assert.equal(found.status, 'started');
  assert.equal(found.completed_at, null);
});

test('updateTaskStatus: started→completed 自动设置 completed_at', () => {
  const task = makeTask(`task_upd2_${Date.now()}`);
  db.saveTask(task);
  db.updateTaskStatus(task.id, 'started');
  db.updateTaskStatus(task.id, 'completed');
  const found = db.getTask(task.id);
  assert.equal(found.status, 'completed');
  assert.ok(found.completed_at != null, 'completed_at应该被设置');
});

test('updateTaskStatus: failed 也设置 completed_at', () => {
  const task = makeTask(`task_upd3_${Date.now()}`);
  db.saveTask(task);
  db.updateTaskStatus(task.id, 'failed');
  const found = db.getTask(task.id);
  assert.equal(found.status, 'failed');
  assert.ok(found.completed_at != null);
});

// ── listTasks ─────────────────────────────────────────────────────────────────

test('listTasks: 按agent过滤', () => {
  const agentName = `agent_list_${Date.now()}`;
  const task1 = makeTask(`task_la1_${Date.now()}`, 'pm', agentName);
  const task2 = makeTask(`task_la2_${Date.now()}`, 'pm', agentName);
  db.saveTask(task1);
  db.saveTask(task2);
  const rows = db.listTasks({ agent: agentName });
  assert.ok(rows.length >= 2);
  assert.ok(rows.every(r => r.to === agentName));
});

test('listTasks: 按status过滤', () => {
  const ts = Date.now();
  const task = makeTask(`task_ls1_${ts}`, 'pm', `agent_status_${ts}`);
  db.saveTask(task);
  db.updateTaskStatus(task.id, 'cancelled');
  const rows = db.listTasks({ status: 'cancelled' });
  assert.ok(rows.some(r => r.id === task.id));
  assert.ok(rows.every(r => r.status === 'cancelled'));
});

test('listTasks: agent+status 联合过滤', () => {
  const ts = Date.now();
  const agentName = `agent_combo_${ts}`;
  const task = makeTask(`task_combo_${ts}`, 'pm', agentName);
  db.saveTask(task);
  db.updateTaskStatus(task.id, 'started');
  const rows = db.listTasks({ agent: agentName, status: 'started' });
  assert.ok(rows.length >= 1);
  assert.ok(rows.every(r => r.to === agentName && r.status === 'started'));
});

test('listTasks: 无过滤返回所有', () => {
  const rows = db.listTasks({});
  assert.ok(Array.isArray(rows));
});

// ── getTaskStats ──────────────────────────────────────────────────────────────

test('getTaskStats: 返回状态统计数组', () => {
  const stats = db.getTaskStats();
  assert.ok(Array.isArray(stats));
  // 每条记录有 status 和 count
  if (stats.length > 0) {
    assert.ok('status' in stats[0]);
    assert.ok('count' in stats[0]);
  }
});

test('getTaskStats: pending状态有计数', () => {
  const ts = Date.now();
  db.saveTask(makeTask(`task_stats_${ts}`));
  const stats = db.getTaskStats();
  const pendingRow = stats.find(s => s.status === 'pending');
  assert.ok(pendingRow, '应该有pending统计');
  assert.ok(pendingRow.count >= 1);
});

// ── getMessageCount ───────────────────────────────────────────────────────────

test('getMessageCount: 返回数字', () => {
  const count = db.getMessageCount();
  assert.ok(typeof count === 'number');
  assert.ok(count >= 0);
});

test('getMessageCount: 保存消息后数量增加', () => {
  const before = db.getMessageCount();
  db.saveMessage(makeMsg(`msg_count_${Date.now()}_a`));
  db.saveMessage(makeMsg(`msg_count_${Date.now()}_b`));
  const after = db.getMessageCount();
  assert.ok(after >= before + 2);
});

// ── getMessageCountByAgent ────────────────────────────────────────────────────

test('getMessageCountByAgent: 返回数组', () => {
  const result = db.getMessageCountByAgent(24 * 60 * 60 * 1000);
  assert.ok(Array.isArray(result));
});

test('getMessageCountByAgent: 结果包含 name 和 count 字段', () => {
  // 先保存一条消息确保有数据
  db.saveMessage(makeMsg(`msg_byagent_${Date.now()}`, 'xihe', 'system'));
  const result = db.getMessageCountByAgent(24 * 60 * 60 * 1000);
  if (result.length > 0) {
    assert.ok('name' in result[0]);
    assert.ok('count' in result[0]);
  }
});

// ── inbox 持久化 ──────────────────────────────────────────────────────────────

test('saveInboxMessage + getInboxMessages: 保存后按 ts 升序返回并自动反序列化', () => {
  const sessionName = `session_inbox_${Date.now()}`;
  const msg1 = { id: `inbox_1_${Date.now()}`, content: 'first', ts: Date.now() - 10 };
  const msg2 = { id: `inbox_2_${Date.now()}`, content: 'second', ts: Date.now() };

  db.saveInboxMessage(sessionName, msg2);
  db.saveInboxMessage(sessionName, msg1);

  const rows = db.getInboxMessages(sessionName);
  assert.deepEqual(rows.map(r => r.id), [msg1.id, msg2.id]);
  assert.equal(rows[0].content, 'first');
  assert.equal(rows[1].content, 'second');
});

test('clearInbox: 指定 session 的 inbox 消息会被清空', () => {
  const sessionName = `session_clear_${Date.now()}`;
  db.saveInboxMessage(sessionName, { id: `clear_1_${Date.now()}`, content: 'to clear', ts: Date.now() });

  db.clearInbox(sessionName);

  assert.deepEqual(db.getInboxMessages(sessionName), []);
});

test('clearExpiredInbox: 超过 TTL 的 inbox 消息会被删除', () => {
  const sessionName = `session_expired_${Date.now()}`;
  const oldMsg = { id: `expired_${Date.now()}`, content: 'old inbox', ts: Date.now() - 10 * 24 * 60 * 60 * 1000 };

  db.saveInboxMessage(sessionName, oldMsg);
  db.clearExpiredInbox(1);

  assert.deepEqual(db.getInboxMessages(sessionName), []);
});

// ── suspended_sessions ────────────────────────────────────────────────────────

test('listSuspendedSessions: 空表返回 []', () => {
  db.clearSuspendedSessions();
  assert.deepEqual(db.listSuspendedSessions(), []);
});

test('suspendSession + listSuspendedSessions: 可插入并按 suspended_at 升序返回', async () => {
  db.clearSuspendedSessions();

  const first = db.suspendSession({
    name: `suspend_first_${Date.now()}`,
    reason: 'network down',
    task_description: 'resume task A',
    suspended_by: 'self',
  });
  await wait();
  const second = db.suspendSession({
    name: `suspend_second_${Date.now()}`,
    reason: 'dns failure',
    task_description: 'resume task B',
    suspended_by: 'watchdog',
  });

  const rows = db.listSuspendedSessions();

  assert.deepEqual(rows.map(row => row.name), [first.name, second.name]);
  assert.equal(rows[0].reason, 'network down');
  assert.equal(rows[0].task_description, 'resume task A');
  assert.equal(rows[0].suspended_by, 'self');
  assert.equal(rows[1].reason, 'dns failure');
  assert.equal(rows[1].task_description, 'resume task B');
  assert.equal(rows[1].suspended_by, 'watchdog');
});

test('suspendSession: 同 name 重复 suspend 走 ON CONFLICT UPDATE 且字段覆盖', async () => {
  db.clearSuspendedSessions();

  const name = `suspend_update_${Date.now()}`;
  const initial = db.suspendSession({
    name,
    reason: 'old reason',
    task_description: 'old task',
    suspended_by: 'self',
  });
  await wait();
  const updated = db.suspendSession({
    name,
    reason: 'new reason',
    task_description: 'new task',
    suspended_by: 'harness',
  });

  const rows = db.listSuspendedSessions();

  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, name);
  assert.equal(rows[0].reason, 'new reason');
  assert.equal(rows[0].task_description, 'new task');
  assert.equal(rows[0].suspended_by, 'harness');
  assert.ok(rows[0].suspended_at >= initial.suspended_at);
  assert.equal(rows[0].suspended_at, updated.suspended_at);
});

test('clearSuspendedSessions: 返回被删除的 name 数组', async () => {
  db.clearSuspendedSessions();

  const first = db.suspendSession({
    name: `suspend_clear_first_${Date.now()}`,
    reason: 'r1',
    task_description: 't1',
    suspended_by: 'self',
  });
  await wait();
  const second = db.suspendSession({
    name: `suspend_clear_second_${Date.now()}`,
    reason: 'r2',
    task_description: 't2',
    suspended_by: 'watchdog',
  });

  const cleared = db.clearSuspendedSessions();

  assert.deepEqual(cleared, [first.name, second.name]);
  assert.deepEqual(db.listSuspendedSessions(), []);
});

// ── cleanup ───────────────────────────────────────────────────────────────────

test('cleanup: 超期数据被删除', () => {
  // 保存一条时间戳很老的消息
  const oldMsg = {
    id: `msg_old_${Date.now()}`,
    type: 'message',
    from: 'old-agent',
    to: 'hub',
    content: 'old message',
    contentType: 'text',
    topic: null,
    ts: Date.now() - 10 * 24 * 60 * 60 * 1000, // 10天前
  };
  db.saveMessage(oldMsg);

  // 用1ms的TTL清理（清除几乎所有消息）
  db.cleanup(1);

  const found = db.getMessages({ peer: 'old-agent', limit: 100 });
  const stillThere = found.find(r => r.id === oldMsg.id);
  assert.equal(stillThere, undefined, '超期消息应被删除');
});

test('cleanup: 返回 changes 对象', () => {
  const result = db.cleanup(7 * 24 * 60 * 60 * 1000);
  assert.ok(result != null);
});

// 清理临时数据库文件
process.on('exit', () => {
  try {
    db.close();
    if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
    // WAL模式可能产生额外文件
    [DB_PATH + '-wal', DB_PATH + '-shm'].forEach(f => {
      if (existsSync(f)) unlinkSync(f);
    });
  } catch {}
});
