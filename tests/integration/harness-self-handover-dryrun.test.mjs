import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLineageTracker } from '../../lib/lineage.mjs';
import { triggerHarnessSelfHandover } from '../../lib/harness-handover.mjs';
import { createNetworkWatchdog } from '../../bin/network-watchdog.mjs';
import { TEMP_ROOT } from '../helpers/temp-path.mjs';

const REAL_HANDOVER_REPO = 'D:/workspace/ai/research/xiheAi/xihe-tianshu-harness';
const REAL_STATUS_PATH = 'D:/workspace/ai/research/xiheAi/xihe-company-brain/portfolio/STATUS.md';

function createSandbox(name) {
  const dir = join(TEMP_ROOT, `handover-pipeline-${name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
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

function ok(latencyMs = 1) {
  return { ok: true, latencyMs };
}

test('dryRun pipeline: hard-signal heartbeat -> triggerHarnessSelfHandover -> handover file ready', async (t) => {
  const sandbox = createSandbox('hard-signal');
  const checkpointPath = join(sandbox, '.session-checkpoint.md');
  const lastBreathPath = join(sandbox, 'harness.json');
  const outputDir = join(sandbox, 'handover');
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(checkpointPath, [
    '## 正在干什么',
    '- 继续监督 B5 #23',
    '',
    '## 本 session 决策快照',
    '- hard-signal 先走 dryRun handover',
    '',
    '## 遇到的坑',
    '- 不能在 dryRun 里真起 claude.exe',
    '',
    '## 下一步计划',
    '- 生成 HANDOVER 并让 jianmu-pm 走 stub 联调',
  ].join('\n'), 'utf8');
  writeFileSync(lastBreathPath, JSON.stringify({
    git: { head_sha: 'pilot123' },
    current_doing: 'watchdog hard-signal pipeline dryRun',
  }, null, 2), 'utf8');

  let spawnCalled = false;
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
    lineage: createLineageTracker(),
    ipcSpawn: async (params) => {
      spawnCalled = true;
      return params;
    },
    triggerHarnessSelfHandoverImpl: triggerHarnessSelfHandover,
    handoverConfig: {
      checkpointPath,
      lastBreathPath,
      statusPath: REAL_STATUS_PATH,
      handoverRepoPath: REAL_HANDOVER_REPO,
      outputDir,
      dryRun: true,
      now: () => new Date('2026-04-19T15:30:00Z').getTime(),
    },
  });
  t.after(async () => {
    await watchdog.stop();
  });

  await watchdog.start({ runImmediately: false });
  watchdog.ingestHarnessHeartbeatContent(
    '【harness 2026-04-19T23:30:00.000Z · context-pct】70% | state=critical | next_action=self-handover',
  );
  await watchdog.waitForIdle();

  const handoverResult = watchdog.getLastHandoverResult();
  assert.equal(handoverResult.triggered, true);
  assert.equal(spawnCalled, false);
  assert.equal(existsSync(handoverResult.handoverFile), true);
  const content = readFileSync(handoverResult.handoverFile, 'utf8');
  assert.match(content, /## Goal/);
  assert.match(content, /## Context/);
  assert.match(content, /## NextSteps/);
});
