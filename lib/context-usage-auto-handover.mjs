import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const DEFAULT_CONTEXT_WINDOW = 200_000;
const IN_FLIGHT_STATUSES = new Set(['in-flight', 'in_flight', 'running', 'started', 'pending']);

function errorMessage(error) {
  return error?.message ?? String(error);
}

function clampPct(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function usageTokenCount(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const fields = [
    'input_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
    'output_tokens',
  ];
  const total = fields.reduce((sum, field) => sum + Math.max(0, Number(usage[field]) || 0), 0);
  return total > 0 ? total : null;
}

function extractUsage(candidate) {
  return candidate?.usage ?? candidate?.message?.usage ?? candidate?.response?.usage ?? null;
}

function parseTranscriptTokenPct(content, contextWindow) {
  let latestTokens = null;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const tokens = usageTokenCount(extractUsage(JSON.parse(line)));
      if (tokens !== null) latestTokens = tokens;
    } catch {}
  }
  if (latestTokens === null) latestTokens = Buffer.byteLength(content, 'utf8') / 4;
  return clampPct((latestTokens / contextWindow) * 100);
}

export function estimateContextPctFromTranscript(transcriptPath, options = {}) {
  if (!transcriptPath || !existsSync(transcriptPath)) return 0;
  const contextWindow = Number(options.contextWindow) || DEFAULT_CONTEXT_WINDOW;
  try {
    return parseTranscriptTokenPct(readFileSync(transcriptPath, 'utf8'), contextWindow);
  } catch {
    return 0;
  }
}

export function hasInFlightCodexTask(reportsDir = join(process.cwd(), 'reports', 'codex-runs')) {
  if (!existsSync(reportsDir)) return false;
  let entries;
  try {
    entries = readdirSync(reportsDir, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(reportsDir, entry.name);
    const lowerName = entry.name.toLowerCase();
    if (lowerName.includes('in-flight') || lowerName.includes('in_flight')) return true;
    if (!lowerName.endsWith('.json')) continue;
    try {
      const status = String(JSON.parse(readFileSync(path, 'utf8'))?.status ?? '').toLowerCase();
      if (IN_FLIGHT_STATUSES.has(status)) return true;
    } catch {}
  }
  return false;
}

export function isGitTreeClean(cwd = process.cwd()) {
  try {
    const output = execFileSync('git', ['status', '--porcelain'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.trim() === '';
  } catch {
    return false;
  }
}

export function createMinimalTaskUnitCompleteChecker({
  getPendingOutgoingCount,
  isGitTreeClean: checkGitTreeClean = () => isGitTreeClean(),
  hasInFlightCodexTask: checkInFlightCodexTask = () => hasInFlightCodexTask(),
} = {}) {
  return function isMinimalTaskUnitComplete() {
    const signals = [
      (() => Number(getPendingOutgoingCount?.() ?? 0) === 0)(),
      checkGitTreeClean(),
      !checkInFlightCodexTask(),
    ];
    return signals.filter(Boolean).length >= 2;
  };
}

export function createContextUsageAutoHandover({
  threshold = 50,
  estimateContextPct,
  isMinimalTaskUnitComplete,
  triggerHandover,
  cooldownMs = 5 * 60 * 1000,
  now = Date.now,
}) {
  let lastHandoverAt = 0;
  return {
    async tick(...args) {
      const ts = now();
      if (ts - lastHandoverAt < cooldownMs) return { skipped: 'cooldown' };

      let pct;
      try {
        pct = await estimateContextPct(...args);
      } catch (error) {
        return { skipped: 'estimate-failed', error: errorMessage(error) };
      }

      if (pct <= threshold) return { skipped: 'under-threshold', pct };
      if (!isMinimalTaskUnitComplete()) return { skipped: 'task-in-progress', pct };

      try {
        const result = await triggerHandover();
        lastHandoverAt = ts;
        return { triggered: true, pct, ...result };
      } catch (error) {
        return { skipped: 'trigger-failed', pct, error: errorMessage(error) };
      }
    },
  };
}

function safeName(value) {
  return String(value || 'session').replace(/[^a-zA-Z0-9_-]/g, '-');
}

function summarizeMessages(messages = []) {
  if (!Array.isArray(messages) || messages.length === 0) return '- no recent IPC messages';
  return messages.slice(-50).map((message) => {
    const from = message.from ?? message.sender ?? '?';
    const to = message.to ?? message.recipient ?? '?';
    const content = String(message.content ?? message.text ?? '').replace(/\s+/g, ' ').slice(0, 160);
    return `- ${from} -> ${to}: ${content}`;
  }).join('\n');
}

export function buildColdStartBrief({ name, handoverPath, recentMessages = [], createdAt = new Date() } = {}) {
  return [
    `ADR-010 context-usage auto handover cold start for ${name}`,
    '',
    `Self-handover doc: ${handoverPath}`,
    '',
    'Recent IPC drain summary:',
    summarizeMessages(recentMessages),
    '',
    'Cold start required 5 steps:',
    '1. date',
    '2. ipc_whoami / session-state',
    '3. whoami',
    '4. ipc_sessions',
    '5. ipc_recent_messages since=3600000 limit=50 and drain actionable backlog',
    '',
    `Created at: ${createdAt.toISOString()}`,
  ].join('\n');
}

export function createAtomicHandoverTrigger({
  name,
  cwd = process.cwd(),
  renameSession,
  spawnSession,
  dryRun = true,
  stderr = (message) => process.stderr.write(`${message}\n`),
  notifyPreSpawnReview = async () => {},
  getRecentMessages = async () => [],
  handoverDir = join(process.cwd(), 'handover'),
  now = Date.now,
  reviewDedupMs = 5 * 60 * 1000,
} = {}) {
  // wiring v7·dry-run review IPC 限流·同 session 5min dedup·防 portfolio inbox spam
  let lastReviewAt = 0;
  return async function triggerAtomicHandover() {
    const originalName = name;
    const oldName = `${originalName}-old`;
    const ts = now();
    mkdirSync(handoverDir, { recursive: true });
    const handoverPath = join(handoverDir, `HANDOVER-${safeName(originalName)}-${ts}.md`);
    const recentMessages = await getRecentMessages({ since: 3_600_000, limit: 50 });
    const coldStartBrief = buildColdStartBrief({
      name: originalName,
      handoverPath,
      recentMessages,
      createdAt: new Date(ts),
    });
    writeFileSync(handoverPath, coldStartBrief, 'utf8');

    const primarySpawn = {
      name: originalName,
      host: 'vscode-terminal',
      cwd,
      task: coldStartBrief,
      interactive: true,
    };
    const fallbackSpawn = {
      name: originalName,
      host: 'wt',
      cwd,
      task: coldStartBrief,
      interactive: true,
    };

    if (dryRun) {
      const review = {
        session: originalName,
        handoverPath,
        renamedTo: oldName,
        dryRun: true,
        primarySpawn: { ...primarySpawn, task: `[cold-start-brief:${handoverPath}]` },
        fallbackSpawn: { ...fallbackSpawn, task: `[cold-start-brief:${handoverPath}]` },
      };
      stderr(`[context-usage-auto-handover] pre-spawn-review dry-run ${JSON.stringify(review)}`);
      // wiring v7·dedup 5min·log 总记录·IPC 限流防 spam
      const sinceLastReview = ts - lastReviewAt;
      if (sinceLastReview >= reviewDedupMs) {
        await notifyPreSpawnReview(review);
        lastReviewAt = ts;
        return { handoverPath, renamedTo: oldName, dryRun: true, preSpawnReview: review, ipcSent: true };
      }
      stderr(`[context-usage-auto-handover] pre-spawn-review dedup-skip session=${originalName} sinceLast=${sinceLastReview}ms < ${reviewDedupMs}ms`);
      return { handoverPath, renamedTo: oldName, dryRun: true, preSpawnReview: review, ipcSent: false, dedupSkipped: true };
    }

    const renameResult = await renameSession({ name: oldName });
    let spawnResult;
    try {
      spawnResult = await spawnSession(primarySpawn);
      if (spawnResult?.error || spawnResult?.spawned === false) {
        spawnResult = await spawnSession(fallbackSpawn);
      }
    } catch {
      spawnResult = await spawnSession(fallbackSpawn);
    }

    return { handoverPath, renamedTo: oldName, renameResult, spawnResult };
  };
}
