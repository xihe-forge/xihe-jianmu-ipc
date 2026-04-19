import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import { dirname, join, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_CHECKPOINT_PATH = 'D:/workspace/ai/research/xiheAi/xihe-tianshu-harness/.session-checkpoint.md';
const DEFAULT_STATUS_PATH = 'D:/workspace/ai/research/xiheAi/xihe-company-brain/portfolio/STATUS.md';
const DEFAULT_HANDOVER_REPO_PATH = 'D:/workspace/ai/research/xiheAi/xihe-tianshu-harness';
const HANDOVER_DIRNAME = 'handover';
const COLD_START_PATH = 'xihe-tianshu-harness/domains/software/knowledge/session-cold-start.md v1.0';
let gitExecutableCache = null;

function assertLineage(lineage) {
  if (!lineage || typeof lineage.check !== 'function' || typeof lineage.record !== 'function') {
    throw new TypeError('lineage.check() and lineage.record() are required');
  }
}

function dedupe(items) {
  return [...new Set(items.filter((item) => typeof item === 'string' && item.trim() !== ''))];
}

function formatIso(nowValue) {
  return new Date(nowValue).toISOString();
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatDateParts(nowValue) {
  const date = new Date(nowValue);
  return {
    yyyy: String(date.getFullYear()),
    mm: pad(date.getMonth() + 1),
    dd: pad(date.getDate()),
    hh: pad(date.getHours()),
    min: pad(date.getMinutes()),
  };
}

function formatCommitTimestamp(nowValue) {
  const parts = formatDateParts(nowValue);
  return `${parts.yyyy}-${parts.mm}-${parts.dd} ${parts.hh}:${parts.min}`;
}

function formatFileTimestamp(nowValue) {
  const parts = formatDateParts(nowValue);
  return `${parts.yyyy}${parts.mm}${parts.dd}-${parts.hh}${parts.min}`;
}

function formatClock(nowValue) {
  const parts = formatDateParts(nowValue);
  return `${parts.hh}:${parts.min}`;
}

function normalizeReason(reason, isFirstVersion) {
  if (isFirstVersion) {
    return 'first_version';
  }

  if (reason === 'auto') {
    return 'crash_recovery';
  }

  return typeof reason === 'string' && reason.trim() !== ''
    ? reason.trim()
    : 'manual';
}

function stripBulletPrefix(line) {
  return line
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*\d+\.\s+/, '')
    .trim();
}

function splitSectionLines(sectionContent) {
  return dedupe(
    String(sectionContent ?? '')
      .split(/\r?\n/)
      .map(stripBulletPrefix)
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

function extractMarkdownSection(content, heading) {
  if (typeof content !== 'string') {
    return '';
  }

  const lines = content.split(/\r?\n/);
  const collected = [];
  let inSection = false;
  const headingPrefix = `## ${heading}`;

  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (line.startsWith(headingPrefix)) {
        inSection = true;
        continue;
      }
      if (inSection) {
        break;
      }
    }

    if (inSection) {
      collected.push(line);
    }
  }

  return collected.join('\n').trim();
}

async function pathExists(filePath) {
  if (!filePath) {
    return false;
  }

  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readTextIfExists(filePath) {
  if (!await pathExists(filePath)) {
    return null;
  }
  return readFile(filePath, 'utf8');
}

async function readJsonIfExists(filePath) {
  const content = await readTextIfExists(filePath);
  if (!content) {
    return null;
  }

  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function defaultLastBreathPath() {
  return join(os.homedir(), '.claude', 'session-state', 'harness.json');
}

async function resolveGitExecutable() {
  if (gitExecutableCache) {
    return gitExecutableCache;
  }

  const candidates = [
    process.env.GIT_EXECUTABLE,
    process.platform === 'win32' ? 'git.exe' : 'git',
    'git',
  ];

  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('where.exe', ['git']);
      candidates.unshift(...stdout.split(/\r?\n/).filter(Boolean));
    } catch {
      // ignore
    }

    candidates.push(
      'D:/software/ide/Git/cmd/git.exe',
      'D:/software/ide/Git/bin/git.exe',
      'C:/Program Files/Git/cmd/git.exe',
      'C:/Program Files/Git/bin/git.exe',
      'C:/Program Files (x86)/Git/cmd/git.exe',
      'C:/Program Files (x86)/Git/bin/git.exe',
      join(os.homedir(), 'AppData', 'Local', 'Programs', 'Git', 'cmd', 'git.exe'),
    );
  }

  for (const candidate of dedupe(candidates)) {
    if (!candidate) {
      continue;
    }

    if (candidate.includes('/') || candidate.includes('\\')) {
      if (await pathExists(candidate)) {
        gitExecutableCache = candidate;
        return candidate;
      }
      continue;
    }

    gitExecutableCache = candidate;
    return candidate;
  }

  gitExecutableCache = process.platform === 'win32' ? 'git.exe' : 'git';
  return gitExecutableCache;
}

async function runGit(cwd, args) {
  const { stdout } = await execFileAsync(await resolveGitExecutable(), args, { cwd });
  return stdout.trim();
}

async function getGitShortSha(repoPath, relativePath = null) {
  const args = relativePath
    ? ['log', '--format=%h', '-n', '1', '--', relativePath]
    : ['rev-parse', '--short=7', 'HEAD'];

  try {
    const stdout = await runGit(repoPath, args);
    return stdout.split(/\r?\n/).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

async function allocateHandoverPath(outputDir, baseName) {
  let attempt = 1;
  while (true) {
    const suffix = attempt === 1 ? '' : `-v${attempt}`;
    const filePath = join(outputDir, `${baseName}${suffix}.md`);
    if (!await pathExists(filePath)) {
      return filePath;
    }
    attempt += 1;
  }
}

function buildGoal(statusContent) {
  const overview = splitSectionLines(extractMarkdownSection(statusContent, '一眼看'));
  if (overview.length === 0) {
    return '继续 portfolio 协调并恢复 harness 监督链路。';
  }

  return `继续 portfolio 协调，优先关注：${overview.slice(0, 2).join('；')}。`;
}

function extractCheckpointData(checkpointContent) {
  return {
    doing: splitSectionLines(extractMarkdownSection(checkpointContent, '正在干什么')),
    decisions: splitSectionLines(extractMarkdownSection(checkpointContent, '本 session 决策快照')),
    pitfalls: splitSectionLines(extractMarkdownSection(checkpointContent, '遇到的坑')),
    nextSteps: splitSectionLines(extractMarkdownSection(checkpointContent, '下一步计划')),
  };
}

function buildActionsCompleted({ checkpoint, lastBreath, commitSha }) {
  const items = [];
  if (typeof lastBreath?.current_doing === 'string' && lastBreath.current_doing.trim() !== '') {
    items.push(lastBreath.current_doing.trim());
  }
  items.push(...checkpoint.doing);

  const unique = dedupe(items).slice(0, 6);
  if (unique.length === 0) {
    return ['- 暂无可恢复的 Actions-completed 源数据；先按 Context 与 cold-start 恢复。'];
  }

  return unique.map((item) =>
    `- ${commitSha ? `${commitSha} — ` : ''}${item}`);
}

function buildDecisions({ checkpoint, nowValue }) {
  const clock = formatClock(nowValue);
  if (checkpoint.decisions.length === 0) {
    return [`- [${clock}] 保持最小可恢复 handover：缺失显式决策记录时以 checkpoint / STATUS / lastBreath 为准。`];
  }

  return checkpoint.decisions.slice(0, 6).map((item) => `- [${clock}] ${item}`);
}

function buildFilesTouched({ lastBreath, checkpointPath, statusPath }) {
  const items = [];
  for (const dirtyFile of lastBreath?.git?.dirty_files ?? []) {
    items.push(`- ${dirtyFile} — 上任 session lastBreath 记录的未提交/关注文件`);
  }

  if (items.length === 0 && checkpointPath) {
    items.push(`- ${checkpointPath} — 交接时读取的 checkpoint 源文件`);
  }
  if (items.length <= 1 && statusPath) {
    items.push(`- ${statusPath} — 交接时读取的 portfolio 状态源文件`);
  }

  return items.slice(0, 8);
}

function buildNextSteps({ checkpoint, handoverRelativePath, commitSha, lineageDepth }) {
  const items = [...checkpoint.nextSteps];
  items.push(
    `读 ${handoverRelativePath}${commitSha ? ` @ commit ${commitSha}` : ''}，并严格按 ${COLD_START_PATH} 的 7 步清单冷启。`,
    `确认 IPC / watchdog / harness-session 状态，然后继续接手第 ${lineageDepth + 1} 代协调。`,
  );

  return dedupe(items).slice(0, 6).map((item, index) => `${index + 1}. ${item}`);
}

function buildBlockers({ isFirstVersion }) {
  if (isFirstVersion) {
    return [
      '- **阻塞 首版豁免**：本次为项目首版交接（handover_reason=first_version），PROJECT-PLAN.md + TODO.md 将在下次交接前必补（下次交接必须含这两引用否则 HANDOVER-2 FAIL）。',
    ];
  }

  return ['- 暂无新增 blocker；先按 cold-start 恢复上下文并确认 IPC / watchdog / portfolio 状态。'];
}

function buildCritical({ checkpoint, lastBreath }) {
  const items = [...checkpoint.pitfalls];
  if (typeof lastBreath?.dangerous_state === 'string' && lastBreath.dangerous_state.trim() !== '') {
    items.push(lastBreath.dangerous_state.trim());
  }

  const unique = dedupe(items).slice(0, 6);
  if (unique.length === 0) {
    return ['- 暂无新增 critical 陷阱记录；先以 STATUS / company plan 为准恢复上下文。'];
  }
  return unique.map((item) => `- ${item}`);
}

function buildContextLines({ companyPlanSha, statusSha, projectPlanSha, todoSha }) {
  const lines = [];

  if (companyPlanSha) {
    lines.push(`- COMPANY-PLAN: xihe-company-brain/portfolio/COMPANY-PLAN.md @ ${companyPlanSha}`);
  }
  if (statusSha) {
    lines.push(`- STATUS: xihe-company-brain/portfolio/STATUS.md @ ${statusSha}`);
  }
  if (projectPlanSha) {
    lines.push(`- PROJECT-PLAN: xihe-tianshu-harness/handover/PROJECT-PLAN.md @ ${projectPlanSha}`);
  }
  if (todoSha) {
    lines.push(`- TODO: xihe-tianshu-harness/handover/TODO.md @ ${todoSha}`);
  }

  return lines;
}

function renderHandoverMarkdown({
  createdAtIso,
  handoverReason,
  parentSessionId,
  lineageDepth,
  goal,
  contextLines,
  actionsCompleted,
  decisions,
  filesTouched,
  nextSteps,
  blockers,
  critical,
}) {
  return [
    '---',
    'session: harness',
    'successor: harness',
    `parent_session_id: ${parentSessionId ?? 'null'}`,
    `lineage_depth: ${lineageDepth}`,
    `created_at: ${createdAtIso}`,
    `handover_reason: ${handoverReason}`,
    '---',
    '',
    '## Goal',
    '',
    goal,
    '',
    '## Context',
    '',
    ...contextLines,
    '',
    '## Actions-completed',
    '',
    ...actionsCompleted,
    '',
    '## Decisions',
    '',
    ...decisions,
    '',
    '## Files-touched',
    '',
    ...filesTouched,
    '',
    '## NextSteps',
    '',
    ...nextSteps,
    '',
    '## Blockers',
    '',
    ...blockers,
    '',
    '## Critical',
    '',
    ...critical,
    '',
  ].join('\n');
}

export async function triggerHarnessSelfHandover({
  checkpointPath = DEFAULT_CHECKPOINT_PATH,
  lastBreathPath = null,
  statusPath = DEFAULT_STATUS_PATH,
  handoverRepoPath = DEFAULT_HANDOVER_REPO_PATH,
  lineage,
  ipcSpawn,
  reason = 'auto',
  dryRun = false,
  now = Date.now,
  logger = console,
  outputDir = null,
  spawnHost = 'wt',
  spawnModel = 'opus',
} = {}) {
  assertLineage(lineage);

  const lineageStatus = lineage.check('harness');
  if (!lineageStatus.allowed) {
    return {
      triggered: false,
      error: 'lineage fuse tripped',
      depth: lineageStatus.depth,
      wakesInWindow: lineageStatus.wakesInWindow,
      reason: lineageStatus.reason,
    };
  }

  const nowValue = Number(now());
  const createdAtIso = formatIso(nowValue);
  const effectiveLastBreathPath = lastBreathPath ?? defaultLastBreathPath();
  const checkpointContent = await readTextIfExists(checkpointPath);
  const statusContent = await readTextIfExists(statusPath);
  const lastBreath = await readJsonIfExists(effectiveLastBreathPath);
  const checkpoint = extractCheckpointData(checkpointContent);
  const isFirstVersion = !checkpointContent && !statusContent;
  const handoverReason = normalizeReason(reason, isFirstVersion);
  const existingChain = typeof lineage.chain === 'function'
    ? lineage.chain('harness')
    : [];
  const parentSessionId = existingChain.at(-1) ?? null;
  const lineageDepth = lineageStatus.depth + 1;

  const companyRepoPath = dirname(dirname(statusPath));
  const companyPlanSha = await getGitShortSha(companyRepoPath, 'portfolio/COMPANY-PLAN.md');
  const statusSha = await getGitShortSha(companyRepoPath, 'portfolio/STATUS.md');
  const projectPlanDiskPath = join(handoverRepoPath, HANDOVER_DIRNAME, 'PROJECT-PLAN.md');
  const todoDiskPath = join(handoverRepoPath, HANDOVER_DIRNAME, 'TODO.md');
  const projectPlanSha = await pathExists(projectPlanDiskPath)
    ? await getGitShortSha(handoverRepoPath, `${HANDOVER_DIRNAME}/PROJECT-PLAN.md`)
    : null;
  const todoSha = await pathExists(todoDiskPath)
    ? await getGitShortSha(handoverRepoPath, `${HANDOVER_DIRNAME}/TODO.md`)
    : null;

  const resolvedOutputDir = outputDir ?? join(handoverRepoPath, HANDOVER_DIRNAME);
  await mkdir(resolvedOutputDir, { recursive: true });
  const handoverFilePath = await allocateHandoverPath(
    resolvedOutputDir,
    `HANDOVER-HARNESS-${formatFileTimestamp(nowValue)}`,
  );
  const handoverRelativePath = relative(handoverRepoPath, handoverFilePath).replace(/\\/g, '/');
  const goal = buildGoal(statusContent);
  const contextLines = buildContextLines({
    companyPlanSha,
    statusSha,
    projectPlanSha,
    todoSha,
  });
  const handoverMarkdown = renderHandoverMarkdown({
    createdAtIso,
    handoverReason,
    parentSessionId,
    lineageDepth,
    goal,
    contextLines: contextLines.length > 0 ? contextLines : ['- COMPANY-PLAN: xihe-company-brain/portfolio/COMPANY-PLAN.md @ local'],
    actionsCompleted: buildActionsCompleted({
      checkpoint,
      lastBreath,
      commitSha: lastBreath?.git?.head_sha ?? null,
    }),
    decisions: buildDecisions({ checkpoint, nowValue }),
    filesTouched: buildFilesTouched({ lastBreath, checkpointPath, statusPath }),
    nextSteps: buildNextSteps({
      checkpoint,
      handoverRelativePath,
      commitSha: lastBreath?.git?.head_sha ?? null,
      lineageDepth,
    }),
    blockers: buildBlockers({ isFirstVersion }),
    critical: buildCritical({ checkpoint, lastBreath }),
  });

  await writeFile(handoverFilePath, handoverMarkdown, 'utf8');

  let commitSha = null;
  let pushError = null;
  if (!dryRun) {
    await runGit(handoverRepoPath, ['add', handoverRelativePath]);
    const commitMessage = `docs(handover): harness self-handover ${formatCommitTimestamp(nowValue)} (${handoverReason})`;
    await execFileAsync(await resolveGitExecutable(), [
      '-c', 'user.name=Xihe',
      '-c', 'user.email=xihe-ai@lumidrivetech.com',
      'commit',
      '-m',
      commitMessage,
    ], { cwd: handoverRepoPath });
    commitSha = await runGit(handoverRepoPath, ['rev-parse', '--short=7', 'HEAD']);
    try {
      await runGit(handoverRepoPath, ['push', 'origin', 'main']);
    } catch (error) {
      pushError = error?.message ?? String(error);
      logger?.warn?.(`[harness-handover] git push failed: ${pushError}`);
    }
  }

  const taskCommitSha = commitSha ?? lastBreath?.git?.head_sha ?? parentSessionId ?? 'local';
  const spawnTask = [
    `你是新 harness session。第一动作读 ${handoverRelativePath} @ commit ${taskCommitSha}。`,
    `严格按 ${COLD_START_PATH} 的 7 步清单冷启。`,
    `前任 session lineage_depth=${lineageDepth}，你是第 ${lineageDepth + 1} 代。`,
  ].join('\n');

  let spawnResult = null;
  if (!dryRun) {
    try {
      spawnResult = await ipcSpawn({
        name: 'harness',
        task: spawnTask,
        host: spawnHost,
        model: spawnModel,
      });
    } catch (error) {
      spawnResult = {
        spawned: false,
        error: error?.message ?? String(error),
      };
    }
    if (pushError) {
      spawnResult = {
        ...(spawnResult ?? {}),
        pushError,
      };
    }
  }

  if (commitSha) {
    lineage.record({
      childName: 'harness',
      parentName: 'harness',
      parentSessionId: commitSha,
      reason: handoverReason,
    });
  }

  return {
    triggered: true,
    handoverFile: handoverFilePath,
    commitSha,
    spawnResult,
    lineageDepth,
    handoverReason,
  };
}
