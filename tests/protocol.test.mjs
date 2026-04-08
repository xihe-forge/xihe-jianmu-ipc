import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createId,
  createMessage,
  createTask,
  TASK_STATUSES,
  validateMessage,
} from '../lib/protocol.mjs';

// ── createId ─────────────────────────────────────────────────────────────────

test('createId: 包含正确前缀', () => {
  const id = createId('msg');
  assert.ok(id.startsWith('msg_'));
});

test('createId: 格式为 prefix_timestamp_hex', () => {
  const id = createId('task');
  const parts = id.split('_');
  assert.equal(parts.length, 3);
  assert.equal(parts[0], 'task');
  assert.match(parts[1], /^\d+$/);
  assert.match(parts[2], /^[0-9a-f]{6}$/);
});

test('createId: 每次生成唯一ID', () => {
  const ids = new Set(Array.from({ length: 100 }, () => createId('x')));
  assert.equal(ids.size, 100);
});

// ── createMessage ─────────────────────────────────────────────────────────────

test('createMessage: 字段完整', () => {
  const msg = createMessage({ from: 'alice', to: 'bob', content: 'hello' });
  assert.ok(msg.id.startsWith('msg_'));
  assert.equal(msg.type, 'message');
  assert.equal(msg.from, 'alice');
  assert.equal(msg.to, 'bob');
  assert.equal(msg.content, 'hello');
  assert.equal(msg.contentType, 'text');
  assert.equal(msg.topic, null);
  assert.ok(typeof msg.ts === 'number');
});

test('createMessage: 支持自定义 topic 和 contentType', () => {
  const msg = createMessage({ from: 'a', to: 'b', content: 'x', topic: 'news', contentType: 'markdown' });
  assert.equal(msg.topic, 'news');
  assert.equal(msg.contentType, 'markdown');
});

// ── createTask ────────────────────────────────────────────────────────────────

test('createTask: 字段完整，默认 status=pending、priority=3', () => {
  const task = createTask({ from: 'pm', to: 'dev', title: '修Bug' });
  assert.ok(task.id.startsWith('task_'));
  assert.equal(task.type, 'task');
  assert.equal(task.from, 'pm');
  assert.equal(task.to, 'dev');
  assert.equal(task.title, '修Bug');
  assert.equal(task.status, 'pending');
  assert.equal(task.priority, 3);
  assert.equal(task.description, '');
  assert.equal(task.deadline, null);
  assert.equal(task.payload, null);
  assert.ok(typeof task.ts === 'number');
});

test('createTask: 支持自定义 priority 和 description', () => {
  const task = createTask({ from: 'a', to: 'b', title: 't', description: 'desc', priority: 1 });
  assert.equal(task.priority, 1);
  assert.equal(task.description, 'desc');
});

// ── TASK_STATUSES ─────────────────────────────────────────────────────────────

test('TASK_STATUSES: 包含5个状态', () => {
  assert.equal(TASK_STATUSES.length, 5);
  assert.ok(TASK_STATUSES.includes('pending'));
  assert.ok(TASK_STATUSES.includes('started'));
  assert.ok(TASK_STATUSES.includes('completed'));
  assert.ok(TASK_STATUSES.includes('failed'));
  assert.ok(TASK_STATUSES.includes('cancelled'));
});

// ── validateMessage ───────────────────────────────────────────────────────────

test('validateMessage: 非对象返回 invalid', () => {
  assert.equal(validateMessage(null).valid, false);
  assert.equal(validateMessage('string').valid, false);
  assert.equal(validateMessage(42).valid, false);
});

test('validateMessage: 缺少 type 返回 invalid', () => {
  const r = validateMessage({});
  assert.equal(r.valid, false);
  assert.match(r.error, /type/);
});

test('validateMessage: message类型 — 缺 from 报错', () => {
  const r = validateMessage({ type: 'message', to: 'b', content: 'hi' });
  assert.equal(r.valid, false);
  assert.match(r.error, /from/);
});

test('validateMessage: message类型 — 缺 to 报错', () => {
  const r = validateMessage({ type: 'message', from: 'a', content: 'hi' });
  assert.equal(r.valid, false);
  assert.match(r.error, /to/);
});

test('validateMessage: message类型 — 缺 content 报错', () => {
  const r = validateMessage({ type: 'message', from: 'a', to: 'b' });
  assert.equal(r.valid, false);
  assert.match(r.error, /content/);
});

test('validateMessage: message类型 — 字段完整时通过', () => {
  const r = validateMessage({ type: 'message', from: 'a', to: 'b', content: 'hello' });
  assert.equal(r.valid, true);
});

test('validateMessage: task类型 — 缺 from 报错', () => {
  const r = validateMessage({ type: 'task', to: 'b', title: 't' });
  assert.equal(r.valid, false);
  assert.match(r.error, /from/);
});

test('validateMessage: task类型 — 缺 to 报错', () => {
  const r = validateMessage({ type: 'task', from: 'a', title: 't' });
  assert.equal(r.valid, false);
  assert.match(r.error, /to/);
});

test('validateMessage: task类型 — 缺 title 报错', () => {
  const r = validateMessage({ type: 'task', from: 'a', to: 'b' });
  assert.equal(r.valid, false);
  assert.match(r.error, /title/);
});

test('validateMessage: task类型 — 字段完整时通过', () => {
  const r = validateMessage({ type: 'task', from: 'a', to: 'b', title: 't' });
  assert.equal(r.valid, true);
});

test('validateMessage: register类型 — 缺 name 报错', () => {
  const r = validateMessage({ type: 'register' });
  assert.equal(r.valid, false);
  assert.match(r.error, /name/);
});

test('validateMessage: register类型 — 有 name 时通过', () => {
  const r = validateMessage({ type: 'register', name: 'openclaw' });
  assert.equal(r.valid, true);
});

test('validateMessage: ping类型 — 直接通过', () => {
  const r = validateMessage({ type: 'ping' });
  assert.equal(r.valid, true);
});

test('validateMessage: ack类型 — 缺 messageId 报错', () => {
  const r = validateMessage({ type: 'ack' });
  assert.equal(r.valid, false);
  assert.match(r.error, /messageId/);
});

test('validateMessage: ack类型 — 有 messageId 时通过', () => {
  const r = validateMessage({ type: 'ack', messageId: 'msg_123_abc123' });
  assert.equal(r.valid, true);
});

test('validateMessage: 未知类型 — 直接通过', () => {
  const r = validateMessage({ type: 'custom_event' });
  assert.equal(r.valid, true);
});
