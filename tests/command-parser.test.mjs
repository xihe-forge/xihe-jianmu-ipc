import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../lib/command-parser.mjs';

// ── status ────────────────────────────────────────────────────────────────────

test('status: 中文"状态"', () => {
  assert.deepEqual(parseCommand('状态'), { type: 'status' });
});

test('status: 英文"status"', () => {
  assert.deepEqual(parseCommand('status'), { type: 'status' });
});

test('status: 中文"在线"', () => {
  assert.deepEqual(parseCommand('在线'), { type: 'status' });
});

test('status: 中文"谁在线"', () => {
  assert.deepEqual(parseCommand('谁在线'), { type: 'status' });
});

// ── help ──────────────────────────────────────────────────────────────────────

test('help: 中文"帮助"', () => {
  assert.deepEqual(parseCommand('帮助'), { type: 'help' });
});

test('help: 英文"help"', () => {
  assert.deepEqual(parseCommand('help'), { type: 'help' });
});

test('help: 中文"命令"', () => {
  assert.deepEqual(parseCommand('命令'), { type: 'help' });
});

test('help: 英文"commands"', () => {
  assert.deepEqual(parseCommand('commands'), { type: 'help' });
});

// ── report ────────────────────────────────────────────────────────────────────

test('report: 中文"日报"', () => {
  assert.deepEqual(parseCommand('日报'), { type: 'report' });
});

test('report: 英文"report"', () => {
  assert.deepEqual(parseCommand('report'), { type: 'report' });
});

test('report: 中文"汇报"', () => {
  assert.deepEqual(parseCommand('汇报'), { type: 'report' });
});

test('report: 中文"今日总结"', () => {
  assert.deepEqual(parseCommand('今日总结'), { type: 'report' });
});

// ── broadcast ─────────────────────────────────────────────────────────────────

test('broadcast: 广播:内容', () => {
  assert.deepEqual(parseCommand('广播:你好所有人'), { type: 'broadcast', content: '你好所有人' });
});

test('broadcast: broadcast:内容', () => {
  assert.deepEqual(parseCommand('broadcast:hello all'), { type: 'broadcast', content: 'hello all' });
});

test('broadcast: 通知所有人:内容', () => {
  assert.deepEqual(parseCommand('通知所有人:开会'), { type: 'broadcast', content: '开会' });
});

test('broadcast: 全体:内容', () => {
  assert.deepEqual(parseCommand('全体:注意'), { type: 'broadcast', content: '注意' });
});

// ── restart ───────────────────────────────────────────────────────────────────

test('restart: 重启 target', () => {
  assert.deepEqual(parseCommand('重启 bridge'), { type: 'restart', target: 'bridge' });
});

test('restart: 重启target（无空格）', () => {
  assert.deepEqual(parseCommand('重启bridge'), { type: 'restart', target: 'bridge' });
});

test('restart: restart target', () => {
  assert.deepEqual(parseCommand('restart bridge'), { type: 'restart', target: 'bridge' });
});

// ── history ───────────────────────────────────────────────────────────────────

test('history: 消息记录', () => {
  assert.deepEqual(parseCommand('消息记录'), { type: 'history' });
});

test('history: 历史消息', () => {
  assert.deepEqual(parseCommand('历史消息'), { type: 'history' });
});

test('history: history', () => {
  assert.deepEqual(parseCommand('history'), { type: 'history' });
});

test('history: 最近消息', () => {
  assert.deepEqual(parseCommand('最近消息'), { type: 'history' });
});

test('history: 带peer参数', () => {
  const r = parseCommand('历史消息 openclaw');
  assert.equal(r.type, 'history');
  assert.equal(r.peer, 'openclaw');
});

test('history: 带limit参数', () => {
  const r = parseCommand('最近消息 20');
  assert.equal(r.type, 'history');
  assert.equal(r.limit, 20);
  assert.equal(r.peer, undefined);
});

test('history: 带peer和limit参数', () => {
  const r = parseCommand('history openclaw 20');
  assert.equal(r.type, 'history');
  assert.equal(r.peer, 'openclaw');
  assert.equal(r.limit, 20);
});

// ── dispatch ──────────────────────────────────────────────────────────────────

test('dispatch: 让X去Y', () => {
  const r = parseCommand('让openclaw去查这个issue');
  assert.equal(r.type, 'dispatch');
  assert.equal(r.target, 'openclaw');
  assert.equal(r.content, '查这个issue');
});

test('dispatch: 让X Y（无"去"）', () => {
  const r = parseCommand('让openclaw 帮我找找');
  assert.equal(r.type, 'dispatch');
  assert.equal(r.target, 'openclaw');
  assert.equal(r.content, '帮我找找');
});

test('dispatch: @X Y', () => {
  const r = parseCommand('@openclaw 查一下GitHub issue');
  assert.equal(r.type, 'dispatch');
  assert.equal(r.target, 'openclaw');
  assert.equal(r.content, '查一下GitHub issue');
});

test('dispatch: 告诉X Y（空格分隔）', () => {
  const r = parseCommand('告诉openclaw 暂停');
  assert.equal(r.type, 'dispatch');
  assert.equal(r.target, 'openclaw');
  assert.equal(r.content, '暂停');
});

test('dispatch: 告诉X:Y（冒号分隔）', () => {
  const r = parseCommand('告诉openclaw:去处理日志');
  assert.equal(r.type, 'dispatch');
  assert.equal(r.target, 'openclaw');
  assert.equal(r.content, '去处理日志');
});

test('dispatch: 转发给X Y（空格分隔）', () => {
  const r = parseCommand('转发给openclaw 这段日志');
  assert.equal(r.type, 'dispatch');
  assert.equal(r.target, 'openclaw');
  assert.equal(r.content, '这段日志');
});

test('dispatch: 转发给X:Y（冒号分隔）', () => {
  const r = parseCommand('转发给openclaw:执行部署');
  assert.equal(r.type, 'dispatch');
  assert.equal(r.target, 'openclaw');
  assert.equal(r.content, '执行部署');
});

// ── 非命令文本 ────────────────────────────────────────────────────────────────

test('非命令: 普通对话返回null', () => {
  assert.equal(parseCommand('你好，今天天气怎么样？'), null);
});

test('非命令: 随机英文返回null', () => {
  assert.equal(parseCommand('what is the weather like'), null);
});

// ── 边界情况 ──────────────────────────────────────────────────────────────────

test('边界: 空字符串返回null', () => {
  assert.equal(parseCommand(''), null);
});

test('边界: 纯空格返回null', () => {
  assert.equal(parseCommand('   '), null);
});

test('边界: 非字符串返回null', () => {
  assert.equal(parseCommand(null), null);
  assert.equal(parseCommand(undefined), null);
  assert.equal(parseCommand(42), null);
});
