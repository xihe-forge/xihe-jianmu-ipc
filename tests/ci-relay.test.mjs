import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RATE_LIMIT_BACKOFF_MS,
  RATE_LIMIT_ERROR_CODE,
  buildCIRelayMessage,
  extractGitHubActionsUrl,
  extractGitHubActor,
  isRateLimitError,
  parseGitHubCIEmail,
  parseGitHubCISubject,
  resolveRouteTarget,
  startCIRelay,
  stopCIRelay,
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

test('isRateLimitError: 识别飞书 15120000 和通用限频文案', () => {
  assert.equal(RATE_LIMIT_ERROR_CODE, 15120000);
  assert.equal(RATE_LIMIT_BACKOFF_MS, 5 * 60 * 1000);
  assert.equal(isRateLimitError({ code: 15120000, msg: 'hit rate limit, try again later' }), true);
  assert.equal(isRateLimitError(new Error('too many requests')), true);
  assert.equal(isRateLimitError(new Error('temporary network failure')), false);
});

test('startCIRelay: list unread 15120000 后 5min backoff，过期后恢复 polling', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-relay-rate-limit-'));
  t.after(() => {
    stopCIRelay();
    rmSync(dir, { recursive: true, force: true });
  });

  const routesPath = join(dir, 'ci-routes.json');
  const feishuAppsPath = join(dir, 'feishu-apps.json');
  writeFileSync(routesPath, JSON.stringify({ 'xihe-jianmu-ipc': 'jianmu-pm' }));
  writeFileSync(feishuAppsPath, JSON.stringify([{ appId: 'app', appSecret: 'secret' }]));

  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const originalStderrWrite = process.stderr.write;
  let intervalFn = null;
  let now = Date.parse('2026-05-02T13:15:00.000Z');
  let listCalls = 0;
  const logs = [];

  globalThis.setInterval = (fn, delay) => {
    assert.equal(delay, 60000);
    intervalFn = fn;
    return { unref() {} };
  };
  globalThis.clearInterval = () => {};
  process.stderr.write = function write(chunk, ...args) {
    logs.push(String(chunk));
    return originalStderrWrite.call(this, chunk, ...args);
  };

  t.after(() => {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    process.stderr.write = originalStderrWrite;
  });

  const client = {
    mail: {
      userMailboxMessage: {
        list: async () => {
          listCalls += 1;
          if (listCalls === 1) {
            const err = new Error('hit rate limit, try again later');
            err.code = RATE_LIMIT_ERROR_CODE;
            throw err;
          }
          return { code: 0, data: { items: [] } };
        },
      },
    },
  };

  startCIRelay(() => {}, {
    interval: 60000,
    routesPath,
    feishuAppsPath,
    mailboxId: 'xihe-ai@lumidrivetech.com',
    createClient: () => client,
    now: () => now,
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(listCalls, 1);
  assert.match(logs.join(''), /entering 5min backoff at 2026-05-02T13:15:00\.000Z/);
  assert.match(logs.join(''), /resumes at 2026-05-02T13:20:00\.000Z/);

  now += 60_000;
  intervalFn();
  await Promise.resolve();
  assert.equal(listCalls, 1);

  now += RATE_LIMIT_BACKOFF_MS - 60_000 - 1;
  intervalFn();
  await Promise.resolve();
  assert.equal(listCalls, 1);

  now += 1;
  intervalFn();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(listCalls, 2);
  assert.match(logs.join(''), /resuming poll at 2026-05-02T13:20:00\.000Z/);
});
