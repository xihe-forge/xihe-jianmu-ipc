import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createLineageTracker } from '../../lib/lineage.mjs';
import { triggerHarnessSelfHandover } from '../../lib/harness-handover.mjs';
import { TEMP_ROOT } from '../helpers/temp-path.mjs';

const REAL_HANDOVER_REPO = 'D:/workspace/ai/research/xiheAi/xihe-tianshu-harness';
const REAL_STATUS_PATH = 'D:/workspace/ai/research/xiheAi/xihe-company-brain/portfolio/STATUS.md';

function createSandbox(name) {
  const dir = join(TEMP_ROOT, `handover-${name}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
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

function assertEightSections(content) {
  for (const section of [
    '## Goal',
    '## Context',
    '## Actions-completed',
    '## Decisions',
    '## Files-touched',
    '## NextSteps',
    '## Blockers',
    '## Critical',
  ]) {
    assert.match(content, new RegExp(section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
}

test('triggerHarnessSelfHandover: dryRun 返回 inline HANDOVER 内容且不触发 git/spawn', async () => {
  const sandbox = createSandbox('dryrun');
  const checkpointPath = join(sandbox, '.session-checkpoint.md');
  const lastBreathPath = join(sandbox, 'harness.json');
  const outputDir = join(sandbox, 'handover');
  mkdirSync(outputDir, { recursive: true });

  writeFileSync(checkpointPath, [
    '## 正在干什么',
    '- 跟进 B5 #23 watchdog + handover',
    '',
    '## 本 session 决策快照',
    '- self-handover 先走 dryRun，不碰真实 spawn',
    '',
    '## 遇到的坑',
    '- Windows Terminal 真拉起留给 demo 真跑再测',
    '',
    '## 下一步计划',
    '- 补完整链路 dryRun 集成测试',
  ].join('\n'), 'utf8');
  writeFileSync(lastBreathPath, JSON.stringify({
    git: { head_sha: 'abc1234', dirty_files: ['lib/foo.mjs'] },
    current_doing: '正在收口 harness self-handover dryRun',
    dangerous_state: 'lineage depth 需要先检查再 spawn',
  }, null, 2), 'utf8');

  let spawnCalled = false;
  const result = await triggerHarnessSelfHandover({
    checkpointPath,
    lastBreathPath,
    statusPath: REAL_STATUS_PATH,
    handoverRepoPath: REAL_HANDOVER_REPO,
    outputDir,
    lineage: createLineageTracker(),
    ipcSpawn: async () => {
      spawnCalled = true;
      return { spawned: true };
    },
    dryRun: true,
    now: () => new Date('2026-04-19T14:30:00Z').getTime(),
  });

  assert.equal(result.triggered, true);
  assert.equal(result.commitSha, null);
  assert.equal(spawnCalled, false);
  assert.equal(result.handoverFile, null);
  assert.match(result.handoverFilename, /^HANDOVER-HARNESS-\d{8}-\d{4}\.md$/);
  assert.equal(existsSync(join(outputDir, result.handoverFilename)), false);
  assertEightSections(result.handoverContent);
  assert.match(result.handoverContent, /handover_reason: crash_recovery/);
  assert.match(result.handoverContent, /COMPANY-PLAN: xihe-company-brain\/portfolio\/COMPANY-PLAN.md @ /);
  assert.match(result.handoverContent, /1\. 读本文件（.*HANDOVER-HARNESS-\d{8}-\d{4}\.md）@ commit abc1234/);
  assert.match(result.handoverContent, /2\. 按 session-cold-start\.md v1\.0 的 7 步清单冷启/);
  assert.match(result.handoverContent, /3\. 续前任 in-flight task：跟进 B5 #23 watchdog \+ handover/);
});

test('triggerHarnessSelfHandover: lineage 熔断时直接拒绝触发', async () => {
  const result = await triggerHarnessSelfHandover({
    lineage: {
      check: () => ({ allowed: false, depth: 5, wakesInWindow: 3, reason: 'max-depth' }),
      record() {
        throw new Error('should not record');
      },
      chain: () => [],
    },
    ipcSpawn: async () => {
      throw new Error('should not spawn');
    },
    dryRun: true,
  });

  assert.deepEqual(result, {
    triggered: false,
    error: 'lineage fuse tripped',
    depth: 5,
    wakesInWindow: 3,
    reason: 'max-depth',
  });
});

test('triggerHarnessSelfHandover: checkpoint 缺失时生成 first_version handover 并写豁免声明', async () => {
  const sandbox = createSandbox('first-version');
  const handoverRepo = join(sandbox, 'repo');
  const outputDir = join(handoverRepo, 'handover');
  mkdirSync(outputDir, { recursive: true });

  const result = await triggerHarnessSelfHandover({
    checkpointPath: join(handoverRepo, '.missing-checkpoint.md'),
    statusPath: join(sandbox, 'missing-status.md'),
    handoverRepoPath: handoverRepo,
    outputDir,
    lineage: createLineageTracker(),
    ipcSpawn: async () => {
      throw new Error('dryRun should skip spawn');
    },
    dryRun: true,
    now: () => new Date('2026-04-19T15:00:00Z').getTime(),
  });

  assert.equal(result.handoverFile, null);
  assert.match(result.handoverContent, /handover_reason: first_version/);
  assert.match(result.handoverContent, /阻塞 首版豁免/);
});

test('triggerHarnessSelfHandover: 非 dryRun 时向 ipcSpawn 透传 handoverRepoPath 作为 cwd', async () => {
  const sandbox = createSandbox('spawn-cwd');
  const handoverRepo = join(sandbox, 'xihe-tianshu-harness');
  const companyRepo = join(sandbox, 'xihe-company-brain');
  const checkpointPath = join(handoverRepo, '.session-checkpoint.md');
  const lastBreathPath = join(sandbox, 'harness.json');
  const statusPath = join(companyRepo, 'portfolio', 'STATUS.md');
  const spawnCalls = [];

  initGitRepo(companyRepo, {
    'portfolio/COMPANY-PLAN.md': '# COMPANY PLAN\n',
    'portfolio/STATUS.md': '## 一眼看（给老板）\n- **in-flight**：spawn cwd 透传\n',
  });
  initGitRepo(handoverRepo, {
    'handover/PROJECT-PLAN.md': '# PROJECT PLAN\n',
    'handover/TODO.md': '# TODO\n',
  });

  writeFileSync(checkpointPath, [
    '## 正在干什么',
    '- 准备验证 spawn cwd 参数链',
    '',
    '## 本 session 决策快照',
    '- triggerHarnessSelfHandover 应显式传 handoverRepoPath',
    '',
    '## 遇到的坑',
    '- wt 新 tab 必须从正确 repo cwd 启动',
    '',
    '## 下一步计划',
    '- 调 ipc_spawn(host=wt, cwd=handoverRepoPath)',
  ].join('\n'), 'utf8');
  writeFileSync(lastBreathPath, JSON.stringify({
    git: { head_sha: 'abc1234', dirty_files: ['handover/PROJECT-PLAN.md'] },
    current_doing: '验证 handover -> ipc_spawn cwd 透传',
    dangerous_state: '错误 cwd 会导致 .mcp.json 查找路径错',
  }, null, 2), 'utf8');

  const result = await triggerHarnessSelfHandover({
    checkpointPath,
    lastBreathPath,
    statusPath,
    handoverRepoPath: handoverRepo,
    outputDir: join(handoverRepo, 'handover'),
    lineage: createLineageTracker({ now: () => new Date('2026-04-19T16:10:00Z').getTime() }),
    ipcSpawn: async (params) => {
      spawnCalls.push(params);
      return { spawned: true, host: params.host, cwd: params.cwd };
    },
    dryRun: false,
    now: () => new Date('2026-04-19T16:10:00Z').getTime(),
    logger: { warn() {} },
  });

  assert.equal(result.triggered, true);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].host, 'wt');
  assert.equal(spawnCalls[0].cwd, handoverRepo);
  assert.equal(result.spawnResult.cwd, handoverRepo);
});
