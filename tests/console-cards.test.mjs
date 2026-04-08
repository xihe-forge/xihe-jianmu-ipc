import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStatusCard,
  buildHelpCard,
  buildHistoryCard,
  buildReportCard,
  buildDispatchCard,
  buildErrorCard,
} from '../lib/console-cards.mjs';

// ── 通用结构辅助断言 ──────────────────────────────────────────────────────────

function assertCardStructure(card) {
  assert.ok(card.config?.wide_screen_mode === true, 'config.wide_screen_mode 应为 true');
  assert.ok(card.header?.title, 'header.title 应存在');
  assert.ok(Array.isArray(card.elements) && card.elements.length > 0, 'elements 应为非空数组');
}

// ── buildStatusCard ───────────────────────────────────────────────────────────

test('buildStatusCard: 基础结构正确', () => {
  const agents = [
    { name: 'openclaw', online: true, connectedAt: new Date().toISOString(), lastSeen: null },
    { name: 'codex', online: false, connectedAt: null, lastSeen: Date.now() - 60000 },
  ];
  const health = { uptime: 3600, messageCount: 42 };
  const card = buildStatusCard(agents, health);
  assertCardStructure(card);
});

test('buildStatusCard: 正确统计在线数量', () => {
  const agents = [
    { name: 'a', online: true, connectedAt: new Date().toISOString(), lastSeen: null },
    { name: 'b', online: true, connectedAt: new Date().toISOString(), lastSeen: null },
    { name: 'c', online: false, connectedAt: null, lastSeen: null },
  ];
  const card = buildStatusCard(agents, { uptime: 100, messageCount: 5 });
  const bodyContent = card.elements[0].text.content;
  // 在线: 2 / 3
  assert.ok(bodyContent.includes('2'), '应包含在线数量2');
  assert.ok(bodyContent.includes('3'), '应包含总数3');
});

test('buildStatusCard: 无Agent时显示提示文字', () => {
  const card = buildStatusCard([], { uptime: 0, messageCount: 0 });
  assertCardStructure(card);
  const bodyContent = card.elements[0].text.content;
  assert.ok(bodyContent.includes('暂无'), '无Agent时应显示暂无提示');
});

test('buildStatusCard: agent列表渲染包含agent名称', () => {
  const agents = [
    { name: 'myagent', online: true, connectedAt: new Date().toISOString(), lastSeen: null },
  ];
  const card = buildStatusCard(agents, { uptime: 60, messageCount: 1 });
  const bodyContent = card.elements[0].text.content;
  assert.ok(bodyContent.includes('myagent'));
});

// ── buildHelpCard ─────────────────────────────────────────────────────────────

test('buildHelpCard: 基础结构正确', () => {
  const card = buildHelpCard();
  assertCardStructure(card);
});

test('buildHelpCard: 包含常用命令说明', () => {
  const card = buildHelpCard();
  const bodyContent = card.elements[0].text.content;
  assert.ok(bodyContent.includes('状态'));
  assert.ok(bodyContent.includes('帮助'));
  assert.ok(bodyContent.includes('日报'));
});

// ── buildHistoryCard ──────────────────────────────────────────────────────────

test('buildHistoryCard: 有消息时基础结构正确', () => {
  const messages = [
    { from: 'alice', to: 'bob', content: 'hello', ts: Date.now() },
    { from: 'bob', to: 'alice', content: 'world', ts: Date.now() - 1000 },
  ];
  const card = buildHistoryCard(messages, { total: 2 });
  assertCardStructure(card);
});

test('buildHistoryCard: 空消息时显示提示文字', () => {
  const card = buildHistoryCard([], { total: 0 });
  assertCardStructure(card);
  const bodyContent = card.elements[0].text.content;
  assert.ok(bodyContent.includes('暂无'), '空消息应显示暂无提示');
});

test('buildHistoryCard: 指定peer时标题包含peer名', () => {
  const card = buildHistoryCard([], { peer: 'openclaw', total: 0 });
  const titleContent = card.header.title.content;
  assert.ok(titleContent.includes('openclaw'));
});

test('buildHistoryCard: 有消息时显示消息内容和总数', () => {
  const messages = [
    { from: 'alice', to: 'bob', content: 'test message', ts: Date.now() },
  ];
  const card = buildHistoryCard(messages, { total: 10 });
  const bodyContent = card.elements[0].text.content;
  assert.ok(bodyContent.includes('alice'));
  assert.ok(bodyContent.includes('bob'));
  assert.ok(bodyContent.includes('10'), '应显示总消息数');
});

// ── buildReportCard ───────────────────────────────────────────────────────────

test('buildReportCard: 基础结构正确', () => {
  const data = {
    date: '2026-04-08',
    agents: [
      { name: 'openclaw', messagesHandled: 15, status: 'online' },
      { name: 'codex', messagesHandled: 8, status: 'offline' },
    ],
    totalMessages: 23,
    hubUptime: 7200,
  };
  const card = buildReportCard(data);
  assertCardStructure(card);
});

test('buildReportCard: 标题包含日期', () => {
  const card = buildReportCard({ date: '2026-04-08', agents: [], totalMessages: 0, hubUptime: 0 });
  const titleContent = card.header.title.content;
  assert.ok(titleContent.includes('2026-04-08'));
});

test('buildReportCard: Agent明细渲染', () => {
  const data = {
    date: '2026-04-08',
    agents: [{ name: 'myagent', messagesHandled: 5, status: 'online' }],
    totalMessages: 5,
    hubUptime: 100,
  };
  const card = buildReportCard(data);
  const bodyContent = card.elements[0].text.content;
  assert.ok(bodyContent.includes('myagent'));
  assert.ok(bodyContent.includes('5'));
});

test('buildReportCard: 无Agent时显示提示', () => {
  const card = buildReportCard({ date: '2026-04-08', agents: [], totalMessages: 0, hubUptime: 0 });
  const bodyContent = card.elements[0].text.content;
  assert.ok(bodyContent.includes('无Agent数据'));
});

// ── buildDispatchCard ─────────────────────────────────────────────────────────

test('buildDispatchCard: 在线送达', () => {
  const card = buildDispatchCard('openclaw', '请检查日志', 'task_12345678abcd', true);
  assert.strictEqual(card.config.wide_screen_mode, true);
  assert.strictEqual(card.header.template, 'green');
  assert.ok(card.header.title.content.includes('任务已派发'));
  assert.ok(card.elements[0].text.content.includes('openclaw'));
  assert.ok(card.elements[0].text.content.includes('5678abcd'));
  assert.ok(card.elements[0].text.content.includes('已送达'));
});

test('buildDispatchCard: 离线缓冲', () => {
  const card = buildDispatchCard('worker', '编译项目', 'task_999_aabbccdd', false);
  assert.strictEqual(card.header.template, 'wathet');
  assert.ok(card.elements[0].text.content.includes('已缓冲'));
  assert.ok(card.elements[0].text.content.includes('aabbccdd'));
});

// ── buildErrorCard ────────────────────────────────────────────────────────────

test('buildErrorCard: 基础结构正确', () => {
  const card = buildErrorCard('连接失败', '无法连接到Hub服务');
  assertCardStructure(card);
});

test('buildErrorCard: 标题包含传入的title', () => {
  const card = buildErrorCard('测试错误标题', '错误详情');
  assert.equal(card.header.title.content, '测试错误标题');
});

test('buildErrorCard: elements包含错误消息', () => {
  const card = buildErrorCard('Error', '详细错误信息：超时');
  const bodyContent = card.elements[0].text.content;
  assert.ok(bodyContent.includes('详细错误信息：超时'));
});

test('buildErrorCard: 使用红色模板', () => {
  const card = buildErrorCard('Error', 'msg');
  assert.equal(card.header.template, 'red');
});
