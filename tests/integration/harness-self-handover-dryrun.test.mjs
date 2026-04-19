import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { createLineageTracker } from '../../lib/lineage.mjs';
import { triggerHarnessSelfHandover } from '../../lib/harness-handover.mjs';
import { createNetworkWatchdog } from '../../bin/network-watchdog.mjs';
import { createMcpTools } from '../../lib/mcp-tools.mjs';
import { TEMP_ROOT } from '../helpers/temp-path.mjs';

const CHECK_SCRIPT = 'D:/workspace/ai/research/xiheAi/xihe-tianshu-harness/scripts/check.sh';

function createSandbox(prefix) {
  const root = join(TEMP_ROOT, `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function cleanup(root) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
}

function initGitRepo(repoPath, files) {
  mkdirSync(repoPath, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(repoPath, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, 'utf8');
  }
  execFileSync('git', ['init'], { cwd: repoPath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Xihe'], { cwd: repoPath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'xihe-ai@lumidrivetech.com'], { cwd: repoPath, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: repoPath, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath, stdio: 'ignore' });
}

function createIpcClientStub() {
  return {
    async start() {},
    async stop() {},
    async sendPing() {
      return true;
    },
    async waitForPong() {
      return false;
    },
  };
}

function createSpawnTool(spawnCalls) {
  return createMcpTools({
    getSessionName: () => 'alpha',
    setSessionName: () => {},
    getHubHost: () => '127.0.0.1',
    setHubHost: () => {},
    getHubPort: () => 8765,
    setHubPort: () => {},
    getWs: () => ({ readyState: 1 }),
    disconnectWs: () => {},
    reconnect: () => {},
    getPendingOutgoingCount: () => 0,
    wsSend: () => true,
    httpGet: async () => [],
    httpPost: async () => ({ accepted: true }),
    httpPatch: async () => ({ ok: true }),
    spawnSession: async (params) => {
      spawnCalls.push(params);
      return { spawned: false, host: params.host };
    },
    stderrLog: () => {},
  });
}

function ok(latencyMs = 1) {
  return { ok: true, latencyMs };
}

test('harness self-handover dryRun pipeline: heartbeat -> handover -> check.sh -> ipc_spawn stub', async () => {
  const sandbox = createSandbox('handover-dryrun-pipeline');
  const handoverRepo = join(sandbox, 'xihe-tianshu-harness');
  const companyRepo = join(sandbox, 'xihe-company-brain');
  const checkpointPath = join(handoverRepo, '.session-checkpoint.md');
  const lastBreathPath = join(sandbox, 'harness.json');
  const statusPath = join(companyRepo, 'portfolio', 'STATUS.md');

  try {
    initGitRepo(companyRepo, {
      'portfolio/COMPANY-PLAN.md': '# COMPANY PLAN\n',
      'portfolio/STATUS.md': '## 一眼看（给老板）\n- **in-flight**：session-persistence MVP dryRun 链路\n',
    });
    initGitRepo(handoverRepo, {
      'handover/PROJECT-PLAN.md': '# PROJECT PLAN\n',
      'handover/TODO.md': '# TODO\n',
    });

    writeFileSync(checkpointPath, [
      '## 正在干什么',
      '- [20:05] 等 watchdog 吃到 critical heartbeat 后写 handover',
      '',
      '## 本 session 决策快照',
      '- [20:06] dryRun 只写临时 handover，不碰真实 git push / spawn',
      '',
      '## 遇到的坑',
      '- check.sh 需要 Context 引用齐全才会 PASS',
      '',
      '## 下一步计划',
      '- [ ] 生成 HANDOVER v2 并交给 tech-worker-stub 验证',
    ].join('\n'), 'utf8');
    writeFileSync(lastBreathPath, JSON.stringify({
      git: { head_sha: 'abc1234', dirty_files: ['handover/PROJECT-PLAN.md'] },
      current_doing: '准备切入 harness self-handover dryRun pipeline',
      dangerous_state: '不要在 dryRun 里触碰真实 spawn / push',
    }, null, 2), 'utf8');

    const transitions = [];
    const watchdog = createNetworkWatchdog({
      internalToken: 'watchdog-token',
      createWatchdogIpcClientImpl: () => createIpcClientStub(),
      probes: {
        cliProxy: async () => ok(),
        hub: async () => ok(),
        anthropic: async () => ok(),
        dns: async () => ok(),
        harness: async () => ({ ok: true, connected: true, reason: 'online and active' }),
      },
      onHarnessStateChange: (transition) => transitions.push(transition),
    });

    const accepted = watchdog.ingestHarnessHeartbeatMessage(
      '【harness 2026-04-19T20:05:00.000Z · context-pct】70% | state=critical | next_action=self-handover',
    );
    assert.equal(accepted, true);
    assert.equal(watchdog.getHarnessState().state, 'down');
    assert.equal(transitions.at(-1)?.reason, 'hard-signal');

    const ipcMessages = [];
    const lineage = createLineageTracker({ now: () => new Date('2026-04-19T20:05:30Z').getTime() });
    const handoverResult = await triggerHarnessSelfHandover({
      checkpointPath,
      lastBreathPath,
      statusPath,
      handoverRepoPath: handoverRepo,
      outputDir: join(handoverRepo, 'handover'),
      lineage,
      dryRun: true,
      ipcSend: async (payload) => {
        ipcMessages.push(payload);
      },
      now: () => new Date('2026-04-19T20:05:30Z').getTime(),
    });

    assert.equal(handoverResult.triggered, true);
    assert.ok(handoverResult.compatAlias, 'dryRun 应生成 check.sh 兼容副本');
    assert.equal(ipcMessages.length, 1);
    assert.equal(ipcMessages[0].to, 'tech-worker-stub');
    assert.equal(ipcMessages[0].topic, 'run-check-sh');

    execFileSync('bash', [CHECK_SCRIPT, '--only', 'HANDOVER', '--target', handoverRepo], {
      cwd: handoverRepo,
      stdio: 'pipe',
    });

    const content = readFileSync(handoverResult.handoverFile, 'utf8');
    assert.match(content, /## Goal/);
    assert.match(content, /## Context/);
    assert.match(content, /PROJECT-PLAN: .* @ /);
    assert.match(content, /TODO: .* @ /);
    assert.match(content, /1\. 读本文件（handover\/HANDOVER-HARNESS-\d{8}-\d{4}\.md）@ commit abc1234/);
    assert.match(content, /2\. 按 session-cold-start\.md v1\.0 的 7 步清单冷启/);
    assert.match(content, /3\. 续前任 in-flight task：等 watchdog 吃到 critical heartbeat 后写 handover/);

    const spawnCalls = [];
    const tools = createSpawnTool(spawnCalls);
    await tools.handleToolCall('ipc_spawn', {
      name: 'harness',
      host: 'wt',
      task: `续跑 ${handoverResult.handoverFile}`,
      model: 'opus',
    });

    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].host, 'wt');
    assert.equal(spawnCalls[0].model, 'opus');
    assert.match(spawnCalls[0].task, /续跑/);
  } finally {
    cleanup(sandbox);
  }
});
