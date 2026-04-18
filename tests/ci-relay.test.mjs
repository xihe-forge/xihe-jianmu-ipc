import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCIRelayMessage,
  extractGitHubActionsUrl,
  extractGitHubActor,
  parseGitHubCIEmail,
  parseGitHubCISubject,
  resolveRouteTarget,
} from '../lib/ci-relay.mjs';

test('parseGitHubCISubject: 解析标准失败主题', () => {
  const parsed = parseGitHubCISubject('[xihe-forge/xihe-taiwei-bridge] Run failed: CI - main (abc1234)');
  assert.equal(parsed.repoFullName, 'xihe-forge/xihe-taiwei-bridge');
  assert.equal(parsed.repoName, 'xihe-taiwei-bridge');
  assert.equal(parsed.workflow, 'CI');
  assert.equal(parsed.branch, 'main');
  assert.equal(parsed.commitHash, 'abc1234');
  assert.equal(parsed.isFailure, true);
});

test('parseGitHubCISubject: 解析通用主题并提取分支', () => {
  const parsed = parseGitHubCISubject('[org/repo] Release failed: deploy on release/v1 (deadbee)');
  assert.equal(parsed.repoName, 'repo');
  assert.equal(parsed.workflow, 'Release failed');
  assert.equal(parsed.branch, 'release/v1');
  assert.equal(parsed.commitHash, 'deadbee');
  assert.equal(parsed.isFailure, true);
});

test('extractGitHubActionsUrl: 从正文提取 Actions 链接', () => {
  const url = extractGitHubActionsUrl('详情见 https://github.com/xihe-forge/xihe-jianmu-ipc/actions/runs/123456789');
  assert.equal(url, 'https://github.com/xihe-forge/xihe-jianmu-ipc/actions/runs/123456789');
});

test('extractGitHubActor: 从正文提取触发人', () => {
  const actor = extractGitHubActor('Workflow failed\nTriggered by alice\n');
  assert.equal(actor, 'alice');
});

test('parseGitHubCIEmail: 只接受 GitHub 失败通知', () => {
  const parsed = parseGitHubCIEmail({
    subject: '[xihe-forge/xihe-jianmu-ipc] Run failed: CI - main (abc1234)',
    head_from: { mail_address: 'notifications@github.com' },
    body_plain_text: Buffer.from('Triggered by bob\nhttps://github.com/xihe-forge/xihe-jianmu-ipc/actions/runs/42').toString('base64'),
    internal_date: '1710000000000',
  }, 'msg-1');

  assert.equal(parsed.messageId, 'msg-1');
  assert.equal(parsed.repoName, 'xihe-jianmu-ipc');
  assert.equal(parsed.branch, 'main');
  assert.equal(parsed.actor, 'bob');
  assert.equal(parsed.actionsUrl, 'https://github.com/xihe-forge/xihe-jianmu-ipc/actions/runs/42');
});

test('parseGitHubCIEmail: 成功通知跳过', () => {
  const parsed = parseGitHubCIEmail({
    subject: '[xihe-forge/xihe-jianmu-ipc] Run completed: CI - main (abc1234)',
    head_from: { mail_address: 'notifications@github.com' },
    body_plain_text: 'Triggered by bob',
  }, 'msg-2');

  assert.equal(parsed, null);
});

test('resolveRouteTarget: 支持短仓库名和全名匹配', () => {
  const routes = {
    'xihe-jianmu-ipc': 'jianmu-pm',
    'org/repo': 'release-bot',
  };

  assert.equal(resolveRouteTarget(routes, 'xihe-jianmu-ipc', 'xihe-forge/xihe-jianmu-ipc'), 'jianmu-pm');
  assert.equal(resolveRouteTarget(routes, 'repo', 'org/repo'), 'release-bot');
});

test('buildCIRelayMessage: 生成中继消息格式', () => {
  const message = buildCIRelayMessage({
    repoName: 'xihe-jianmu-ipc',
    branch: 'main',
    actor: 'bob',
    actionsUrl: 'https://github.com/xihe-forge/xihe-jianmu-ipc/actions/runs/42',
  }, 'jianmu-pm', 1234567890);

  assert.equal(message.type, 'message');
  assert.equal(message.from, 'ci-monitor');
  assert.equal(message.to, 'jianmu-pm');
  assert.equal(message.ts, 1234567890);
  assert.match(message.id, /^ci-1234567890-[0-9a-f]+$/);
  assert.equal(message.content, '[CI失败] xihe-jianmu-ipc / main\n触发: bob\n链接: https://github.com/xihe-forge/xihe-jianmu-ipc/actions/runs/42');
});
