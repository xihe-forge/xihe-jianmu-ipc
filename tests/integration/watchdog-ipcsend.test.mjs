import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { startWatchdog } from '../../bin/network-watchdog.mjs';
import { createLineageTracker } from '../../lib/lineage.mjs';
import { TEMP_ROOT } from '../helpers/temp-path.mjs';

function createSandbox(name) {
  const dir = join(TEMP_ROOT, `watchdog-ipcsend-${name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function initGitRepo(repoPath, files) {
  mkdirSync(repoPath, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const diskPath = join(repoPath, relativePath);
    mkdirSync(dirname(diskPath), { recursive: true });
    writeFileSync(diskPath, content, 'utf8');
  }
  execFileSync('git', ['init'], { cwd: repoPath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Xihe'], { cwd: repoPath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'xihe-ai@lumidrivetech.com'], { cwd: repoPath, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: repoPath, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath, stdio: 'ignore' });
}

function ok(latencyMs = 1) {
  return { ok: true, latencyMs };
}

function createIpcClientStub() {
  const calls = {
    start: 0,
    stop: 0,
    sendPing: [],
    sendMessage: [],
  };

  return {
    calls,
    client: {
      async start() {
        calls.start += 1;
      },
      async stop() {
        calls.stop += 1;
      },
      async sendPing() {
        calls.sendPing.push('ping');
        return true;
      },
      async waitForPong() {
        return false;
      },
      async sendMessage(payload) {
        calls.sendMessage.push(payload);
        return true;
      },
    },
  };
}

test('startWatchdog: auto handover 注入 ipcSend 并发送 run-check-sh', async (t) => {
  const sandbox = createSandbox('dryrun');
  const handoverRepo = join(sandbox, 'xihe-tianshu-harness');
  const companyRepo = join(sandbox, 'xihe-company-brain');
  const checkpointPath = join(handoverRepo, '.session-checkpoint.md');
  const lastBreathPath = join(sandbox, 'harness.json');
  const statusPath = join(companyRepo, 'portfolio', 'STATUS.md');
  const outputDir = join(handoverRepo, 'handover');
  const ipcPort = 44100 + Math.floor(Math.random() * 500);
  const watchdogPort = ipcPort + 500;
  const nowValue = new Date('2026-04-20T00:10:00Z').getTime();
  const ipcClient = createIpcClientStub();

  initGitRepo(companyRepo, {
    'portfolio/COMPANY-PLAN.md': '# COMPANY PLAN\n',
    'portfolio/STATUS.md': '## 一眼看（给老板）\n- **in-flight**：watchdog run-check-sh dryRun 注入\n',
  });
  initGitRepo(handoverRepo, {
    'handover/PROJECT-PLAN.md': '# PROJECT PLAN\n',
    'handover/TODO.md': '# TODO\n',
  });

  writeFileSync(checkpointPath, [
    '## 正在干什么',
    '- 等 watchdog critical heartbeat 触发 dryRun handover',
    '',
    '## 本 session 决策快照',
    '- run-check-sh IPC 必须由 watchdog 自动注入',
    '',
    '## 遇到的坑',
    '- handoverConfig 默认空对象时 ipcSend 会丢',
    '',
    '## 下一步计划',
    '- 验证 tech-worker-stub 收到 run-check-sh',
  ].join('\n'), 'utf8');
  writeFileSync(lastBreathPath, JSON.stringify({
    git: { head_sha: 'abc1234', dirty_files: ['handover/TODO.md'] },
    current_doing: '验证 watchdog 注入 ipcSend',
    dangerous_state: 'run-check-sh IPC 丢失会让 tech-worker 收不到检查信号',
  }, null, 2), 'utf8');

  const watchdog = await startWatchdog({
    ipcPort,
    watchdogPort,
    intervalMs: 60_000,
    coldStartGraceMs: 0,
    internalToken: 'watchdog-token',
    ipcSpawn: async () => {
      throw new Error('dryRun should not spawn');
    },
    lineage: createLineageTracker({
      dbPath: join(sandbox, 'messages.db'),
      now: () => nowValue,
    }),
    createWatchdogIpcClientImpl: () => ipcClient.client,
    probes: {
      cliProxy: async () => ok(),
      hub: async () => ok(),
      anthropic: async () => ok(),
      dns: async () => ok(),
      harness: async () => ({ ok: true, connected: true, reason: 'online and active' }),
    },
    handoverConfig: {
      checkpointPath,
      lastBreathPath,
      statusPath,
      handoverRepoPath: handoverRepo,
      outputDir,
      dryRun: true,
      now: () => nowValue,
      logger: { warn() {} },
    },
  });

  t.after(async () => {
    await watchdog.stop();
    try {
      rmSync(sandbox, { recursive: true, force: true });
    } catch {}
  });

  const accepted = watchdog.ingestHarnessHeartbeatMessage(
    '【harness 2026-04-20T00:10:00.000Z · context-pct】70% | state=critical | next_action=self-handover',
  );
  assert.equal(accepted, true);

  await watchdog.waitForIdle();

  assert.equal(ipcClient.calls.start, 1);
  assert.equal(ipcClient.calls.sendMessage.length, 1);
  assert.equal(ipcClient.calls.sendMessage[0].to, 'tech-worker-stub');
  assert.equal(ipcClient.calls.sendMessage[0].topic, 'run-check-sh');
  assert.match(ipcClient.calls.sendMessage[0].content, /run-check-sh/);
  assert.match(ipcClient.calls.sendMessage[0].content, /mode: --only HANDOVER/);
});
