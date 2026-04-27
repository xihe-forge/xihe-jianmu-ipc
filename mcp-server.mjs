#!/usr/bin/env node
/**
 * mcp-server.mjs — IPC MCP Server
 *
 * Launched by Claude Code via stdio.
 * Connects to the IPC Hub via WebSocket and exposes ipc_send /
 * ipc_sessions tools through the MCP protocol via the official SDK.
 *
 * stdout: MCP SDK transport (Content-Length framed JSON-RPC)
 * stderr: all logging
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createChannelNotifier } from './lib/channel-notification.mjs';
import { createMcpTools } from './lib/mcp-tools.mjs';
import { estimateContextPctFromTranscript } from './lib/context-usage-auto-handover.mjs';
import { getClaudeDir, getHomeDir } from './lib/claude-paths.mjs';
import { createRegisterMessage } from './lib/protocol.mjs';
import {
  DEFAULT_PORT,
  HUB_AUTOSTART_TIMEOUT,
  HUB_AUTOSTART_RETRY_INTERVAL,
} from './lib/constants.mjs';
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync, renameSync, unlinkSync, rmdirSync } from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import http from 'http';

// ---------------------------------------------------------------------------
// Project directory (needed for hub autostart)
// ---------------------------------------------------------------------------
const PROJECT_DIR = dirname(fileURLToPath(import.meta.url));

const MCP_TRACE_LOG = join(
  PROJECT_DIR,
  'data',
  `mcp-trace-${(process.env.IPC_NAME || 'unknown').replace(/[^\w.-]/g, '_')}.log`,
);
const MCP_TRACE_ENABLED = process.env.IPC_MCP_TRACE_DISABLE !== '1';
let mcpTraceSizeWarningShown = false;
try { mkdirSync(dirname(MCP_TRACE_LOG), { recursive: true }); } catch {}

function mcpTrace(event, detail = {}) {
  if (!MCP_TRACE_ENABLED) return;
  try {
    if (!mcpTraceSizeWarningShown && existsSync(MCP_TRACE_LOG) && statSync(MCP_TRACE_LOG).size > 50 * 1024 * 1024) {
      mcpTraceSizeWarningShown = true;
      process.stderr.write(`[ipc] warning: MCP trace log exceeds 50MB: ${MCP_TRACE_LOG}\n`);
    }
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      ipc_name: process.env.IPC_NAME || null,
      event,
      ...detail,
    }) + '\n';
    appendFileSync(MCP_TRACE_LOG, line, { encoding: 'utf8' });
  } catch {
    // Trace failures must never crash MCP server.
  }
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
// Priority: IPC_NAME (explicit) > IPC_DEFAULT_NAME (.mcp.json) > auto-generated
let IPC_NAME = process.env.IPC_NAME || process.env.IPC_DEFAULT_NAME || `session-${process.pid}`;
if (!process.env.IPC_NAME && !process.env.IPC_DEFAULT_NAME) {
  process.stderr.write(`[ipc] IPC_NAME not set, using auto-generated: ${IPC_NAME}\n`);
}

let IPC_PORT = parseInt(process.env.IPC_PORT ?? String(DEFAULT_PORT), 10);
const AUTH_TOKEN = process.env.IPC_AUTH_TOKEN || '';
let lastContextUsagePct = null;
let contextUsagePctTimer = null;
const SELF_DETECTION_WINDOW_MS = 60_000;

function getPidSessionJsonPath({ pid = process.pid, homeDir = null, env = process.env } = {}) {
  return join(getClaudeDir({ homeDir, env }), 'sessions', `${pid}.json`);
}

function encodeClaudeProjectPath(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return null;
  return cwd.replace(/\\/g, '-').replace(/\//g, '-').replace(/:/g, '-');
}

function getSelfCacheDir(options = {}) {
  return join(getClaudeDir(options), 'mcp-server-cache');
}

function getSelfCachePath({ ppid = process.ppid, homeDir = null, env = process.env, ipcName = IPC_NAME } = {}) {
  return join(getSelfCacheDir({ homeDir, env }), `parent-${ppid}-${ipcName}.json`);
}

function loadCachedSelfTranscript(options = {}) {
  const cachePath = getSelfCachePath(options);
  if (!existsSync(cachePath)) return null;
  try {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (typeof cached?.transcriptPath === 'string' && existsSync(cached.transcriptPath)) {
      return cached.transcriptPath;
    }
  } catch {}
  return null;
}

function persistSelfTranscript({ transcriptPath, sessionId }, options = {}) {
  if (!transcriptPath) return;
  try {
    const cacheDir = getSelfCacheDir(options);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(getSelfCachePath(options), JSON.stringify({
      transcriptPath,
      sessionId,
      detectedAt: Date.now(),
      ppid: options.ppid ?? process.ppid,
      ipcName: options.ipcName ?? IPC_NAME,
    }), 'utf8');
  } catch {}
}

function detectSelfTranscriptByBirthtime({ cwd, homeDir = null, env = process.env, now = Date.now } = {}) {
  const projectDir = encodeClaudeProjectPath(cwd);
  if (!projectDir) return null;
  const transcriptsDir = join(getClaudeDir({ homeDir, env }), 'projects', projectDir);
  if (!existsSync(transcriptsDir)) return null;

  const startTs = now();
  let bestCandidate = null;
  try {
    for (const entry of readdirSync(transcriptsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const transcriptPath = join(transcriptsDir, entry.name);
      try {
        const stat = statSync(transcriptPath);
        const birthMs = stat.birthtimeMs || stat.ctimeMs || 0;
        const ageMs = startTs - birthMs;
        if (ageMs >= 0 && ageMs < SELF_DETECTION_WINDOW_MS) {
          if (!bestCandidate || ageMs < bestCandidate.ageMs) {
            bestCandidate = {
              transcriptPath,
              sessionId: entry.name.replace(/\.jsonl$/, ''),
              ageMs,
            };
          }
        }
      } catch {}
    }
  } catch {}
  return bestCandidate;
}

export function findSelfTranscriptPath({ pid = process.pid, cwd = process.cwd(), homeDir = null, env = process.env, now = Date.now, ppid = process.ppid } = {}) {
  const envPath = env.CLAUDE_TRANSCRIPT_PATH || env.TRANSCRIPT_PATH;
  if (envPath) return envPath;

  const cacheOptions = { ppid, homeDir, env, ipcName: env.IPC_NAME || env.IPC_DEFAULT_NAME || IPC_NAME };
  const cached = loadCachedSelfTranscript(cacheOptions);
  if (cached) return cached;

  const pidSessionPath = getPidSessionJsonPath({ pid, homeDir, env });
  try {
    if (existsSync(pidSessionPath)) {
      const state = JSON.parse(readFileSync(pidSessionPath, 'utf8'));
      if (typeof state?.transcriptPath === 'string' && state.transcriptPath.trim() !== '') {
        persistSelfTranscript({ transcriptPath: state.transcriptPath, sessionId: state?.sessionId ?? '' }, cacheOptions);
        return state.transcriptPath;
      }
      const projectDir = encodeClaudeProjectPath(state?.cwd || cwd);
      if (projectDir && typeof state?.sessionId === 'string' && state.sessionId.trim() !== '') {
        const transcriptPath = join(getClaudeDir({ homeDir, env }), 'projects', projectDir, `${state.sessionId}.jsonl`);
        persistSelfTranscript({ transcriptPath, sessionId: state.sessionId }, cacheOptions);
        return transcriptPath;
      }
    }
  } catch {}

  const detected = detectSelfTranscriptByBirthtime({ cwd, homeDir, env, now });
  if (detected) {
    persistSelfTranscript(detected, cacheOptions);
    return detected.transcriptPath;
  }

  return null;
}

function estimateCurrentContextPct(args = {}) {
  const pct = estimateContextPctFromTranscript(args.transcriptPath || findSelfTranscriptPath(args), args);
  lastContextUsagePct = pct;
  return pct;
}

export function createContextUsageUpdateMessage({ name = IPC_NAME, contextUsagePct = lastContextUsagePct } = {}) {
  return {
    type: 'update',
    name,
    contextUsagePct,
  };
}

export function pushContextUsagePctUpdate({ send = wsSend, stderrLog = (message) => process.stderr.write(message), args = {} } = {}) {
  try {
    const contextUsagePct = estimateCurrentContextPct(args);
    send(createContextUsageUpdateMessage({ contextUsagePct }));
    return { ok: true, contextUsagePct };
  } catch (error) {
    stderrLog(`[ipc] context usage update failed: ${error?.message ?? error}\n`);
    return { ok: false, error: error?.message ?? String(error) };
  }
}

function startContextUsagePctTimer() {
  if (contextUsagePctTimer) return contextUsagePctTimer;
  contextUsagePctTimer = setInterval(() => {
    pushContextUsagePctUpdate();
  }, 60_000);
  contextUsagePctTimer.unref?.();
  return contextUsagePctTimer;
}

function createCurrentRegisterMessage() {
  return createRegisterMessage({
    name: IPC_NAME,
    pid: process.pid,
    cwd: process.cwd(),
    contextUsagePct: lastContextUsagePct ?? estimateCurrentContextPct(),
  });
}

// ---------------------------------------------------------------------------
// Host auto-detection (WSL2 support)
// ---------------------------------------------------------------------------
function detectHost() {
  if (process.env.IPC_HUB_HOST) return process.env.IPC_HUB_HOST;

  if (process.platform === 'linux' && existsSync('/etc/resolv.conf')) {
    try {
      const content = readFileSync('/etc/resolv.conf', 'utf8');
      for (const line of content.split('\n')) {
        const match = line.match(/^nameserver\s+([\d.]+)/);
        if (match) {
          process.stderr.write(`[ipc] WSL2 detected, using Windows host: ${match[1]}\n`);
          return match[1];
        }
      }
    } catch {
      // fall through to default
    }
  }

  return '127.0.0.1';
}

let HOST = detectHost();

// ---------------------------------------------------------------------------
// WebSocket state
// ---------------------------------------------------------------------------
let ws = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = Infinity; // never give up
const RECONNECT_BASE_DELAY = 3000;
const RECONNECT_MAX_DELAY = 60000;

const outgoingQueue = [];     // queued while disconnected

function disconnectWs() {
  if (!ws) return;
  try { ws.close(); } catch {}
  ws = null;
}

function reconnectHub() {
  reconnectAttempts = 0;
  connect();
}

// ---------------------------------------------------------------------------
// Create MCP Server with Channel capability
// ---------------------------------------------------------------------------
const server = new Server(
  { name: 'ipc', version: '0.1.0' },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
      },
    },
    instructions:
      'IPC messages from other sessions arrive as <channel> tags. When you receive one, read the content and act on it. If the sender expects a reply, use ipc_send to respond.',
  },
);

const channelNotifier = createChannelNotifier({
  serverNotify: (payload) => server.notification(payload),
  stderr: (message) => process.stderr.write(message),
  now: () => new Date(),
  trace: mcpTrace,
});

server.oninitialized = () => channelNotifier.markInitialized();

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------
const mcpTools = createMcpTools({
  getSessionName: () => IPC_NAME,
  setSessionName: (name) => { IPC_NAME = name; },
  getHubHost: () => HOST,
  setHubHost: (host) => { HOST = host; },
  getHubPort: () => IPC_PORT,
  setHubPort: (port) => { IPC_PORT = port; },
  getWs: () => ws,
  disconnectWs,
  reconnect: reconnectHub,
  getPendingOutgoingCount: () => outgoingQueue.length,
  wsSend,
  httpGet,
  httpPost,
  httpPatch,
  spawnSession,
  estimateContextPct: estimateCurrentContextPct,
  stderrLog: (message) => process.stderr.write(message),
});

server.setRequestHandler(ListToolsRequestSchema, async () => mcpTools.listTools());
server.setRequestHandler(CallToolRequestSchema, async (request) =>
  mcpTools.handleToolCall(request.params.name, request.params.arguments));

// ---------------------------------------------------------------------------
// spawnSession — launch a new Claude Code session (background or interactive)
// ---------------------------------------------------------------------------
function buildInteractiveCommand({ sessionName, model }) {
  const patchScript = join(PROJECT_DIR, 'bin', 'patch-channels.mjs').replace(/\\/g, '\\\\');
  const extraArgs = model ? ` --model ${model}` : '';
  return `$env:IPC_NAME='${sessionName}'; node '${patchScript}'; claude --dangerously-skip-permissions --dangerously-load-development-channels server:ipc${extraArgs}`;
}

const DEFAULT_CLAUDE_BIN = 'C:\\Users\\jolen\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
const DEFAULT_SPAWN_FALLBACK_CWD = 'D:/workspace/ai/research/xiheAi/xihe-tianshu-harness';
const VSCODE_URI_BRIEF_LIMIT_BYTES = 5 * 1024;

function getClaudeBinPath() {
  return process.env.CLAUDE_CLI_PATH || DEFAULT_CLAUDE_BIN;
}

function buildClaudeLaunchArgs({ model } = {}) {
  return `--dangerously-skip-permissions --dangerously-load-development-channels server:ipc${model ? ` --model ${model}` : ''}`;
}

export function buildCodexLaunchArgs({ sessionName, cmdEscaped = false }) {
  const ipcNameValue = cmdEscaped ? `\\"${sessionName}\\"` : `"${sessionName}"`;
  return `--dangerously-bypass-approvals-and-sandbox -c 'mcp_servers.jianmu-ipc.env.IPC_NAME=${ipcNameValue}'`;
}

function quoteForShellSingle(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function escapeForCmdQuotedArgument(value) {
  return String(value).replace(/"/g, '""');
}

function quoteForCmd(value) {
  return `"${escapeForCmdQuotedArgument(value)}"`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getClaudeJsonPath({ homeDir = null, env = process.env } = {}) {
  return join(getHomeDir({ homeDir, env }), '.claude.json');
}

export async function patchTrustForCwd(cwd, {
  homeDir = null,
  env = process.env,
  now = Date.now,
  retryMs = 25,
  timeoutMs = 5000,
} = {}) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return false;

  const configPath = getClaudeJsonPath({ homeDir, env });
  const lockDir = `${configPath}.lock`;
  const startedAt = now();
  let locked = false;

  while (!locked) {
    try {
      mkdirSync(lockDir);
      locked = true;
    } catch (error) {
      if (error?.code !== 'EEXIST' || now() - startedAt >= timeoutMs) throw error;
      await sleep(retryMs);
    }
  }

  const tmpPath = `${configPath}.${process.pid}.${now()}.tmp`;
  try {
    let config = {};
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, 'utf8').trim();
      config = raw ? JSON.parse(raw) : {};
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) config = {};
    if (!config.projects || typeof config.projects !== 'object' || Array.isArray(config.projects)) {
      config.projects = {};
    }
    if (!config.projects[cwd] || typeof config.projects[cwd] !== 'object' || Array.isArray(config.projects[cwd])) {
      config.projects[cwd] = {};
    }
    config.projects[cwd].hasTrustDialogAccepted = true;

    writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, configPath);
    return true;
  } finally {
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch {}
    try { rmdirSync(lockDir); } catch {}
  }
}

export function buildWtLaunchCommand({ sessionName, model }) {
  return `set "IPC_NAME=${sessionName}"&&${quoteForCmd(getClaudeBinPath())} ${buildClaudeLaunchArgs({ model })}`;
}

export function buildWtStartCommand({ sessionName, model, cwd }) {
  const claudeBin = getClaudeBinPath();
  const args = buildClaudeLaunchArgs({ model });
  // 去 `start ""` 包装（wt.exe 自身 detached）
  // 用 wt `--` 分隔符（wt 文档支持 wt new-tab [-d <dir>] -- <command>）替代 cmd /c 嵌套包装
  // cmd /k （keep open）调试期 console window 留下看错误 · production 后续改 /c
  return `wt.exe --window last new-tab --title ${quoteForCmd(sessionName)} --starting-directory ${quoteForCmd(cwd)} -- cmd /k "set "IPC_NAME=${sessionName}"&&${quoteForCmd(claudeBin)} ${args}"`;
}

export function buildWtSpawnArgs({ sessionName, model, cwd }) {
  const claudeBin = getClaudeBinPath();
  const args = buildClaudeLaunchArgs({ model });
  // ADR-010 mod 6 wiring v5 fix·atomic handoff 触发 wt 报 0x80070005·v4 cwd backslash normalize 不够·改用 cmd /k "cd /d <cwd> && ..." 嵌入 cwd 切换到 inner cmd·避开 wt --starting-directory + -- 分隔符 parser 问题（wt 把 cwd 与后续 arg 拼成单个 program path）
  const normalizedCwd = typeof cwd === 'string' ? cwd.replace(/\//g, '\\') : cwd;
  const cdSegment = normalizedCwd ? `cd /d ${quoteForCmd(normalizedCwd)} && ` : '';
  const innerCmd = `${cdSegment}set "IPC_NAME=${sessionName}"&&${quoteForCmd(claudeBin)} ${args}`;
  return [
    '--window', 'last',
    'new-tab',
    '--title', sessionName,
    '--', 'cmd', '/k', innerCmd,
  ];
}

export function buildCodexWtCommand({ sessionName, cwd }) {
  const normalizedCwd = typeof cwd === 'string' ? cwd.replace(/\//g, '\\') : cwd;
  const cdSegment = normalizedCwd ? `cd /d ${quoteForCmd(normalizedCwd)} && ` : '';
  const innerCmd = `${cdSegment}codex ${buildCodexLaunchArgs({ sessionName, cmdEscaped: true })}`;
  return [
    '--window', 'last',
    'new-tab',
    '--title', sessionName,
    '--', 'cmd', '/k', innerCmd,
  ];
}

function buildCodexExecArgs({ sessionName, prompt }) {
  return [
    'exec',
    '--dangerously-bypass-approvals-and-sandbox',
    '--skip-git-repo-check',
    '-c',
    `mcp_servers.jianmu-ipc.env.IPC_NAME="${sessionName}"`,
    prompt,
  ];
}

export function buildCodexExecCommand({ sessionName, prompt }) {
  const args = buildCodexExecArgs({ sessionName, prompt });
  return `codex exec ${args.slice(1, -1).map(quoteForShellSingle).join(' ')} ${quoteForShellSingle(args.at(-1))}`;
}

function countWindowsTerminalProcesses() {
  if (process.platform !== 'win32') {
    return Promise.resolve(null);
  }

  return new Promise((resolveCount) => {
    let stdout = '';
    const child = spawn('tasklist', ['/FI', 'IMAGENAME eq WindowsTerminal.exe', '/NH', '/FO', 'CSV'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.once('error', () => {
      resolveCount(null);
    });
    child.once('close', () => {
      const count = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^"WindowsTerminal\.exe"/i.test(line))
        .length;
      resolveCount(count);
    });
  });
}

function scheduleWtSilentFailureProbe({ baselineCount }) {
  if (baselineCount !== 0) {
    return;
  }

  const timer = setTimeout(async () => {
    const afterCount = await countWindowsTerminalProcesses();
    if (afterCount === 0) {
      process.stderr.write('[ipc] wt spawn silent-failure: no WindowsTerminal.exe process detected after start\n');
    }
  }, 500);
  if (typeof timer?.unref === 'function') {
    timer.unref();
  }
}

function maskEnvValue(key, value) {
  if (/(KEY|TOKEN|SECRET|PASSWORD)/i.test(String(key))) {
    return '***';
  }
  return String(value);
}

function normalizeDisplayPath(value) {
  return String(value).replace(/\\/g, '/');
}

function readIpcAuthTokenFromMcpConfig(cwd) {
  if (!cwd) {
    return null;
  }

  const configPath = join(cwd, '.mcp.json');
  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    const token = parsed?.mcpServers?.ipc?.env?.IPC_AUTH_TOKEN;
    return typeof token === 'string' && token.trim() !== ''
      ? token.trim()
      : null;
  } catch {
    return null;
  }
}

function maskToken(token) {
  return `${String(token).slice(0, 10)}...`;
}

function buildOtherMaskedEnv(env = {}) {
  return Object.entries(env)
    .filter(([key, value]) => key !== 'IPC_NAME' && key !== 'IPC_AUTH_TOKEN' && value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${maskEnvValue(key, value)}`)
    .join(' ');
}

function buildSpawnFallbackContent({
  sessionName,
  task,
  reason = 'manual',
  cwd = DEFAULT_SPAWN_FALLBACK_CWD,
  taskHint = null,
  model,
  env = {},
}) {
  const iso = new Date().toISOString();
  const effectiveCwd = cwd || DEFAULT_SPAWN_FALLBACK_CWD;
  const claudeBin = getClaudeBinPath();
  const configIpcAuthToken = readIpcAuthTokenFromMcpConfig(effectiveCwd);
  const ipcAuthToken = configIpcAuthToken
    || (typeof env.IPC_AUTH_TOKEN === 'string' && env.IPC_AUTH_TOKEN.trim() !== '' ? env.IPC_AUTH_TOKEN.trim() : '');
  const otherMaskedEnv = buildOtherMaskedEnv(env);
  const envLine = `IPC_NAME=${sessionName}`
    + `${ipcAuthToken ? ` IPC_AUTH_TOKEN=${maskToken(ipcAuthToken)}${configIpcAuthToken ? ' (完整 token 从 cwd .mcp.json 读)' : ''}` : ''}`
    + `${otherMaskedEnv ? ` ${otherMaskedEnv}` : ''}`;
  const defaultTaskHint = `续跑 handover/HANDOVER-${sessionName.toUpperCase()}-<ymdhm>.md @ commit <sha-7>`;
  return (
    `【jianmu-pm ${iso} · spawn-fallback】\n`
    + `cmdline: "${claudeBin}" ${buildClaudeLaunchArgs({ model })}\n`
    + `cwd: ${normalizeDisplayPath(effectiveCwd)}\n`
    + `env: ${envLine}\n`
    + `task_hint: ${taskHint || task || defaultTaskHint}\n`
    + `post_spawn_action: 新 session 冷启清单 step 3 ipc_whoami → 若名非 ${sessionName} 调 ipc_rename ${sessionName}（借 pending_rebind 5s 宽限继承）\n`
    + `spawn_reason: ${reason}`
  );
}

async function sendSpawnFallbackIpc({
  sessionName,
  task,
  reason,
  cwd,
  taskHint,
  model,
  env = {},
}) {
  const content = buildSpawnFallbackContent({
    sessionName,
    task,
    reason,
    cwd,
    taskHint,
    model,
    env,
  });

  await httpPost(`http://${HOST}:${IPC_PORT}/send`, {
    from: IPC_NAME,
    to: 'tech-worker',
    topic: 'spawn-fallback',
    content,
  });

  return content;
}

export async function spawnSession({
  name: sessionName,
  task,
  interactive,
  model,
  runtime = 'claude',
  host,
  dryRun = false,
  cwd = null,
}) {
  // Sanitize session name — allow only alphanumeric, underscore, hyphen
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionName)) {
    throw new Error(`Invalid session name: only letters, numbers, underscore and hyphen allowed`);
  }

  const ipcEnv = {
    ...process.env,
    IPC_NAME: sessionName,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };

  // Build the system instruction that tells the spawned session about IPC
  const ipcInstruction = `Your IPC session name is "${sessionName}". You are connected to the IPC hub. When you complete your task, report back using ipc_send(to="${IPC_NAME}", content="your result"). You can also receive messages from other sessions.`;

  const fullPrompt = `${ipcInstruction}\n\nTask: ${task}`;
  const requestedHost = host;
  const spawnCwd = cwd || process.cwd();

  if (runtime === 'codex' && requestedHost === 'wt') {
    if (process.platform !== 'win32') {
      const commandHint = `wt.exe ${buildCodexWtCommand({ sessionName, cwd: spawnCwd }).join(' ')}`;
      if (dryRun) {
        return {
          spawned: false,
          host: 'external',
          runtime: 'codex',
          fallbackIpcSent: false,
          dryRun: true,
          warning: 'wt is only supported on win32, downgraded to external',
          command_hint: commandHint,
          cwd: normalizeDisplayPath(spawnCwd),
        };
      }
      return {
        spawned: false,
        host: 'external',
        runtime: 'codex',
        fallbackIpcSent: false,
        warning: 'wt is only supported on win32, downgraded to external',
      };
    }

    const wtArgs = buildCodexWtCommand({ sessionName, cwd: spawnCwd });
    const commandHint = `wt.exe ${wtArgs.join(' ')}`;
    if (dryRun) {
      return {
        spawned: false,
        host: 'wt',
        runtime: 'codex',
        mode: 'interactive',
        dryRun: true,
        command_hint: commandHint,
        cwd: normalizeDisplayPath(spawnCwd),
      };
    }

    const baselineTerminalCount = await countWindowsTerminalProcesses();
    const child = spawn('wt.exe', wtArgs, {
      detached: true,
      stdio: 'ignore',
      env: ipcEnv,
      shell: false,
    });
    child.once('error', (error) => {
      process.stderr.write(`[ipc] codex wt spawn launch failed: ${error?.message ?? error}\n`);
    });
    child.unref();
    scheduleWtSilentFailureProbe({ baselineCount: baselineTerminalCount });
    process.stderr.write(`[ipc] spawned codex wt session "${sessionName}"\n`);
    return { name: sessionName, host: 'wt', runtime: 'codex', mode: 'interactive', spawned: true, status: 'spawned', pid: child.pid };
  }

  if (runtime === 'codex' && !interactive) {
    const codexArgs = buildCodexExecArgs({ sessionName, prompt: fullPrompt });
    const commandHint = buildCodexExecCommand({ sessionName, prompt: fullPrompt });
    if (dryRun) {
      return {
        name: sessionName,
        mode: 'background',
        host: requestedHost ?? 'legacy',
        runtime: 'codex',
        spawned: false,
        dryRun: true,
        command_hint: commandHint,
        cwd: normalizeDisplayPath(spawnCwd),
        exit_cleanup: 'hub session closes when codex exec exits',
      };
    }

    const child = spawn('codex', codexArgs, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: ipcEnv,
      cwd: spawnCwd,
      shell: false,
    });
    child.unref();

    child.stderr?.on('data', d => {
      process.stderr.write(`[ipc:${sessionName}] ${d.toString()}`);
    });
    child.on('exit', (code) => {
      process.stderr.write(`[ipc] codex background session "${sessionName}" exited (code=${code})\n`);
    });

    process.stderr.write(`[ipc] spawned codex background session "${sessionName}" (pid=${child.pid})\n`);
    return {
      name: sessionName,
      mode: 'background',
      host: requestedHost ?? 'legacy',
      runtime: 'codex',
      status: 'spawned',
      pid: child.pid,
      exit_cleanup: 'hub session closes when codex exec exits',
    };
  }

  if (requestedHost === 'wt') {
    if (process.platform !== 'win32') {
      const content = buildSpawnFallbackContent({
        sessionName,
        task,
        cwd: spawnCwd,
        taskHint: task,
        model,
      });
      if (dryRun) {
        return {
          spawned: false,
          host: 'external',
          fallbackIpcSent: false,
          dryRun: true,
          warning: 'wt is only supported on win32, downgraded to external',
          ipc_content: content,
        };
      }
      await sendSpawnFallbackIpc({
        sessionName,
        task,
        cwd: spawnCwd,
        taskHint: task,
        model,
      });
      return {
        spawned: false,
        host: 'external',
        fallbackIpcSent: true,
        warning: 'wt is only supported on win32, downgraded to external',
      };
    }

    await patchTrustForCwd(spawnCwd);
    const wtArgs = buildWtSpawnArgs({ sessionName, model, cwd: spawnCwd });
    const commandHint = `wt.exe ${wtArgs.join(' ')}`;
    if (dryRun) {
      return {
        spawned: false,
        host: 'wt',
        dryRun: true,
        command_hint: commandHint,
        cwd: normalizeDisplayPath(spawnCwd),
      };
    }

    const baselineTerminalCount = await countWindowsTerminalProcesses();
    const child = spawn('wt.exe', wtArgs, {
      detached: true,
      stdio: 'ignore',
      env: ipcEnv,
      shell: false,
    });
    child.once('error', (error) => {
      process.stderr.write(`[ipc] wt spawn launch failed: ${error?.message ?? error}\n`);
    });
    child.unref();
    scheduleWtSilentFailureProbe({ baselineCount: baselineTerminalCount });
    process.stderr.write(`[ipc] spawned wt session "${sessionName}"\n`);
    return { name: sessionName, host: 'wt', spawned: true, status: 'spawned', pid: child.pid };
  }

  if (requestedHost === 'vscode-terminal') {
    return {
      spawned: false,
      host: 'vscode-terminal',
      error: 'not implemented, use external',
    };
  }

  if (requestedHost === 'vscode-uri') {
    if (process.platform !== 'win32') {
      const content = buildSpawnFallbackContent({
        sessionName,
        task,
        cwd: spawnCwd,
        taskHint: task,
        model,
      });
      if (dryRun) {
        return {
          spawned: false,
          host: 'external',
          fallbackIpcSent: false,
          dryRun: true,
          warning: 'vscode-uri is Windows-only, downgraded to external',
          ipc_content: content,
        };
      }
      await sendSpawnFallbackIpc({
        sessionName,
        task,
        cwd: spawnCwd,
        taskHint: task,
        model,
      });
      return {
        spawned: false,
        host: 'external',
        fallbackIpcSent: true,
        warning: 'vscode-uri is Windows-only, downgraded to external',
      };
    }

    const briefByteLength = Buffer.byteLength(task, 'utf8');
    if (briefByteLength > VSCODE_URI_BRIEF_LIMIT_BYTES) {
      return {
        spawned: false,
        host: 'vscode-uri',
        error: `brief exceeds 5KB limit for vscode-uri (${briefByteLength} bytes)`,
      };
    }

    const uri = `vscode://anthropic.claude-code/open?prompt=${encodeURIComponent(fullPrompt)}`;
    const commandHint = `cmd.exe /c start "" "${uri}"`;
    const uriByteLength = Buffer.byteLength(uri, 'utf8');
    if (dryRun) {
      return {
        spawned: false,
        host: 'vscode-uri',
        dryRun: true,
        command_hint: commandHint,
        uri,
        uri_byte_length: uriByteLength,
      };
    }

    const child = spawn('cmd.exe', ['/c', 'start', '', uri], {
      detached: true,
      stdio: 'ignore',
      env: ipcEnv,
    });
    child.once('error', (error) => {
      process.stderr.write(`[ipc] vscode-uri spawn launch failed: ${error?.message ?? error}\n`);
    });
    child.unref();
    process.stderr.write(`[ipc] spawned vscode-uri session "${sessionName}"\n`);
    return { name: sessionName, host: 'vscode-uri', spawned: true, status: 'spawned', pid: child.pid };
  }

  if (requestedHost === 'external' && !interactive) {
    const content = buildSpawnFallbackContent({
      sessionName,
      task,
      cwd: spawnCwd,
      taskHint: task,
      model,
    });
    if (dryRun) {
      return {
        spawned: false,
        host: 'external',
        fallbackIpcSent: false,
        dryRun: true,
        ipc_content: content,
      };
    }

    await sendSpawnFallbackIpc({
      sessionName,
      task,
      cwd: spawnCwd,
      taskHint: task,
      model,
    });
    return {
      spawned: false,
      host: 'external',
      fallbackIpcSent: true,
      command_hint: content,
    };
  }

  if (interactive) {
    // Interactive mode: open a new terminal window with Claude Code
    // Patch Claude Code to skip dev channels warning, then launch
    const psCommand = buildInteractiveCommand({ sessionName, model });

    if (process.platform === 'win32') {
      // Windows: use cmd /c start to open new PowerShell window
      spawn('cmd', ['/c', 'start', 'powershell', '-NoExit', '-Command', psCommand], {
        detached: true,
        stdio: 'ignore',
        env: ipcEnv,
      }).unref();
    } else {
      // Linux/WSL2: prefer calling powershell.exe via WSL interop to open a Windows terminal
      const patchScript = join(PROJECT_DIR, 'bin', 'patch-channels.mjs').replace(/\\/g, '\\\\');
      const extraArgs = model ? ` --model ${model}` : '';

      // Detect WSL2: check if powershell.exe is reachable (sync)
      let isWSL2 = false;
      try {
        const { execSync: _execSync } = await import('node:child_process');
        _execSync('which powershell.exe', { stdio: 'ignore' });
        isWSL2 = true;
      } catch { /* not WSL2 or no powershell.exe */ }

      if (isWSL2) {
        // WSL2: write a temp .ps1 script and execute it via wt.exe / powershell.exe
        // Avoids all quoting issues with inline -Command strings
        const { writeFileSync: _wfs } = await import('node:fs');
        const wslToWin = (p) => p.replace(/^\/mnt\/([a-z])\//, (_, d) => `${d.toUpperCase()}:\\`).replace(/\//g, '\\');
        const patchScriptWin = wslToWin(join(PROJECT_DIR, 'bin', 'patch-channels.mjs'));
        const mcpServerWin = wslToWin(join(PROJECT_DIR, 'mcp-server.mjs'));
        const winHome = process.env.USERPROFILE || `C:\\Users\\${process.env.USERNAME || 'user'}`;
        const claudeCmd = `${winHome}\\AppData\\Roaming\\npm\\claude.ps1`;
        // Write to Windows Temp dir so PowerShell can access it without UNC path issues
        const winUser = process.env.USERNAME || process.env.USER || 'user';
        const winTempDir = `/mnt/c/Users/${winUser}/AppData/Local/Temp`;
        const ts = Date.now();
        const tmpPs1Wsl = join(winTempDir, `ipc-spawn-${sessionName}-${ts}.ps1`);
        const tmpMcpWsl = join(winTempDir, `ipc-mcp-${sessionName}-${ts}.json`);
        const tmpPs1Win = wslToWin(tmpPs1Wsl);
        const tmpMcpWin = wslToWin(tmpMcpWsl);
        // Write .mcp.json to CC working dir (~/) so it's auto-loaded by CC
        // This is more reliable than --mcp-config which may be processed after channel validation
        const mcpConfig = {
          mcpServers: {
            ipc: {
              command: 'node',
              args: [mcpServerWin],
              env: { IPC_NAME: sessionName, IPC_HUB_AUTOSTART: 'true' },
            },
          },
        };
        const mcpConfigJson = JSON.stringify(mcpConfig, null, 2);
        _wfs(tmpMcpWsl, mcpConfigJson, 'utf8');
        // Also write to CC's working dir (.mcp.json in home) for auto-load
        const homeMcpWsl = `/mnt/c/Users/${winUser}/.mcp.json`;
        _wfs(homeMcpWsl, mcpConfigJson, 'utf8');
        const ps1Content = [
          '\uFEFF', // UTF-8 BOM — prevents PowerShell from garbling non-ASCII
          `$env:IPC_NAME = '${sessionName}'`,
          `node '${patchScriptWin}'`,
          `& '${claudeCmd}' --dangerously-skip-permissions --dangerously-load-development-channels server:ipc${extraArgs}`,
        ].join('\r\n');
        _wfs(tmpPs1Wsl, ps1Content, 'utf8');

        // Try wt.exe (Windows Terminal) first — cleaner UX
        let wtAvailable = false;
        try {
          const { execSync: _es2 } = await import('node:child_process');
          _es2('which wt.exe', { stdio: 'ignore' });
          wtAvailable = true;
        } catch { /* no wt.exe */ }

        if (wtAvailable) {
          spawn('wt.exe', ['new-tab', '--title', sessionName, 'powershell.exe', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', tmpPs1Win], {
            detached: true,
            stdio: 'ignore',
            env: ipcEnv,
          }).unref();
        } else {
          spawn('powershell.exe', ['-NoExit', '-ExecutionPolicy', 'Bypass', '-File', tmpPs1Win], {
            detached: true,
            stdio: 'ignore',
            env: ipcEnv,
          }).unref();
        }
      } else {
        // Native Linux: try common terminal emulators
        const terminals = ['gnome-terminal', 'xterm', 'konsole'];
        let spawned = false;
        for (const term of terminals) {
          try {
            spawn(term, ['--', 'bash', '-c', `IPC_NAME='${sessionName}' claude --dangerously-skip-permissions --dangerously-load-development-channels server:ipc`], {
              detached: true,
              stdio: 'ignore',
              env: ipcEnv,
            }).unref();
            spawned = true;
            break;
          } catch { continue; }
        }
        if (!spawned) {
          spawn('bash', ['-c', `IPC_NAME='${sessionName}' claude --dangerously-skip-permissions --dangerously-load-development-channels server:ipc`], {
            detached: true,
            stdio: 'ignore',
            env: ipcEnv,
          }).unref();
        }
      }
    }

    process.stderr.write(`[ipc] spawned interactive session "${sessionName}" in new terminal\n`);
    return { name: sessionName, mode: 'interactive', host: requestedHost ?? 'legacy', status: 'spawned' };

  } else {
    // Background mode: run claude -p (one-shot, non-interactive)
    const claudeArgs = ['-p', '--dangerously-skip-permissions'];
    if (model) claudeArgs.push('--model', model);
    claudeArgs.push(fullPrompt);

    const child = spawn('claude', claudeArgs, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: ipcEnv,
      shell: true,
    });
    child.unref();

    // Log stdout/stderr for debugging
    let output = '';
    child.stdout?.on('data', d => { output += d.toString(); });
    child.stderr?.on('data', d => {
      process.stderr.write(`[ipc:${sessionName}] ${d.toString()}`);
    });
    child.on('exit', (code) => {
      process.stderr.write(`[ipc] background session "${sessionName}" exited (code=${code})\n`);
    });

    process.stderr.write(`[ipc] spawned background session "${sessionName}" (pid=${child.pid})\n`);
    return {
      name: sessionName,
      mode: 'background',
      host: requestedHost ?? 'legacy',
      status: 'spawned',
      pid: child.pid,
    };
  }
}

// ---------------------------------------------------------------------------
// Channel notification push
// ---------------------------------------------------------------------------
function pushChannelNotification(msg) {
  channelNotifier.pushChannelNotification(msg);
}

// ---------------------------------------------------------------------------
// Hub autostart
// ---------------------------------------------------------------------------
function autostartHub() {
  process.stderr.write('[ipc] attempting to autostart hub...\n');
  try {
    // Forward OpenClaw config to Hub so /hooks/wake works out of the box
    const hubEnv = { ...process.env };
    if (process.env.OPENCLAW_URL) hubEnv.OPENCLAW_URL = process.env.OPENCLAW_URL;
    if (process.env.OPENCLAW_TOKEN) hubEnv.OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN;
    const child = spawn(process.execPath, [join(PROJECT_DIR, 'hub.mjs')], {
      cwd: PROJECT_DIR,
      detached: true,
      stdio: 'ignore',
      env: hubEnv,
    });
    child.unref();
    process.stderr.write(`[ipc] hub spawned (pid ${child.pid})\n`);
  } catch (err) {
    process.stderr.write(`[ipc] failed to spawn hub: ${err?.message ?? err}\n`);
  }
}

// ---------------------------------------------------------------------------
// WebSocket connection helpers
// ---------------------------------------------------------------------------
function buildWsUrl() {
  let url = `ws://${HOST}:${IPC_PORT}/ws?name=${encodeURIComponent(IPC_NAME)}`;
  if (AUTH_TOKEN) url += `&token=${encodeURIComponent(AUTH_TOKEN)}`;
  return url;
}

function flushOutgoingQueue() {
  while (outgoingQueue.length > 0 && ws?.readyState === 1 /* OPEN */) {
    const msg = outgoingQueue.shift();
    try {
      ws.send(msg);
    } catch (err) {
      process.stderr.write(`[ipc] failed to flush queued message: ${err?.message ?? err}\n`);
      outgoingQueue.unshift(msg); // put it back
      break;
    }
  }
}

function scheduleReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    process.stderr.write('[ipc] max reconnect attempts reached, giving up\n');
    return;
  }

  const delay = Math.min(
    RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts),
    RECONNECT_MAX_DELAY,
  );
  reconnectAttempts++;
  mcpTrace('ws_reconnect_scheduled', { delay, attempt: reconnectAttempts });
  process.stderr.write(`[ipc] reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})\n`);
  setTimeout(connect, delay);
}

// ---------------------------------------------------------------------------
// Shared WebSocket message handler
// ---------------------------------------------------------------------------
function handleWsMessage(event) {
  mcpTrace('ws_inbound', { raw_len: event.data?.length ?? 0 });
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch {
    process.stderr.write('[ipc] received non-JSON message from hub\n');
    return;
  }

  mcpTrace('ws_message_parsed', {
    type: msg.type,
    from: msg.from,
    id: msg.id,
    topic: msg.topic,
    has_content: !!msg.content,
  });

  if (msg.type === 'message') {
    // Intercept feishu ping: reply directly without pushing to LLM (0 token)
    const isFeishuPing = msg.from?.startsWith('feishu') &&
      typeof msg.content === 'string' &&
      (msg.content.trim().toLowerCase() === 'ping' || msg.content.trim().toLowerCase() === '/ping');

    if (isFeishuPing) {
      mcpTrace('feishu_ping_intercepted', { msg_id: msg.id, from: msg.from });
      const replyTo = msg.from; // "feishu:jianmu-pm" or "feishu-group:oc_xxx"
      const pong = `pong (full chain: feishu → bridge → hub → ${IPC_NAME} → hub → feishu)`;
      const body = JSON.stringify(
        replyTo.startsWith('feishu-group:')
          ? { from: IPC_NAME, to: replyTo, content: pong }
          : { app: replyTo.split(':')[1], content: pong }
      );
      const path = replyTo.startsWith('feishu-group:') ? '/send' : '/feishu-reply';
      const req = http.request({
        hostname: HOST, port: IPC_PORT, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, () => {});
      req.on('error', () => {});
      req.write(body);
      req.end();
      process.stderr.write(`[ipc] feishu ping intercepted from ${msg.from}, pong sent (0 token)\n`);
      return; // Don't push to LLM
    }

    mcpTrace('channel_push_begin', {
      msg_id: msg.id,
      from: msg.from,
      mcp_initialized: channelNotifier.isInitialized(),
    });
    pushChannelNotification(msg);
    // Send ack back to Hub so the sender knows delivery succeeded
    if (msg.id) {
      wsSend({ type: 'ack', messageId: msg.id, from: IPC_NAME });
      mcpTrace('ack_sent', { msg_id: msg.id, confirmed_by: IPC_NAME });

      // Update pending-cards.json so feishu-bridge can advance task to stage 2
      try {
        const pcPath = join(PROJECT_DIR, 'data', 'pending-cards.json');
        if (existsSync(pcPath)) {
          const pc = JSON.parse(readFileSync(pcPath, 'utf8'));
          let changed = false;
          for (const [, info] of Object.entries(pc)) {
            if (!info.tasks || !Array.isArray(info.tasks)) continue;
            for (const task of info.tasks) {
              // Match by hubMessageId if available, otherwise advance oldest stage-1 task
              if (task.stage < 2 && (task.hubMessageId === msg.id || task.id === msg.id || !task.hubMessageId)) {
                task.stage = 2;
                changed = true;
                break; // Only advance one task per ACK
              }
            }
          }
          if (changed) {
            writeFileSync(pcPath, JSON.stringify(pc));
            process.stderr.write(`[ipc] updated pending-cards.json: ACK from ${IPC_NAME} for ${msg.id}\n`);
          }
        }
      } catch {}
    }
    process.stderr.write(`[ipc] pushed channel notification from ${msg.from ?? '(unknown)'}\n`);
  } else if (msg.type === 'ack') {
    process.stderr.write(`[ipc] delivery confirmed: ${msg.messageId} by ${msg.confirmedBy}\n`);
  } else if (msg.type === 'inbox') {
    const messages = Array.isArray(msg.messages) ? msg.messages : [];
    for (const m of messages) {
      if (m.type === 'message') {
        mcpTrace('inbox_channel_push_begin', { msg_id: m.id, from: m.from });
        pushChannelNotification(m);
      }
    }
    process.stderr.write(`[ipc] pushed ${messages.length} buffered messages\n`);
  }

  process.stderr.write(`[ipc] received message from ${msg.from ?? '(unknown)'}\n`);
}

// ---------------------------------------------------------------------------
// Persistent reconnect loop (used after initial connection is established)
// ---------------------------------------------------------------------------
function connect() {
  const url = buildWsUrl();
  mcpTrace('ws_reconnect_attempt', { url });
  process.stderr.write(`[ipc] connecting to hub at ${url}\n`);

  let socket;
  try {
    socket = new WebSocket(url);
  } catch (err) {
    process.stderr.write(`[ipc] failed to create WebSocket: ${err?.message ?? err}\n`);
    scheduleReconnect();
    return;
  }

  socket.addEventListener('open', () => {
    mcpTrace('ws_reconnect_open', { url });
    process.stderr.write('[ipc] connected to hub\n');
    reconnectAttempts = 0;
    ws = socket;
    socket.send(JSON.stringify(createCurrentRegisterMessage()));
    flushOutgoingQueue();
  });

  socket.addEventListener('message', handleWsMessage);

  socket.addEventListener('close', (event) => {
    mcpTrace('ws_disconnect', { code: event.code, reason: event.reason });
    process.stderr.write(`[ipc] disconnected from hub (code=${event.code})\n`);
    ws = null;
    scheduleReconnect();
  });

  socket.addEventListener('error', (event) => {
    mcpTrace('ws_error', { message: event.message ?? 'unknown' });
    process.stderr.write(`[ipc] WebSocket error: ${event.message ?? 'unknown'}\n`);
    // 'close' fires after 'error', reconnect will be scheduled there
  });
}

// ---------------------------------------------------------------------------
// Initial connection with optional hub autostart
// ---------------------------------------------------------------------------
async function initialConnect() {
  return new Promise((resolve) => {
    let elapsed = 0;
    let autostartDone = false;

    function tryOnce() {
      const url = buildWsUrl();
      mcpTrace('ws_connect_attempt', { url });
      let socket;
      try {
        socket = new WebSocket(url);
      } catch {
        handleFailure();
        return;
      }

      const cleanup = () => {
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
      };

      const onOpen = () => {
        cleanup();
        mcpTrace('ws_connect_open', { url });
        process.stderr.write('[ipc] initial connection to hub succeeded\n');
        reconnectAttempts = 0;
        ws = socket;

        socket.send(JSON.stringify(createCurrentRegisterMessage()));
        flushOutgoingQueue();

        socket.addEventListener('message', handleWsMessage);

        socket.addEventListener('close', (ev) => {
          mcpTrace('ws_disconnect', { code: ev.code, reason: ev.reason });
          process.stderr.write(`[ipc] disconnected from hub (code=${ev.code})\n`);
          ws = null;
          scheduleReconnect();
        });

        socket.addEventListener('error', (ev) => {
          mcpTrace('ws_error', { message: ev.message ?? 'unknown' });
          process.stderr.write(`[ipc] WebSocket error: ${ev.message ?? 'unknown'}\n`);
        });

        resolve();
      };

      const onError = (ev) => {
        cleanup();
        mcpTrace('ws_connect_error', { message: ev?.message ?? 'unknown' });
        try { socket.close(); } catch { /* ignore */ }
        handleFailure();
      };

      socket.addEventListener('open', onOpen);
      socket.addEventListener('error', onError);
    }

    function handleFailure() {
      if (process.env.IPC_HUB_AUTOSTART !== 'false' && !autostartDone) {
        autostartDone = true;
        autostartHub();
      }

      elapsed += HUB_AUTOSTART_RETRY_INTERVAL;
      if (elapsed >= HUB_AUTOSTART_TIMEOUT) {
        process.stderr.write('[ipc] could not connect to hub within timeout, will retry in background\n');
        scheduleReconnect();
        resolve(); // continue starting the MCP server anyway
        return;
      }

      setTimeout(tryOnce, HUB_AUTOSTART_RETRY_INTERVAL);
    }

    tryOnce();
  });
}

// ---------------------------------------------------------------------------
// HTTP helper for /health endpoint
// ---------------------------------------------------------------------------
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (AUTH_TOKEN) headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;
    const req = http.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`invalid JSON from ${url}: ${body}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('timeout')); });
  });
}

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (AUTH_TOKEN) headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;
    const parsed = new URL(url);
    const req = http.request({ hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, method: 'POST', headers }, (res) => {
      let buf = '';
      res.on('data', (chunk) => { buf += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch { reject(new Error(`invalid JSON from ${url}: ${buf}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

function httpPatch(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (AUTH_TOKEN) headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;
    const parsed = new URL(url);
    const req = http.request({ hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, method: 'PATCH', headers }, (res) => {
      let buf = '';
      res.on('data', (chunk) => { buf += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch { reject(new Error(`invalid JSON from ${url}: ${buf}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// WebSocket send (with queueing on disconnect)
// ---------------------------------------------------------------------------
function wsSend(payload) {
  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
  if (ws?.readyState === 1 /* OPEN */) {
    ws.send(serialized);
    return true;
  }
  // WS not connected — try HTTP fallback
  const msg = typeof payload === 'object' ? payload : null;
  if (msg?.type === 'message' && msg.from && msg.to && msg.content) {
    httpPost(`http://${HOST}:${IPC_PORT}/send`, {
      from: msg.from, to: msg.to, content: msg.content, topic: msg.topic ?? null,
    }).then(res => {
      process.stderr.write(`[ipc] HTTP fallback: ${res?.ok ? 'sent' : 'failed'} (${msg.from} → ${msg.to})\n`);
    }).catch(err => {
      process.stderr.write(`[ipc] HTTP fallback failed: ${err?.message ?? err}\n`);
    });
    return false; // delivered via HTTP async, not guaranteed
  }
  // Non-message payloads (subscribe, etc) — queue for later
  outgoingQueue.push(serialized);
  if (outgoingQueue.length > 100) {
    outgoingQueue.shift();
    process.stderr.write('[ipc] outgoing queue full, dropped oldest message\n');
  }
  process.stderr.write('[ipc] hub not connected, message queued\n');
  return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  process.stderr.write(`[ipc] starting MCP server as "${IPC_NAME}"\n`);

  // Start MCP transport FIRST so Claude Code handshake doesn't timeout
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write('[ipc] MCP server ready, connecting to hub in background...\n');

  // Connect to hub in background (non-blocking)
  initialConnect().then(() => {
    process.stderr.write(`[ipc] hub connection established (session="${IPC_NAME}", hub=${HOST}:${IPC_PORT})\n`);
    startContextUsagePctTimer();
  }).catch((err) => {
    process.stderr.write(`[ipc] hub connection failed: ${err?.message ?? err}\n`);
    startContextUsagePctTimer();
  });
}

// ---------------------------------------------------------------------------
// Source file change detection: poll own + lib/*.mjs mtime, exit on change
// ---------------------------------------------------------------------------
export function createSourceChangeWatcher({
  rootDir = PROJECT_DIR,
  libGlob = ['lib/*.mjs'],
  intervalMs = 5000,
  debounceMs = 500,
  exitFn = (code) => process.exit(code),
  statFn = statSync,
  logFn = (msg) => process.stderr.write(msg),
} = {}) {
  const watchFiles = new Map();
  const addWatchFile = (filePath) => {
    try {
      watchFiles.set(filePath, statFn(filePath).mtimeMs);
    } catch {}
  };

  addWatchFile(join(rootDir, 'mcp-server.mjs'));

  if (Array.isArray(libGlob) && libGlob.includes('lib/*.mjs')) {
    const libDir = join(rootDir, 'lib');
    try {
      for (const entry of readdirSync(libDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue;
        addWatchFile(join(libDir, entry.name));
      }
    } catch {}
  }

  let stopped = false;
  let pendingExitTimer = null;

  const tick = () => {
    if (stopped) return;
    let detectedChange = null;
    for (const [filePath, oldMtime] of watchFiles) {
      try {
        const mtime = statFn(filePath).mtimeMs;
        if (oldMtime && mtime !== oldMtime) {
          detectedChange = filePath;
          watchFiles.set(filePath, mtime);
        }
      } catch {}
    }
    if (detectedChange && !pendingExitTimer) {
      logFn(`[ipc] source file changed: ${detectedChange}, exiting for hot reload (Claude Code MCP child respawn)
`);
      pendingExitTimer = setTimeout(() => {
        if (!stopped) exitFn(0);
      }, debounceMs);
      if (typeof pendingExitTimer.unref === 'function') pendingExitTimer.unref();
    }
  };

  const intervalHandle = setInterval(tick, intervalMs);
  if (typeof intervalHandle.unref === 'function') intervalHandle.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(intervalHandle);
      if (pendingExitTimer) {
        clearTimeout(pendingExitTimer);
        pendingExitTimer = null;
      }
    },
  };
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`[ipc] fatal: ${err?.message ?? err}\n`);
    process.exit(1);
  });

  createSourceChangeWatcher({ rootDir: PROJECT_DIR });
}
