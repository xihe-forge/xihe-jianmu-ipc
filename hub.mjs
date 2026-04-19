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
    try { return origWrite(...args); }
    catch (err) {
      if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') return true;
      throw err;
    }
  };
  stream.on('error', () => {});
}
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') return;
  try { process.stderr.write(`[ipc-hub] uncaught: ${err.stack ?? err.message ?? err}\n`); } catch {}
});

import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { parentPort } from 'node:worker_threads';
import { WebSocketServer } from 'ws';
import { audit } from './lib/audit.mjs';
import { startCIRelay, stopCIRelay } from './lib/ci-relay.mjs';
import { createRouter } from './lib/router.mjs';
import { createHttpHandler } from './lib/http-handlers.mjs';
import { getFeishuApps, getFeishuToken, startFeishuConfigPoller } from './lib/feishu-adapter.mjs';
import { createNetworkEventBroadcaster } from './lib/network-events.mjs';
import { loadInternalToken } from './lib/internal-auth.mjs';
import { isOpenClawSession, deliverToOpenClaw, enqueueOpenClawRetry, startOpenClawRetryTimer } from './lib/openclaw-adapter.mjs';

// 从项目根目录加载.env
try {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  for (const line of readFileSync(resolve(__dirname, '.env'), 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
} catch { /* .env不存在 */ }

import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  HEARTBEAT_INTERVAL,
  HEARTBEAT_TIMEOUT,
  IDLE_SHUTDOWN_DELAY,
} from './lib/constants.mjs';
import { createMessage, createSystemEvent, createTask, validateMessage, TASK_STATUSES } from './lib/protocol.mjs';
import {
  ERR_REBIND_PENDING,
  saveMessage,
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
} from './lib/db.mjs';

const PORT = parseInt(process.env.IPC_PORT ?? DEFAULT_PORT, 10);
const AUTH_TOKEN = process.env.IPC_AUTH_TOKEN || null;
const __hubDir = dirname(fileURLToPath(import.meta.url));
function stderr(...args) { process.stderr.write(args.join(' ') + '\n'); }
const INTERNAL_TOKEN = await loadInternalToken({ rootDir: __hubDir });

// Per-session认证token（auth-tokens.json）
let authTokens = null;
try {
  const tokensPath = join(__hubDir, 'auth-tokens.json');
  if (existsSync(tokensPath)) authTokens = JSON.parse(readFileSync(tokensPath, 'utf8'));
} catch { /* 不存在或无效 */ }

function checkAuth(providedToken, sessionName = null) {
  if (authTokens) {
    const expected = (sessionName && authTokens[sessionName]) || authTokens['*'];
    if (expected) return providedToken === expected;
    return false;
  }
  if (AUTH_TOKEN) return providedToken === AUTH_TOKEN;
  return true;
}

/** 会话注册表 @type {Map<string, {name:string, ws:import('ws').WebSocket|null, connectedAt:number, topics:Set<string>, inbox:Array, inboxExpiry:ReturnType<typeof setTimeout>|null}>} */
const sessions = new Map();
const ackPending = new Map();        // messageId → { sender, ts }
const deliveredMessageIds = new Map(); // messageId → timestamp（去重）

setInterval(() => {
  const cutoff = Date.now() - 300000;
  for (const [id, ts] of deliveredMessageIds) { if (ts < cutoff) deliveredMessageIds.delete(id); }
}, 60000).unref();

setInterval(() => {
  const cutoff = Date.now() - 60000;
  for (const [id, entry] of ackPending) { if (entry.ts < cutoff) ackPending.delete(id); }
}, 30000).unref();

// 空闲自动关闭
let idleTimer = null;
function resetIdleTimer() { if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; } }
function startIdleTimer() {
  if (!IDLE_SHUTDOWN_DELAY) return;
  resetIdleTimer();
  idleTimer = setTimeout(() => { stderr('[ipc-hub] no sessions connected — shutting down'); process.exit(0); }, IDLE_SHUTDOWN_DELAY);
}

// 飞书 & OpenClaw 适配器初始化
startFeishuConfigPoller(stderr);
startOpenClawRetryTimer(stderr);
{ const n = getFeishuApps().length; if (n > 0) stderr(`[ipc-hub] feishu: loaded ${n} app(s) from feishu-apps.json`); }
const deliverToOpenClawBound = (msg) => deliverToOpenClaw(msg, stderr);
const enqueueOpenClawRetryBound = (msg) => enqueueOpenClawRetry(msg, stderr);

// 构建ctx并初始化模块
const ctx = {
  sessions,
  deliveredMessageIds,
  ackPending,
  // feishuApps通过getter动态读取，确保热重载后路由拿到最新配置
  get feishuApps() { return getFeishuApps(); },
  getFeishuToken,
  isOpenClawSession,
  deliverToOpenClaw: deliverToOpenClawBound,
  enqueueOpenClawRetry: enqueueOpenClawRetryBound,
  stderr,
  audit,
  saveMessage,
  saveInboxMessage,
  getInboxMessages,
  getRecipientRecent,
  clearInbox,
  suspendSession,
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
};

const { routeMessage, send, broadcast, broadcastToTopic, pushInbox, flushInbox, scheduleInboxCleanup } = createRouter(ctx);
const { broadcastNetworkDown, broadcastNetworkUp } = createNetworkEventBroadcaster({
  router: { broadcastToTopic },
  db: {
    listSuspendedSessions,
    clearSuspendedSessions,
  },
});
ctx.routeMessage = routeMessage;
ctx.broadcastToTopic = broadcastToTopic;
ctx.broadcastNetworkDown = broadcastNetworkDown;
ctx.broadcastNetworkUp = broadcastNetworkUp;
const handleRequest = createHttpHandler(ctx);

if (process.env.IPC_ENABLE_TEST_HOOKS === '1' && parentPort) {
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
    try { const u = new URL(origin); return u.hostname === 'localhost' || u.hostname === '127.0.0.1'; }
    catch { return false; }
  },
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost`);
  const name = url.searchParams.get('name');
  const token = url.searchParams.get('token');
  const forceRebind = url.searchParams.get('force') === '1';

  if (!checkAuth(token, name)) {
    audit('ws_auth_fail', { name: name || '<none>', ip: req.socket.remoteAddress });
    ws.close(4003, 'unauthorized');
    return;
  }
  if (!name) { ws.close(4000, 'name query param required'); return; }

  const existing = sessions.get(name);
  if (existing && existing.ws && existing.ws.readyState === existing.ws.OPEN) {
    const staleForMs = Date.now() - (existing.connectedAt || 0);
    const zombieDetected = existing.ws.isAlive === false || (staleForMs > 2 * HEARTBEAT_INTERVAL && existing.ws.isAlive === false);

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
      return;
    }
  }
  if (existing && existing.inboxExpiry !== null) {
    clearTimeout(existing.inboxExpiry);
    existing.inboxExpiry = null;
  }
  const session = existing ?? { name, ws: null, connectedAt: Date.now(), topics: new Set(), inbox: [], inboxExpiry: null };
  session.ws = ws;
  session.connectedAt = Date.now();
  sessions.set(name, session);
  resetIdleTimer();
  audit('session_connect', { name, total: countLive() });
  stderr(`[ipc-hub] session connected: ${name} (total: ${countLive()})`);
  broadcast(createSystemEvent({ event: 'session_joined', session: name }), name);
  flushInbox(session);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { send(ws, { type: 'error', error: 'invalid JSON' }); return; }

    const { valid, error } = validateMessage(msg);
    if (!valid) { send(ws, { type: 'error', error }); return; }

    switch (msg.type) {
      case 'ping':       send(ws, { type: 'pong' }); break;
      case 'register':   session.channelPort = msg.channelPort ?? null; send(ws, { type: 'registered', name: session.name }); break;
      case 'subscribe':  session.topics.add(msg.topic); send(ws, { type: 'subscribed', topic: msg.topic }); break;
      case 'unsubscribe':session.topics.delete(msg.topic); send(ws, { type: 'unsubscribed', topic: msg.topic }); break;
      case 'message':    routeMessage(msg, session); break;
      case 'ack': {
        const pending = ackPending.get(msg.messageId);
        if (pending) {
          ackPending.delete(msg.messageId);
          const senderSession = sessions.get(pending.sender);
          if (senderSession?.ws?.readyState === senderSession?.ws?.OPEN)
            send(senderSession.ws, { type: 'ack', messageId: msg.messageId, confirmedBy: session.name });
          stderr(`[ipc-hub] ack: ${session.name} confirmed ${msg.messageId} → notified ${pending.sender}`);
        }
        break;
      }
      default: send(ws, { type: 'error', error: `unknown message type: ${msg.type}` });
    }
  });

  ws.on('close', () => {
    if (session.ws !== ws) return;
    session.ws = null;
    audit('session_disconnect', { name, inboxSize: session.inbox.length });
    stderr(`[ipc-hub] session disconnected: ${name} (inbox: ${session.inbox.length} msgs)`);
    broadcast(createSystemEvent({ event: 'session_left', session: name }), name);
    scheduleInboxCleanup(session);
    if (countLive() === 0) startIdleTimer();
  });

  ws.on('error', (err) => { stderr(`[ipc-hub] ws error on session ${name}: ${err.message}`); });
});

// 心跳 + 定期清理
function countLive() {
  let count = 0;
  for (const [, s] of sessions) { if (s.ws && s.ws.readyState === s.ws.OPEN) count++; }
  return count;
}

const heartbeatInterval = setInterval(() => {
  for (const [name, session] of sessions) {
    const { ws } = session;
    if (!ws) continue;
    if (ws.isAlive === false) { stderr(`[ipc-hub] heartbeat timeout: terminating ${name}`); ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
    setTimeout(() => {
      if (ws.isAlive === false && ws.readyState === ws.OPEN) { stderr(`[ipc-hub] no pong from ${name}, terminating`); ws.terminate(); }
    }, HEARTBEAT_TIMEOUT);
  }
}, HEARTBEAT_INTERVAL);
heartbeatInterval.unref();
setInterval(() => {
  cleanup();
  clearExpiredInbox();
}, 60 * 60 * 1000).unref();

// 轮询源文件变更——仅开发模式启用（IPC_DEV_WATCH=1）
// 生产环境默认关闭，避免代码提交触发Hub重启导致全员断线
if (process.env.IPC_DEV_WATCH === '1') {
  const __hubWatchFiles = ['hub.mjs', 'lib/router.mjs', 'lib/http-handlers.mjs', 'lib/db.mjs', 'lib/network-events.mjs', 'lib/protocol.mjs', 'lib/constants.mjs'];
  const __hubFileMtimes = new Map();
  for (const file of __hubWatchFiles) {
    try { __hubFileMtimes.set(file, statSync(join(__hubDir, file)).mtimeMs); } catch {}
  }
  setInterval(() => {
    for (const [file, oldMtime] of __hubFileMtimes) {
      try {
        const mtime = statSync(join(__hubDir, file)).mtimeMs;
        if (mtime !== oldMtime) { stderr(`[ipc-hub] source file changed: ${file}, restarting...`); process.exit(0); }
      } catch {}
    }
  }, 10000);
  stderr('[ipc-hub] DEV mode: polling source files for auto-restart (10s interval)');
} else {
  stderr('[ipc-hub] file watch disabled (set IPC_DEV_WATCH=1 to enable)');
}

httpServer.listen(PORT, DEFAULT_HOST, () => {
  stderr(`[ipc-hub] listening on ${DEFAULT_HOST}:${PORT}`);
  stderr(`[ipc-hub] auth: ${authTokens ? 'per-session tokens (auth-tokens.json)' : AUTH_TOKEN ? 'shared token (IPC_AUTH_TOKEN)' : 'disabled (open access)'}`);
  if (DEFAULT_HOST !== '127.0.0.1' && DEFAULT_HOST !== 'localhost' && !AUTH_TOKEN && !authTokens)
    stderr(`[ipc-hub] WARNING: hub is exposed on ${DEFAULT_HOST} with no authentication — set IPC_AUTH_TOKEN or provide auth-tokens.json`);
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
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
