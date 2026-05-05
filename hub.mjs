/**
 * hub.mjs — IPC WebSocket hub server（启动入口）
 * 纯启动逻辑：初始化状态、构建ctx、挂载模块。
 * 消息路由见 lib/router.mjs，HTTP端点见 lib/http-handlers.mjs。
 * Usage: node hub.mjs  |  Env: IPC_PORT
 */

// EPIPE防护
for (const stream of [process.stdout, process.stderr]) {
  const origWrite = stream.write.bind(stream);
  stream.write = function (...args) {
    try {
      return origWrite(...args);
    } catch (err) {
      if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') return true;
      throw err;
    }
  };
  stream.on('error', () => {});
}
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') return;
  try {
    process.stderr.write(`[ipc-hub] uncaught: ${err.stack ?? err.message ?? err}\n`);
  } catch {}
});

import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { parentPort } from 'node:worker_threads';
import { Mutex } from 'async-mutex';
import { WebSocketServer } from 'ws';
import { audit } from './lib/audit.mjs';
import { startCIRelay, stopCIRelay } from './lib/ci-relay.mjs';
import { createRouter, safePushAndAudit } from './lib/router.mjs';
import { createHttpHandler } from './lib/http-handlers.mjs';
import { getFeishuApps, getFeishuToken, startFeishuConfigPoller } from './lib/feishu-adapter.mjs';
import { createNetworkEventBroadcaster } from './lib/network-events.mjs';
import { loadInternalToken } from './lib/internal-auth.mjs';
import { createSessionReclaimHandler } from './lib/session-reclaim.mjs';
import {
  isOpenClawSession,
  deliverToOpenClaw,
  enqueueOpenClawRetry,
  startOpenClawRetryTimer,
} from './lib/openclaw-adapter.mjs';
import { createRegistryMaintainer } from './lib/session-registry.mjs';
import { getTokenStatus } from './lib/ccusage-adapter.mjs';
import { normalizeSessionName, validateSessionNameForHub } from './lib/session-names.mjs';

// 从项目根目录加载.env
try {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  for (const line of readFileSync(resolve(__dirname, '.env'), 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    const val = t
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
} catch {
  /* .env不存在 */
}

import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  HEARTBEAT_INTERVAL,
  HEARTBEAT_TIMEOUT,
  IDLE_SHUTDOWN_DELAY,
} from './lib/constants.mjs';
import {
  createMessage,
  createSystemEvent,
  createTask,
  validateMessage,
  normalizePid,
  normalizeCwd,
  resolveContextUsagePct,
  normalizePendingOutgoing,
  TASK_STATUSES,
} from './lib/protocol.mjs';
import {
  ERR_REBIND_PENDING,
  saveMessage,
  updateMessageStatus,
  getMessages,
  getMessageCount,
  getMessageCountByAgent,
  cleanup,
  close,
  saveTask,
  getTask,
  updateTaskStatus,
  listTasks,
  getTaskStats,
  saveInboxMessage,
  getInboxMessages,
  getRecipientRecent,
  clearInbox,
  clearExpiredInbox,
  createPendingRebind,
  findPendingRebind,
  appendBufferedMessage,
  clearPendingRebind,
  cleanupExpiredPendingRebind,
  listSuspendedSessions,
  clearSuspendedSessions,
  suspendSession,
  recordSessionSpawn,
  updateSessionLastSeen,
  markSessionEnded,
  getSessionsByName,
} from './lib/db.mjs';

const PORT = parseInt(process.env.IPC_PORT ?? DEFAULT_PORT, 10);
const AUTH_TOKEN = process.env.IPC_AUTH_TOKEN || null;
const __hubDir = dirname(fileURLToPath(import.meta.url));
function stderr(...args) {
  process.stderr.write(args.join(' ') + '\n');
}
const INTERNAL_TOKEN = await loadInternalToken({ rootDir: __hubDir });
const registryMaintainer = createRegistryMaintainer();

// Per-session认证token（auth-tokens.json）
let authTokens = null;
try {
  const tokensPath = join(__hubDir, 'auth-tokens.json');
  if (existsSync(tokensPath)) authTokens = JSON.parse(readFileSync(tokensPath, 'utf8'));
} catch {
  /* 不存在或无效 */
}

function checkAuth(providedToken, sessionName = null) {
  if (authTokens) {
    const expected = (sessionName && authTokens[sessionName]) || authTokens['*'];
    if (expected) return providedToken === expected;
    return false;
  }
  if (AUTH_TOKEN) return providedToken === AUTH_TOKEN;
  return true;
}

function normalizeRuntime(value) {
  if (typeof value !== 'string') return 'unknown';
  const runtime = value.trim().toLowerCase();
  if (runtime === 'claude' || runtime === 'cc' || runtime === 'claude-code') return 'claude';
  if (runtime === 'codex') return 'codex';
  return 'unknown';
}

function normalizeAppServerThreadId(value) {
  if (typeof value !== 'string') return null;
  const threadId = value.trim();
  return threadId === '' ? null : threadId;
}

function normalizeOptionalString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function normalizeStartedAt(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.trunc(value);
}

function updateSessionContextUsagePct(session, contextUsagePct) {
  session.contextUsagePct = resolveContextUsagePct({
    contextWindow: session.contextWindow,
    contextUsagePct,
  });
}

/** 会话注册表 @type {Map<string, {name:string, ws:import('ws').WebSocket|null, connectedAt:number, topics:Set<string>, inbox:Array, inboxExpiry:ReturnType<typeof setTimeout>|null, gracefulReleasing?:boolean}>} */
const sessions = new Map();
const sessionMutexes = new Map();
const ackPending = new Map(); // messageId → { sender, ts }
const deliveredMessageIds = new Map(); // messageId → timestamp（去重）
const sessionReclaim = createSessionReclaimHandler({ sessions, audit, findPendingRebind });
const appServerClients = new Map();

function getSessionMutex(name) {
  if (!sessionMutexes.has(name)) {
    sessionMutexes.set(name, new Mutex());
  }
  return sessionMutexes.get(name);
}

setInterval(() => {
  const cutoff = Date.now() - 300000;
  for (const [id, ts] of deliveredMessageIds) {
    if (ts < cutoff) deliveredMessageIds.delete(id);
  }
}, 60000).unref();

setInterval(() => {
  const cutoff = Date.now() - 60000;
  for (const [id, entry] of ackPending) {
    if (entry.ts < cutoff) ackPending.delete(id);
  }
}, 30000).unref();

// 空闲自动关闭
let idleTimer = null;
function resetIdleTimer() {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}
function startIdleTimer() {
  if (!IDLE_SHUTDOWN_DELAY) return;
  resetIdleTimer();
  idleTimer = setTimeout(() => {
    stderr('[ipc-hub] no sessions connected — shutting down');
    process.exit(0);
  }, IDLE_SHUTDOWN_DELAY);
}

// 飞书 & OpenClaw 适配器初始化
startFeishuConfigPoller(stderr);
startOpenClawRetryTimer(stderr);
{
  const n = getFeishuApps().length;
  if (n > 0) stderr(`[ipc-hub] feishu: loaded ${n} app(s) from feishu-apps.json`);
}
const deliverToOpenClawBound = (msg) => deliverToOpenClaw(msg, stderr);
const enqueueOpenClawRetryBound = (msg) => enqueueOpenClawRetry(msg, stderr);

// 构建ctx并初始化模块
const ctx = {
  sessions,
  deliveredMessageIds,
  ackPending,
  // feishuApps通过getter动态读取，确保热重载后路由拿到最新配置
  get feishuApps() {
    return getFeishuApps();
  },
  getFeishuToken,
  isOpenClawSession,
  deliverToOpenClaw: deliverToOpenClawBound,
  enqueueOpenClawRetry: enqueueOpenClawRetryBound,
  stderr,
  audit,
  saveMessage,
  updateMessageStatus,
  saveInboxMessage,
  getInboxMessages,
  getRecipientRecent,
  clearInbox,
  suspendSession,
  recordSessionSpawn,
  updateSessionLastSeen,
  markSessionEnded,
  getSessionsByName,
  checkAuth,
  authTokens,
  AUTH_TOKEN,
  INTERNAL_TOKEN,
  createMessage,
  createTask,
  TASK_STATUSES,
  saveTask,
  getTask,
  updateTaskStatus,
  listTasks,
  getTaskStats,
  getMessages,
  getMessageCount,
  getMessageCountByAgent,
  hubDir: __hubDir,
  ERR_REBIND_PENDING,
  createPendingRebind,
  findPendingRebind,
  appendBufferedMessage,
  clearPendingRebind,
  cleanupExpiredPendingRebind,
  registerSessionRecord: (payload, options = {}) =>
    registryMaintainer.registerSession(payload, options),
  updateSessionRecordProjects: (payload, options = {}) =>
    registryMaintainer.updateSessionProjects(payload, options),
  sessionReclaim,
  appServerClients,
};

const {
  routeMessage,
  send,
  broadcast,
  broadcastToTopic,
  pushInbox,
  flushInbox,
  flushPendingRebind,
  scheduleInboxCleanup,
} = createRouter(ctx);
const { broadcastNetworkDown, broadcastNetworkUp } = createNetworkEventBroadcaster({
  router: { broadcastToTopic, routeMessage },
  db: {
    listSuspendedSessions,
    clearSuspendedSessions,
  },
  getSessions: () => sessions,
});
ctx.routeMessage = routeMessage;
ctx.broadcastToTopic = broadcastToTopic;
ctx.broadcastNetworkDown = broadcastNetworkDown;
ctx.broadcastNetworkUp = broadcastNetworkUp;
const handleRequest = createHttpHandler(ctx);

const ccusageCronState = { lastLevel: null, lastSentAt: 0 };
async function runCcusageQuotaCron() {
  try {
    const status = await getTokenStatus({});
    const remaining = status.remaining_pct;
    if (!Number.isFinite(remaining)) return;
    const level = remaining < 5 ? 'FREEZE' : remaining < 20 ? 'WARN' : null;
    if (!level) {
      ccusageCronState.lastLevel = null;
      return;
    }
    const now = Date.now();
    if (ccusageCronState.lastLevel === level && now - ccusageCronState.lastSentAt < 5 * 60 * 1000)
      return;
    ccusageCronState.lastLevel = level;
    ccusageCronState.lastSentAt = now;
    routeMessage(
      createMessage({
        from: 'jianmu-hub',
        to: '*',
        topic: 'critique',
        contentType: 'markdown',
        content: `[${level}] ccusage 5h block remaining ${remaining}% (used ${status.used_pct ?? 'n/a'}%, reset ${status.resets_at ?? 'unknown'}). ${level === 'FREEZE' ? 'Freeze non-critical work.' : 'Reduce token burn and avoid large spawns.'}`,
      }),
    );
  } catch (error) {
    stderr(`[ipc-hub] ccusage quota cron skipped: ${error?.message ?? error}`);
  }
}

setInterval(runCcusageQuotaCron, 15 * 60 * 1000).unref();
setTimeout(runCcusageQuotaCron, 30 * 1000).unref();

if (process.env.IPC_ENABLE_TEST_HOOKS === '1' && parentPort) {
  const mockCodexAppServers = new Map();

  function collectInputText(input) {
    if (typeof input === 'string') return input;
    if (!Array.isArray(input)) return JSON.stringify(input ?? '');
    return input
      .map((part) => {
        if (typeof part?.text === 'string') return part.text;
        if (typeof part?.content === 'string') return part.content;
        return JSON.stringify(part ?? '');
      })
      .join('');
  }

  function collectInjectItemsText(items) {
    if (!Array.isArray(items)) return JSON.stringify(items ?? '');
    return items
      .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
      .map((part) => part?.text ?? part?.output_text ?? '')
      .join('');
  }

  function createMockCodexAppServer({
    sessionName,
    threadId,
    activeTurnId = null,
    failPush = false,
  }) {
    const state = {
      sessionName,
      threadId,
      activeTurnId,
      failPush: failPush === true,
      calls: [],
    };
    const maybeFail = (call) => {
      if (!state.failPush) return;
      call.error = 'mock app server push failed';
      throw new Error(call.error);
    };
    const client = {
      threadStatus(requestedThreadId) {
        const call = {
          method: 'threadStatus',
          threadId: requestedThreadId,
          activeTurnId: state.activeTurnId,
          ts: Date.now(),
        };
        state.calls.push(call);
        return {
          threadId: requestedThreadId,
          status: { type: state.activeTurnId ? 'active' : 'idle' },
          activeTurnId: state.activeTurnId,
        };
      },
      async turnSteer(requestedThreadId, expectedTurnId, input) {
        const call = {
          method: 'turnSteer',
          threadId: requestedThreadId,
          expectedTurnId,
          content: collectInputText(input),
          ts: Date.now(),
        };
        state.calls.push(call);
        maybeFail(call);
        return { ok: true };
      },
      async threadInjectItems(requestedThreadId, items) {
        const call = {
          method: 'threadInjectItems',
          threadId: requestedThreadId,
          content: collectInjectItemsText(items),
          ts: Date.now(),
        };
        state.calls.push(call);
        maybeFail(call);
        return { ok: true };
      },
    };
    return { state, client };
  }

  function summarizeMockCodexAppServer(mock) {
    if (!mock) return null;
    return {
      sessionName: mock.state.sessionName,
      threadId: mock.state.threadId,
      activeTurnId: mock.state.activeTurnId,
      failPush: mock.state.failPush,
      calls: mock.state.calls,
    };
  }

  parentPort.on('message', async (message) => {
    if (!message || typeof message !== 'object' || !message.requestId || !message.action) {
      return;
    }

    try {
      let result;
      switch (message.action) {
        case 'broadcastNetworkDown':
          result = await broadcastNetworkDown(message.payload ?? {});
          break;
        case 'broadcastNetworkUp':
          result = await broadcastNetworkUp(message.payload ?? {});
          break;
        case 'listSuspendedSessions':
          result = listSuspendedSessions();
          break;
        case 'setSessionConnectedAt': {
          const sessionName = message.payload?.name;
          const connectedAt = message.payload?.connectedAt;
          if (!sessionName || !Number.isFinite(connectedAt)) {
            throw new Error('setSessionConnectedAt requires { name, connectedAt }');
          }
          const session = sessions.get(sessionName);
          if (!session) {
            throw new Error(`session not found: ${sessionName}`);
          }
          session.connectedAt = connectedAt;
          result = { name: sessionName, connectedAt };
          break;
        }
        case 'setSessionIsAlive': {
          const sessionName = message.payload?.name;
          const isAlive = message.payload?.isAlive;
          if (!sessionName || typeof isAlive !== 'boolean') {
            throw new Error('setSessionIsAlive requires { name, isAlive }');
          }
          const session = sessions.get(sessionName);
          if (!session?.ws) {
            throw new Error(`session websocket not found: ${sessionName}`);
          }
          session.ws.isAlive = isAlive;
          result = { name: sessionName, isAlive };
          break;
        }
        case 'attachMockCodexAppServer': {
          const sessionName = message.payload?.sessionName;
          if (!sessionName) throw new Error('attachMockCodexAppServer requires sessionName');
          const session = sessions.get(sessionName);
          if (!session) throw new Error(`session not found: ${sessionName}`);
          const threadId = normalizeAppServerThreadId(
            message.payload?.threadId ?? session.appServerThreadId,
          );
          if (!threadId) throw new Error('attachMockCodexAppServer requires threadId');
          const mock = createMockCodexAppServer({
            sessionName,
            threadId,
            activeTurnId: message.payload?.activeTurnId ?? null,
            failPush: message.payload?.failPush === true,
          });
          mockCodexAppServers.set(sessionName, mock);
          appServerClients.set(sessionName, mock.client);
          session.appServerClient = mock.client;
          session.runtime = 'codex';
          session.appServerThreadId = threadId;
          result = summarizeMockCodexAppServer(mock);
          break;
        }
        case 'updateMockCodexAppServer': {
          const sessionName = message.payload?.sessionName;
          const mock = mockCodexAppServers.get(sessionName);
          if (!mock) throw new Error(`mock codex app server not found: ${sessionName}`);
          if (Object.hasOwn(message.payload, 'activeTurnId')) {
            mock.state.activeTurnId = message.payload.activeTurnId ?? null;
          }
          if (Object.hasOwn(message.payload, 'failPush')) {
            mock.state.failPush = message.payload.failPush === true;
          }
          result = summarizeMockCodexAppServer(mock);
          break;
        }
        case 'getMockCodexAppServer': {
          const sessionName = message.payload?.sessionName;
          const mock = mockCodexAppServers.get(sessionName);
          if (!mock) throw new Error(`mock codex app server not found: ${sessionName}`);
          result = summarizeMockCodexAppServer(mock);
          break;
        }
        default:
          return;
      }

      parentPort.postMessage({
        type: 'test-hook:result',
        requestId: message.requestId,
        ok: true,
        result,
      });
    } catch (error) {
      parentPort.postMessage({
        type: 'test-hook:result',
        requestId: message.requestId,
        ok: false,
        error: error?.message ?? String(error),
      });
    }
  });
}

// HTTP + WebSocket servers
const httpServer = http.createServer(handleRequest);

const wss = new WebSocketServer({
  server: httpServer,
  verifyClient: ({ req }) => {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const u = new URL(origin);
      return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    } catch {
      return false;
    }
  },
});

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, `http://localhost`);
  const rawName = url.searchParams.get('name');
  const token = url.searchParams.get('token');
  const forceRebind = url.searchParams.get('force') === '1';

  if (!rawName) {
    ws.close(4000, 'name query param required');
    return;
  }

  const nameValidation = validateSessionNameForHub(rawName);
  if (!nameValidation.ok) {
    audit('ws_invalid_name', {
      name: rawName || '<none>',
      error: nameValidation.error,
      ip: req.socket.remoteAddress,
    });
    ws.close(4000, nameValidation.error);
    return;
  }

  const name = nameValidation.name;
  if (!checkAuth(token, nameValidation.name)) {
    audit('ws_auth_fail', { name, ip: req.socket.remoteAddress });
    ws.close(4003, 'unauthorized');
    return;
  }

  let session = null;
  let pendingRebind = null;
  let handleSessionMessage = null;
  const queuedMessages = [];
  const onSessionMessage = (raw) => {
    if (handleSessionMessage) {
      handleSessionMessage(raw);
      return;
    }
    queuedMessages.push(raw);
  };
  ws.on('message', onSessionMessage);

  let release = null;
  try {
    release = await getSessionMutex(name).acquire();

    if (ws.readyState !== ws.OPEN) {
      ws.off('message', onSessionMessage);
      return;
    }

    pendingRebind = findPendingRebind(name);
    const existing = sessions.get(name);
    if (pendingRebind && existing && existing.ws && existing.ws.readyState === existing.ws.OPEN) {
      // Explicit release-rebind has priority over ?force=1. While the current owner
      // is still connected, the successor must wait instead of zombie-killing it.
      ws.close(4001, 'name taken');
      ws.off('message', onSessionMessage);
      return;
    }
    if (!pendingRebind && existing && existing.ws && existing.ws.readyState === existing.ws.OPEN) {
      const staleForMs = Date.now() - (existing.connectedAt || 0);
      const zombieDetected =
        existing.ws.isAlive === false ||
        (staleForMs > 2 * HEARTBEAT_INTERVAL && existing.ws.isAlive === false);

      if (forceRebind || zombieDetected) {
        audit(forceRebind ? 'force_rebind' : 'zombie_rebind', {
          name,
          staleForMs,
          previousConnectedAt: existing.connectedAt || 0,
          previousIsAlive: existing.ws.isAlive ?? null,
          remoteAddress: req.socket.remoteAddress,
        });
        existing.ws.terminate();
      } else {
        ws.close(4001, 'name taken');
        ws.off('message', onSessionMessage);
        return;
      }
    }
    if (existing && existing.inboxExpiry !== null) {
      clearTimeout(existing.inboxExpiry);
      existing.inboxExpiry = null;
    }
    const connectedAt = Date.now();
    session = existing ?? {
      name,
      ws: null,
      connectedAt,
      topics: new Set(),
      inbox: [],
      inboxExpiry: null,
      gracefulReleasing: false,
      pid: null,
      cwd: null,
      contextUsagePct: null,
      pendingOutgoing: 0,
      contextWindow: null,
      rateLimits: null,
      cost: null,
      model: null,
      sessionId: null,
      transcriptPath: null,
      lastStatuslinePushAt: null,
      subprocess: false,
      runtime: 'unknown',
      appServerPid: null,
      appServerThreadId: null,
      startedAt: connectedAt,
      startupSource: 'ws',
      label: name,
    };
    session.startedAt =
      Number.isFinite(session.startedAt) && session.startedAt > 0 ? session.startedAt : connectedAt;
    session.startupSource = session.startupSource ?? 'ws';
    session.label = session.label ?? session.name;
    session.ws = ws;
    session.connectedAt = connectedAt;
    session.gracefulReleasing = false;
    if (pendingRebind) {
      session.topics = new Set(pendingRebind.lastTopics);
    }
    sessions.set(name, session);
  } catch (error) {
    ws.off('message', onSessionMessage);
    stderr(`[ipc-hub] session registration error for ${name}: ${error?.message ?? error}`);
    if (ws.readyState === ws.OPEN) {
      ws.close(1011, 'registration failed');
    }
    return;
  } finally {
    if (release) release();
  }

  resetIdleTimer();
  audit('session_connect', { name, total: countLive() });
  stderr(`[ipc-hub] session connected: ${name} (total: ${countLive()})`);
  if (pendingRebind) {
    flushPendingRebind(session, pendingRebind);
    clearPendingRebind(name);
    audit('rebind_inherit', {
      name,
      topicsCount: session.topics.size,
      bufferedCount: pendingRebind.bufferedMessages.length,
    });
  } else {
    broadcast(createSystemEvent({ event: 'session_joined', session: name }), name);
    flushInbox(session);
  }
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  handleSessionMessage = (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: 'error', error: 'invalid JSON' });
      return;
    }

    const { valid, error } = validateMessage(msg);
    if (!valid) {
      send(ws, { type: 'error', error });
      return;
    }

    switch (msg.type) {
      case 'ping':
        send(ws, { type: 'pong' });
        break;
      case 'register':
        {
          const declaredName = normalizeSessionName(msg.name);
          const declaredValidation = validateSessionNameForHub(declaredName);
          if (!declaredValidation.ok) {
            audit('register_invalid_name', {
              name: declaredName || '<none>',
              connected_as: session.name,
              error: declaredValidation.error,
            });
            send(ws, { type: 'error', error: declaredValidation.error });
            ws.close(4000, declaredValidation.error);
            return;
          }
          if (declaredValidation.name !== session.name) {
            audit('register_name_mismatch', {
              declared: declaredValidation.name,
              connected_as: session.name,
            });
            send(ws, {
              type: 'error',
              error: 'register name must match WebSocket session name',
            });
            ws.close(4000, 'register name mismatch');
            return;
          }
        }
        session.channelPort = msg.channelPort ?? null;
        session.pid = normalizePid(msg.pid);
        session.cwd = normalizeCwd(msg.cwd);
        updateSessionContextUsagePct(session, msg.contextUsagePct);
        session.pendingOutgoing = normalizePendingOutgoing(msg.pendingOutgoing);
        session.subprocess = msg.subprocess === true;
        session.runtime = normalizeRuntime(msg.runtime);
        session.appServerPid = normalizePid(msg.appServerPid);
        session.appServerThreadId = normalizeAppServerThreadId(msg.appServerThreadId);
        session.sessionId = normalizeOptionalString(msg.sessionId) ?? session.sessionId ?? null;
        session.transcriptPath =
          normalizeOptionalString(msg.transcriptPath) ?? session.transcriptPath ?? null;
        session.startedAt = normalizeStartedAt(msg.startedAt) ?? session.startedAt ?? session.connectedAt;
        session.startupSource =
          normalizeOptionalString(msg.startupSource) ??
          (msg.subprocess === true ? 'pid-fallback' : session.startupSource ?? 'unknown');
        session.label = normalizeOptionalString(msg.label) ?? session.label ?? session.name;
        if (session.sessionId) {
          try {
            recordSessionSpawn({
              sessionId: session.sessionId,
              name: session.name,
              spawnReason: 'fresh',
              cwd: session.cwd,
              runtime: session.runtime,
              transcriptPath: session.transcriptPath,
              spawnAt: session.startedAt ?? session.connectedAt,
            });
            updateSessionLastSeen(session.sessionId, Date.now());
          } catch (error) {
            stderr(`[ipc-hub] sessions_history ws register skipped: ${error?.message ?? error}`);
          }
        }
        send(ws, {
          type: 'registered',
          name: session.name,
          runtime: session.runtime,
          appServerPid: session.appServerPid,
          appServerThreadId: session.appServerThreadId,
        });
        break;
      case 'update':
        if (Object.hasOwn(msg, 'contextUsagePct')) {
          updateSessionContextUsagePct(session, msg.contextUsagePct);
        }
        if (Object.hasOwn(msg, 'pendingOutgoing')) {
          session.pendingOutgoing = normalizePendingOutgoing(msg.pendingOutgoing);
        }
        if (session.sessionId) {
          updateSessionLastSeen(session.sessionId, Date.now());
        }
        send(ws, { type: 'updated', name: session.name, contextUsagePct: session.contextUsagePct });
        break;
      case 'subscribe':
        session.topics.add(msg.topic);
        send(ws, { type: 'subscribed', topic: msg.topic });
        break;
      case 'unsubscribe':
        session.topics.delete(msg.topic);
        send(ws, { type: 'unsubscribed', topic: msg.topic });
        break;
      case 'message':
        routeMessage(msg, session);
        break;
      case 'ack': {
        const pending = ackPending.get(msg.messageId);
        audit('ack_received', {
          message_id: msg.messageId,
          confirmed_by: session.name,
          original_sender: pending?.sender ?? null,
          rtt_ms: pending ? Date.now() - pending.ts : null,
        });
        if (pending) {
          if (pending.timer) clearTimeout(pending.timer);
          ackPending.delete(msg.messageId);
          updateMessageStatus(msg.messageId, 'delivered');
          const senderSession = sessions.get(pending.sender);
          if (senderSession?.ws && senderSession.ws.readyState === senderSession.ws.OPEN) {
            try {
              safePushAndAudit(
                senderSession,
                {
                  type: 'ack',
                  messageId: msg.messageId,
                  confirmedBy: session.name,
                },
                { reason: 'ack-notify', audit },
              );
            } catch (err) {
              stderr(`[ipc-hub] send error: ${err.message}`);
            }
          }
          stderr(
            `[ipc-hub] ack: ${session.name} confirmed ${msg.messageId} → notified ${pending.sender}`,
          );
        }
        break;
      }
      default:
        send(ws, { type: 'error', error: `unknown message type: ${msg.type}` });
    }
  };

  ws.on('close', () => {
    if (session.ws !== ws) return;
    if (session.sessionId) {
      markSessionEnded(session.sessionId, Date.now());
    }
    session.ws = null;
    audit('session_disconnect', { name, inboxSize: session.inbox.length });
    stderr(`[ipc-hub] session disconnected: ${name} (inbox: ${session.inbox.length} msgs)`);
    broadcast(createSystemEvent({ event: 'session_left', session: name }), name);
    const activePendingRebind = session.gracefulReleasing ? findPendingRebind(name) : null;
    if (session.gracefulReleasing && activePendingRebind) {
      session.inbox.length = 0;
      session.gracefulReleasing = false;
      if (session.inboxExpiry !== null) {
        clearTimeout(session.inboxExpiry);
        session.inboxExpiry = null;
      }
      sessions.delete(name);
    } else {
      session.gracefulReleasing = false;
      session.topics = new Set();
      scheduleInboxCleanup(session);
    }
    if (countLive() === 0) startIdleTimer();
  });

  ws.on('error', (err) => {
    stderr(`[ipc-hub] ws error on session ${name}: ${err.message}`);
  });

  for (const raw of queuedMessages.splice(0)) {
    handleSessionMessage(raw);
  }
});

// 心跳 + 定期清理
function countLive() {
  let count = 0;
  for (const [, s] of sessions) {
    if (s.ws && s.ws.readyState === s.ws.OPEN) count++;
  }
  return count;
}

const heartbeatInterval = setInterval(() => {
  for (const [name, session] of sessions) {
    const { ws } = session;
    if (!ws) continue;
    if (ws.isAlive === false) {
      stderr(`[ipc-hub] heartbeat timeout: terminating ${name}`);
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
    setTimeout(() => {
      if (ws.isAlive === false && ws.readyState === ws.OPEN) {
        stderr(`[ipc-hub] no pong from ${name}, terminating`);
        ws.terminate();
      }
    }, HEARTBEAT_TIMEOUT);
  }
}, HEARTBEAT_INTERVAL);
heartbeatInterval.unref();
setInterval(
  () => {
    cleanup();
    clearExpiredInbox();
  },
  60 * 60 * 1000,
).unref();
setInterval(() => {
  const deleted = cleanupExpiredPendingRebind();
  if (deleted > 0) {
    audit('rebind_expired', { count: deleted });
  }
}, 5_000).unref();

// 轮询源文件变更——仅开发模式启用（IPC_DEV_WATCH=1）
// 生产环境默认关闭，避免代码提交触发Hub重启导致全员断线
if (process.env.IPC_DEV_WATCH === '1') {
  const __hubWatchFiles = [
    'hub.mjs',
    'lib/router.mjs',
    'lib/http-handlers.mjs',
    'lib/db.mjs',
    'lib/network-events.mjs',
    'lib/protocol.mjs',
    'lib/constants.mjs',
  ];
  const __hubFileMtimes = new Map();
  for (const file of __hubWatchFiles) {
    try {
      __hubFileMtimes.set(file, statSync(join(__hubDir, file)).mtimeMs);
    } catch {}
  }
  setInterval(() => {
    for (const [file, oldMtime] of __hubFileMtimes) {
      try {
        const mtime = statSync(join(__hubDir, file)).mtimeMs;
        if (mtime !== oldMtime) {
          stderr(`[ipc-hub] source file changed: ${file}, restarting...`);
          process.exit(0);
        }
      } catch {}
    }
  }, 10000);
  stderr('[ipc-hub] DEV mode: polling source files for auto-restart (10s interval)');
} else {
  stderr('[ipc-hub] file watch disabled (set IPC_DEV_WATCH=1 to enable)');
}

httpServer.listen(PORT, DEFAULT_HOST, () => {
  stderr(`[ipc-hub] listening on ${DEFAULT_HOST}:${PORT}`);
  stderr(
    `[ipc-hub] auth: ${authTokens ? 'per-session tokens (auth-tokens.json)' : AUTH_TOKEN ? 'shared token (IPC_AUTH_TOKEN)' : 'disabled (open access)'}`,
  );
  if (DEFAULT_HOST !== '127.0.0.1' && DEFAULT_HOST !== 'localhost' && !AUTH_TOKEN && !authTokens)
    stderr(
      `[ipc-hub] WARNING: hub is exposed on ${DEFAULT_HOST} with no authentication — set IPC_AUTH_TOKEN or provide auth-tokens.json`,
    );
  startCIRelay(routeMessage);
});

httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    stderr(`[ipc-hub] port ${PORT} already in use — another hub may be running`);
    stderr(`[ipc-hub] check with: curl http://127.0.0.1:${PORT}/health`);
  } else {
    stderr(`[ipc-hub] http server error: ${err.message}`);
  }
  process.exit(1);
});

function gracefulShutdown(sig) {
  stderr(`[ipc-hub] ${sig} received, shutting down`);
  clearInterval(heartbeatInterval);
  stopCIRelay();
  close();
  wss.close(() => httpServer.close(() => process.exit(0)));
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
