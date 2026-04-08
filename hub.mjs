/**
 * hub.mjs — IPC WebSocket hub server
 *
 * Standalone process that routes messages between Claude Code sessions.
 * All logging goes to stderr. stdout is reserved for machine-readable output.
 *
 * Usage: node hub.mjs
 * Env:   IPC_PORT (overrides DEFAULT_PORT)
 */

// Prevent EPIPE crashes when hub runs detached (setsid) and the launching
// terminal closes — stdout becomes a broken pipe. process.stdout.on('error')
// only handles async errors; stdout.write can throw SYNCHRONOUSLY, so we
// must patch write().
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

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { audit } from './lib/audit.mjs';

// Load .env from project root (no dotenv dependency needed)
try {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const envFile = readFileSync(resolve(__dirname, '.env'), 'utf8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;  // don't override existing env
  }
} catch { /* .env not found, use defaults */ }
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  HEARTBEAT_INTERVAL,
  HEARTBEAT_TIMEOUT,
  INBOX_MAX_SIZE,
  INBOX_TTL,
  IDLE_SHUTDOWN_DELAY,
} from './lib/constants.mjs';
import { createMessage, createSystemEvent, createTask, validateMessage, TASK_STATUSES } from './lib/protocol.mjs';
import { saveMessage, getMessages, getMessageCount, getMessageCountByAgent, cleanup, close, saveTask, getTask, updateTaskStatus, listTasks, getTaskStats } from './lib/db.mjs';

const PORT = parseInt(process.env.IPC_PORT ?? DEFAULT_PORT, 10);
const AUTH_TOKEN = process.env.IPC_AUTH_TOKEN || null;
const __hubDir = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Per-session auth tokens (auth-tokens.json)
// ---------------------------------------------------------------------------
let authTokens = null;
try {
  const tokensPath = join(__hubDir, 'auth-tokens.json');
  if (existsSync(tokensPath)) {
    authTokens = JSON.parse(readFileSync(tokensPath, 'utf8'));
  }
} catch { /* auth-tokens.json not found or invalid, fall back to shared token */ }

// ---------------------------------------------------------------------------
// Auth helper — per-session tokens with fallback to shared token
// ---------------------------------------------------------------------------
function checkAuth(providedToken, sessionName = null) {
  // 1. Per-session tokens from auth-tokens.json
  if (authTokens) {
    const expected = (sessionName && authTokens[sessionName]) || authTokens['*'];
    if (expected) return providedToken === expected;
    // auth-tokens.json exists but no matching key and no wildcard — deny
    return false;
  }
  // 2. Shared token from IPC_AUTH_TOKEN env
  if (AUTH_TOKEN) return providedToken === AUTH_TOKEN;
  // 3. No auth configured — allow all
  return true;
}

// ---------------------------------------------------------------------------
// Session registry
// Map<name, { name, ws, connectedAt, topics: Set<string>, inbox: Array }>
// ---------------------------------------------------------------------------
/** @type {Map<string, {name: string, ws: import('ws').WebSocket|null, connectedAt: number, topics: Set<string>, inbox: Array, inboxExpiry: ReturnType<typeof setTimeout>|null}>} */
const sessions = new Map();

// Pending ack tracking: messageId → { sender, ts }
const ackPending = new Map();

// Message deduplication: messageId → timestamp (prevents duplicate delivery)
const deliveredMessageIds = new Map();

// Cleanup expired dedup entries every 60 seconds
setInterval(() => {
  const cutoff = Date.now() - 300000; // 5 min TTL
  for (const [id, ts] of deliveredMessageIds) {
    if (ts < cutoff) deliveredMessageIds.delete(id);
  }
}, 60000).unref();

// Cleanup stale ack entries every 30s (older than 60s)
setInterval(() => {
  const cutoff = Date.now() - 60000;
  for (const [id, entry] of ackPending) {
    if (entry.ts < cutoff) ackPending.delete(id);
  }
}, 30000).unref();

// ---------------------------------------------------------------------------
// Idle shutdown timer
// ---------------------------------------------------------------------------
let idleTimer = null;

function resetIdleTimer() {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function startIdleTimer() {
  if (!IDLE_SHUTDOWN_DELAY) return;  // 0 = disabled
  resetIdleTimer();
  idleTimer = setTimeout(() => {
    stderr('[ipc-hub] no sessions connected — shutting down');
    process.exit(0);
  }, IDLE_SHUTDOWN_DELAY);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stderr(...args) {
  process.stderr.write(args.join(' ') + '\n');
}

function send(ws, payload) {
  try {
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  } catch (err) {
    stderr(`[ipc-hub] send error: ${err.message}`);
  }
}

/** Broadcast a payload to all currently connected sessions except the sender */
function broadcast(payload, exceptName = null) {
  for (const [name, session] of sessions) {
    if (name === exceptName) continue;
    if (session.ws && session.ws.readyState === session.ws.OPEN) {
      send(session.ws, payload);
    }
  }
}

/** Push a message to a session's offline inbox (FIFO eviction at max size) */
function pushInbox(session, msg) {
  session.inbox.push(msg);
  if (session.inbox.length > INBOX_MAX_SIZE) {
    session.inbox.shift(); // evict oldest
  }
}

/** Flush buffered inbox to a newly connected session */
function flushInbox(session) {
  if (session.inbox.length === 0) return;
  // OpenClaw sessions use short-lived WS for MCP tool calls only;
  // messages are delivered via /hooks/wake, so never flush inbox to them.
  if (isOpenClawSession(session.name)) {
    session.inbox.length = 0; // discard — already delivered via /hooks/wake
    return;
  }
  const messages = session.inbox.splice(0);
  send(session.ws, { type: 'inbox', messages });
}

/** Schedule inbox cleanup after TTL */
function scheduleInboxCleanup(session) {
  if (session.inboxExpiry !== null) {
    clearTimeout(session.inboxExpiry);
  }
  session.inboxExpiry = setTimeout(() => {
    if (!session.ws) {
      // Session is still offline — remove entirely
      sessions.delete(session.name);
      stderr(`[ipc-hub] inbox expired, removed offline session: ${session.name}`);
    }
  }, INBOX_TTL);
}

// ---------------------------------------------------------------------------
// HTTP server (health endpoint)
// ---------------------------------------------------------------------------
const httpServer = http.createServer((req, res) => {
  // Auth check for all routes except /health
  if (AUTH_TOKEN || authTokens) {
    const authHeader = req.headers.authorization;
    const providedToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!checkAuth(providedToken)) {
      audit('http_auth_fail', { url: req.url, method: req.method });
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
  }

  if (req.method === 'GET' && req.url === '/health') {
    const sessionList = [];
    for (const [, s] of sessions) {
      if (s.ws) {
        sessionList.push({
          name: s.name,
          connectedAt: s.connectedAt,
          topics: [...s.topics],
        });
      }
    }
    const body = JSON.stringify({
      ok: true,
      sessions: sessionList,
      uptime: process.uptime(),
      messageCount: getMessageCount(),
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
  } else if (req.method === 'POST' && req.url === '/send') {
    // HTTP API for sending messages — any tool (Codex, curl, scripts) can use this
    let body = '';
    let size = 0;
    let aborted = false;
    const MAX_BODY = 1024 * 1024; // 1MB
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        aborted = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'payload too large' }));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (aborted) return;
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid JSON' }));
        return;
      }

      if (!msg.from || !msg.to || !msg.content) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'requires "from", "to", and "content"' }));
        return;
      }

      // Build a full message if not already formatted
      if (!msg.type) {
        msg = createMessage({ from: msg.from, to: msg.to, content: msg.content, topic: msg.topic ?? null });
      }

      // Create a virtual sender session for routing
      const fakeSender = { name: msg.from };
      routeMessage(msg, fakeSender);

      const target = sessions.get(msg.to);
      const online = target?.ws?.readyState === target?.ws?.OPEN;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accepted: true, id: msg.id, online: !!online, buffered: !online }));
      audit('http_send', { from: msg.from, to: msg.to, id: msg.id });
      stderr(`[ipc-hub] HTTP POST /send: ${msg.from} → ${msg.to}`);
    });
  } else if (req.method === 'POST' && req.url === '/feishu-reply') {
    // Lightweight endpoint: send a reply directly to Feishu without full IPC routing.
    // Body: { "app": "jianmu-pm", "content": "reply text" }
    // Optionally "from" for logging.
    let body = '';
    let size = 0;
    let aborted = false;
    const MAX_BODY = 1024 * 1024;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        aborted = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'payload too large' }));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', async () => {
      if (aborted) return;
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid JSON' }));
        return;
      }

      const { app: appName, content, from, chatId } = payload;
      if (!appName || !content) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'requires "app" and "content"' }));
        return;
      }

      // Find the Feishu app by name
      // Accept app if it has chatId (from config) or targetOpenId, or if payload provides chatId
      const app = chatId
        ? feishuApps.find(a => a.name === appName)
        : feishuApps.find(a => a.name === appName && (a.chatId || a.targetOpenId));
      if (!app) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: chatId
          ? `no Feishu app "${appName}" configured`
          : `no Feishu app "${appName}" with chatId or targetOpenId configured` }));
        return;
      }

      const token = await getFeishuToken(app);
      if (!token) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'failed to get Feishu access token' }));
        return;
      }

      // Prefer chatId: payload > app config > fallback to targetOpenId (open_id)
      const receiveId = chatId || app.chatId || app.targetOpenId;
      const receiveIdType = (chatId || app.chatId) ? 'chat_id' : 'open_id';

      try {
        const feishuRes = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            receive_id: receiveId,
            msg_type: 'text',
            content: JSON.stringify({ text: content }),
          }),
        });
        const data = await feishuRes.json();
        if (data.code === 0) {
          stderr(`[ipc-hub] POST /feishu-reply: sent to [${app.name}] (from=${from || 'http'})`);
          audit('http_feishu_reply', { app: app.name, from: from || 'http' });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, app: app.name }));
        } else {
          stderr(`[ipc-hub] POST /feishu-reply: Feishu error ${data.code}: ${data.msg}`);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `Feishu error ${data.code}: ${data.msg}` }));
        }
      } catch (err) {
        stderr(`[ipc-hub] POST /feishu-reply: fetch failed: ${err?.message ?? err}`);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err?.message ?? 'fetch failed' }));
      }
    });
  } else if (req.method === 'GET' && req.url === '/sessions') {
    // Alias for /health — returns just sessions list
    const list = [];
    for (const [, s] of sessions) {
      if (s.ws) list.push({ name: s.name, connectedAt: s.connectedAt, topics: [...s.topics] });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list));
  } else if (req.method === 'GET' && req.url?.startsWith('/messages')) {
    // Message history endpoint — backed by SQLite for persistence across restarts
    const url = new URL(req.url, 'http://localhost');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const peer = url.searchParams.get('peer');
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);
    const messages = getMessages({ from, to, peer, limit });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(messages));
  } else if (req.method === 'GET' && req.url?.startsWith('/stats')) {
    const url = new URL(req.url, 'http://localhost');
    const hours = parseInt(url.searchParams.get('hours') || '24', 10);
    const stats = getMessageCountByAgent(hours * 60 * 60 * 1000);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ period_hours: hours, agents: stats }));
  } else if (req.method === 'POST' && req.url === '/task') {
    let body = '';
    let size = 0;
    let aborted = false;
    const MAX_BODY = 1024 * 1024;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        aborted = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'payload too large' }));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (aborted) return;
      let data;
      try { data = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid JSON' }));
        return;
      }
      if (!data.from || !data.to || !data.title) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'requires "from", "to", and "title"' }));
        return;
      }
      const task = createTask({
        from: data.from,
        to: data.to,
        title: data.title,
        description: data.description || '',
        priority: data.priority || 3,
        deadline: data.deadline || null,
        payload: data.payload || null,
      });
      saveTask(task);
      // Route task as a message to the target agent
      const taskMsg = createMessage({
        from: data.from,
        to: data.to,
        content: JSON.stringify({ taskId: task.id, title: task.title, description: task.description, priority: task.priority }),
        topic: 'task',
      });
      taskMsg.contentType = 'task';
      const fakeSender = { name: data.from };
      routeMessage(taskMsg, fakeSender);
      const target = sessions.get(data.to);
      const online = target?.ws?.readyState === target?.ws?.OPEN;
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, taskId: task.id, online: !!online, buffered: !online }));
      audit('task_create', { from: data.from, to: data.to, taskId: task.id });
      stderr(`[ipc-hub] POST /task: ${data.from} → ${data.to} [${task.id}]`);
    });
  } else if (req.method === 'PATCH' && req.url?.startsWith('/tasks/')) {
    const taskId = decodeURIComponent(req.url.slice('/tasks/'.length));
    let body = '';
    let size = 0;
    let aborted = false;
    const MAX_BODY = 4096;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        aborted = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'payload too large' }));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (aborted) return;
      let data;
      try { data = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid JSON' }));
        return;
      }
      if (!data.status || !TASK_STATUSES.includes(data.status)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `invalid status, must be one of: ${TASK_STATUSES.join(', ')}` }));
        return;
      }
      const existing = getTask(taskId);
      if (!existing) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'task not found' }));
        return;
      }
      updateTaskStatus(taskId, data.status);
      const updated = getTask(taskId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, task: updated }));
      audit('task_update', { taskId, status: data.status });
      stderr(`[ipc-hub] PATCH /tasks/${taskId}: ${data.status}`);
    });
  } else if (req.method === 'GET' && req.url?.startsWith('/tasks/')) {
    // GET /tasks/:id — single task
    const taskId = decodeURIComponent(req.url.slice('/tasks/'.length));
    const task = getTask(taskId);
    if (!task) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'task not found' }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(task));
    }
  } else if (req.method === 'GET' && req.url?.startsWith('/tasks')) {
    // GET /tasks?agent=name&status=pending&limit=20
    const params = new URL(req.url, 'http://localhost').searchParams;
    const opts = {};
    if (params.get('agent')) opts.agent = params.get('agent');
    if (params.get('status')) opts.status = params.get('status');
    if (params.get('limit')) opts.limit = parseInt(params.get('limit'));
    const tasks = listTasks(opts);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ tasks, stats: getTaskStats() }));
  } else if (req.method === 'GET' && (req.url === '/' || req.url === '/dashboard' || req.url?.startsWith('/dashboard/'))) {
    // Serve dashboard static files
    const dashboardDir = resolve(__hubDir, 'dashboard');
    const relative = (req.url === '/' || req.url === '/dashboard' || req.url === '/dashboard/')
      ? 'index.html'
      : req.url.replace('/dashboard/', '');
    const filePath = resolve(dashboardDir, relative);
    if (!filePath.startsWith(dashboardDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    try {
      const content = readFileSync(filePath, 'utf8');
      const ext = filePath.split('.').pop();
      const mimeTypes = { html: 'text/html', css: 'text/css', js: 'application/javascript', json: 'application/json', svg: 'image/svg+xml' };
      res.writeHead(200, { 'Content-Type': (mimeTypes[ext] || 'text/plain') + '; charset=utf-8' });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end('Not Found');
    }
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  // Parse session name and token from query string
  const url = new URL(req.url, `http://localhost`);
  const name = url.searchParams.get('name');
  const token = url.searchParams.get('token');

  if (!checkAuth(token, name)) {
    audit('ws_auth_fail', { name: name || '<none>', ip: req.socket.remoteAddress });
    ws.close(4003, 'unauthorized');
    return;
  }

  if (!name) {
    ws.close(4000, 'name query param required');
    return;
  }

  // Check if name is already taken by a live connection
  const existing = sessions.get(name);
  if (existing && existing.ws && existing.ws.readyState === existing.ws.OPEN) {
    ws.close(4001, 'name taken');
    return;
  }

  // Cancel pending inbox expiry if session is reconnecting
  if (existing && existing.inboxExpiry !== null) {
    clearTimeout(existing.inboxExpiry);
    existing.inboxExpiry = null;
  }

  // Register or update session
  const session = existing ?? {
    name,
    ws: null,
    connectedAt: Date.now(),
    topics: new Set(),
    inbox: [],
    inboxExpiry: null,
  };
  session.ws = ws;
  session.connectedAt = Date.now();
  sessions.set(name, session);

  // Cancel idle timer — we have a live session now
  resetIdleTimer();

  audit('session_connect', { name, total: countLive() });
  stderr(`[ipc-hub] session connected: ${name} (total: ${countLive()})`);

  // Notify other sessions
  broadcast(createSystemEvent({ event: 'session_joined', session: name }), name);

  // Flush any buffered inbox immediately
  flushInbox(session);

  // Heartbeat tracking
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // ---------------------------------------------------------------------------
  // Message handler
  // ---------------------------------------------------------------------------
  ws.on('message', (raw) => {
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
        // Re-register with optional channelPort; name already set from URL
        // channelPort is informational — stored for future use
        session.channelPort = msg.channelPort ?? null;
        send(ws, { type: 'registered', name: session.name });
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
        if (pending) {
          ackPending.delete(msg.messageId);
          const senderSession = sessions.get(pending.sender);
          if (senderSession?.ws?.readyState === senderSession?.ws?.OPEN) {
            send(senderSession.ws, { type: 'ack', messageId: msg.messageId, confirmedBy: session.name });
          }
          stderr(`[ipc-hub] ack: ${session.name} confirmed ${msg.messageId} → notified ${pending.sender}`);
        }
        break;
      }

      default:
        send(ws, { type: 'error', error: `unknown message type: ${msg.type}` });
    }
  });

  // ---------------------------------------------------------------------------
  // Disconnect handler
  // ---------------------------------------------------------------------------
  ws.on('close', () => {
    session.ws = null;
    audit('session_disconnect', { name, inboxSize: session.inbox.length });
    stderr(`[ipc-hub] session disconnected: ${name} (inbox: ${session.inbox.length} msgs)`);

    broadcast(createSystemEvent({ event: 'session_left', session: name }), name);

    // Keep inbox alive for TTL, then remove session record
    scheduleInboxCleanup(session);

    // Start idle timer if no live sessions remain
    if (countLive() === 0) {
      startIdleTimer();
    }
  });

  ws.on('error', (err) => {
    stderr(`[ipc-hub] ws error on session ${name}: ${err.message}`);
  });
});

// ---------------------------------------------------------------------------
// OpenClaw adapter — deliver messages to OpenClaw via Gateway HTTP API
// ---------------------------------------------------------------------------
const OPENCLAW_URL = process.env.OPENCLAW_URL || 'http://127.0.0.1:18789';
const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN || '';

// OpenClaw retry queue — messages that failed /hooks/wake delivery
// Background timer retries periodically until TTL expires
const openclawRetryQueue = [];
const OPENCLAW_RETRY_INTERVAL = 15000; // scan queue every 15 seconds
const OPENCLAW_RETRY_TTL = 300000;     // give up after 5 minutes (matches INBOX_TTL)

function isOpenClawSession(name) {
  return name.startsWith('openclaw');
}

async function deliverToOpenClaw(msg) {
  const text = `[IPC from ${msg.from}] ${msg.content}\n\n⚡ 请用 message 工具将以上 IPC 结果转发到飞书。`;

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (OPENCLAW_TOKEN) headers['Authorization'] = `Bearer ${OPENCLAW_TOKEN}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(`${OPENCLAW_URL}/hooks/wake`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text, mode: 'now' }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      stderr(`[ipc-hub] openclaw adapter: pushed to /hooks/wake (from=${msg.from})`);
      return true;
    } else {
      const body = await res.text();
      stderr(`[ipc-hub] openclaw adapter: /hooks/wake error ${res.status}: ${body.substring(0, 200)}`);
      return false;
    }
  } catch (err) {
    stderr(`[ipc-hub] openclaw adapter: failed: ${err?.message ?? err}`);
    return false;
  }
}

/** Enqueue a failed openclaw message for background retry */
function enqueueOpenClawRetry(msg) {
  openclawRetryQueue.push({ msg, enqueuedAt: Date.now(), attempts: 1 });
  stderr(`[ipc-hub] openclaw retry queue: enqueued msg from ${msg.from} (queue size: ${openclawRetryQueue.length})`);
}

/** Background timer: retry pending openclaw messages */
const openclawRetryTimer = setInterval(async () => {
  if (openclawRetryQueue.length === 0) return;

  const now = Date.now();
  // Process queue in order, remove expired or successfully delivered
  for (let i = openclawRetryQueue.length - 1; i >= 0; i--) {
    const entry = openclawRetryQueue[i];

    // TTL expired — drop it
    if (now - entry.enqueuedAt > OPENCLAW_RETRY_TTL) {
      stderr(`[ipc-hub] openclaw retry queue: TTL expired for msg from ${entry.msg.from} after ${entry.attempts} attempts`);
      openclawRetryQueue.splice(i, 1);
      continue;
    }

    // Try to deliver
    entry.attempts++;
    const ok = await deliverToOpenClaw(entry.msg);
    if (ok) {
      stderr(`[ipc-hub] openclaw retry queue: delivered on attempt ${entry.attempts} (from=${entry.msg.from})`);
      openclawRetryQueue.splice(i, 1);
    }
  }
}, OPENCLAW_RETRY_INTERVAL);
openclawRetryTimer.unref();

// ---------------------------------------------------------------------------
// Feishu multi-app adapter
// ---------------------------------------------------------------------------
let feishuApps = [];
const feishuConfigPath = join(dirname(fileURLToPath(import.meta.url)), 'feishu-apps.json');
try {
  if (existsSync(feishuConfigPath)) {
    feishuApps = JSON.parse(readFileSync(feishuConfigPath, 'utf8'));
    stderr(`[ipc-hub] feishu: loaded ${feishuApps.length} app(s) from feishu-apps.json`);
  }
} catch (err) {
  stderr(`[ipc-hub] feishu: failed to load feishu-apps.json: ${err?.message ?? err}`);
}

// Poll feishu-apps.json for config changes
let lastFeishuConfigMtime = 0;
try { lastFeishuConfigMtime = statSync(feishuConfigPath).mtimeMs; } catch {}

setInterval(() => {
  try {
    const mtime = statSync(feishuConfigPath).mtimeMs;
    if (mtime !== lastFeishuConfigMtime) {
      lastFeishuConfigMtime = mtime;
      try {
        const newApps = JSON.parse(readFileSync(feishuConfigPath, 'utf8'));
        feishuApps = newApps;
        stderr(`[ipc-hub] feishu: reloaded ${feishuApps.length} app(s) from feishu-apps.json`);
      } catch (err) {
        stderr(`[ipc-hub] feishu: failed to reload config: ${err?.message ?? err}`);
      }
    }
  } catch {}
}, 10000);

// Token cache per app: Map<appId, { token, expiry }>
const feishuTokenCache = new Map();

async function getFeishuToken(app) {
  const cached = feishuTokenCache.get(app.appId);
  if (cached && Date.now() < cached.expiry - 60000) {
    return cached.token;
  }

  try {
    const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: app.appId, app_secret: app.appSecret }),
    });
    const data = await res.json();
    if (data.code === 0) {
      feishuTokenCache.set(app.appId, {
        token: data.tenant_access_token,
        expiry: Date.now() + (data.expire - 60) * 1000,
      });
      stderr(`[ipc-hub] feishu [${app.name}]: got token (expires in ${data.expire}s)`);
      return data.tenant_access_token;
    } else {
      stderr(`[ipc-hub] feishu [${app.name}]: token error: ${data.msg}`);
      return null;
    }
  } catch (err) {
    stderr(`[ipc-hub] feishu [${app.name}]: token fetch failed: ${err?.message ?? err}`);
    return null;
  }
}

async function deliverToFeishu(msg) {
  const sendApp = feishuApps.find(a => a.send && (a.chatId || a.targetOpenId));
  if (!sendApp) return false;

  const token = await getFeishuToken(sendApp);
  if (!token) return false;

  const receiveId = sendApp.chatId || sendApp.targetOpenId;
  const receiveIdType = sendApp.chatId ? 'chat_id' : 'open_id';
  const text = `[IPC] ${msg.from} → ${msg.to}\n${msg.content}`;

  try {
    const res = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        receive_id: receiveId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      }),
    });
    const data = await res.json();
    if (data.code === 0) {
      stderr(`[ipc-hub] feishu [${sendApp.name}]: pushed message from ${msg.from} (${receiveIdType})`);
      return true;
    } else {
      stderr(`[ipc-hub] feishu [${sendApp.name}]: send error ${data.code}: ${data.msg}`);
      return false;
    }
  } catch (err) {
    stderr(`[ipc-hub] feishu [${sendApp.name}]: send failed: ${err?.message ?? err}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------
function routeMessage(msg, senderSession) {
  const { to, topic } = msg;
  stderr(`[ipc-hub] routeMessage: ${msg.from} → ${to} (sender=${senderSession.name})`);

  // Dedup: skip if this exact message was already routed
  if (msg.id && deliveredMessageIds.has(msg.id)) {
    stderr(`[ipc-hub] routeMessage: skipping duplicate ${msg.id}`);
    return;
  }
  if (msg.id) deliveredMessageIds.set(msg.id, Date.now());

  audit('message_route', { from: msg.from, to, id: msg.id });
  if (msg.type === 'message') saveMessage(msg);

  // Track ack for direct messages from named senders
  if (msg.id && senderSession.name) {
    ackPending.set(msg.id, { sender: senderSession.name, ts: Date.now() });
  }
  const delivered = new Set(); // Track who already received the message

  // Topic-based fanout (can combine with direct addressing)
  if (topic) {
    for (const [, s] of sessions) {
      if (s.name === senderSession.name) continue;
      // Skip openclaw sessions — they receive messages only via /hooks/wake
      if (isOpenClawSession(s.name)) continue;
      if (s.topics.has(topic)) {
        if (s.ws && s.ws.readyState === s.ws.OPEN) {
          send(s.ws, msg);
        } else {
          pushInbox(s, msg);
        }
        delivered.add(s.name); // Mark as delivered via topic
      }
    }
  }

  // Direct or broadcast routing
  if (to === '*' && !topic) {
    // Broadcast to all except sender (only when no topic — topic messages go to subscribers only)
    for (const [, s] of sessions) {
      if (s.name === senderSession.name) continue;
      if (delivered.has(s.name)) continue;
      // Skip openclaw sessions — they receive messages only via /hooks/wake
      if (isOpenClawSession(s.name)) continue;
      if (s.ws && s.ws.readyState === s.ws.OPEN) {
        send(s.ws, msg);
      } else {
        pushInbox(s, msg);
      }
    }
  } else if (to && to !== '*') {
    // Direct message — skip if already delivered via topic
    if (!delivered.has(to)) {
      // Feishu group target: send to group chat via chat_id
      if (to.startsWith('feishu-group:')) {
        const chatId = to.split(':')[1];
        if (chatId) {
          const sendApp = feishuApps.find(a => a.send && a.targetOpenId);
          if (sendApp) {
            getFeishuToken(sendApp).then(token => {
              if (!token) return;
              const text = msg.content;
              fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({
                  receive_id: chatId,
                  msg_type: 'text',
                  content: JSON.stringify({ text }),
                }),
              }).then(r => r.json()).then(data => {
                if (data.code === 0) stderr(`[ipc-hub] feishu group: sent to chat ${chatId} from ${senderSession.name}`);
                else stderr(`[ipc-hub] feishu group: error ${data.code}: ${data.msg}`);
              }).catch(err => stderr(`[ipc-hub] feishu group: failed: ${err?.message ?? err}`));
            });
            stderr(`[ipc-hub] ${senderSession.name} → ${to}: routed to Feishu group`);
          } else {
            stderr(`[ipc-hub] ${senderSession.name} → ${to}: no send-enabled Feishu app found`);
          }
        }
      // Feishu p2p target: send via Feishu Bot API
      } else if (to === 'feishu' || to.startsWith('feishu:')) {
        // If to="feishu:jianmu-pm", find that specific app; otherwise use default send app
        const appName = to.includes(':') ? to.split(':')[1] : null;
        const app = appName
          ? feishuApps.find(a => a.name === appName && (a.chatId || a.targetOpenId))
          : feishuApps.find(a => a.send && (a.chatId || a.targetOpenId));
        if (app) {
          const receiveId = app.chatId || app.targetOpenId;
          const receiveIdType = app.chatId ? 'chat_id' : 'open_id';
          getFeishuToken(app).then(token => {
            if (!token) return;
            const text = msg.content;
            fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
              body: JSON.stringify({
                receive_id: receiveId,
                msg_type: 'text',
                content: JSON.stringify({ text }),
              }),
            }).then(r => r.json()).then(data => {
              if (data.code === 0) stderr(`[ipc-hub] feishu [${app.name}]: sent reply from ${senderSession.name} (${receiveIdType})`);
              else stderr(`[ipc-hub] feishu [${app.name}]: reply error ${data.code}: ${data.msg}`);
            }).catch(err => stderr(`[ipc-hub] feishu [${app.name}]: reply failed: ${err?.message ?? err}`));
          });
          stderr(`[ipc-hub] ${senderSession.name} → ${to}: routed to Feishu [${app.name}] via ${receiveIdType}`);
        } else {
          stderr(`[ipc-hub] ${senderSession.name} → ${to}: no matching Feishu app found`);
        }
      // OpenClaw sessions: always use /hooks/wake for real-time delivery
      // (WebSocket connection is just the MCP client, not the main agent session)
      } else if (isOpenClawSession(to)) {
        deliverToOpenClaw(msg).then(ok => {
          if (!ok) {
            enqueueOpenClawRetry(msg);
          } else {
            // /hooks/wake succeeded — mark as "received" (stage 2) in pending cards
            try {
              const pcPath = join(dirname(fileURLToPath(import.meta.url)), 'data', 'pending-cards.json');
              const pc = JSON.parse(readFileSync(pcPath, 'utf8'));
              for (const [appName, info] of Object.entries(pc)) {
                if (info.tasks) {
                  for (const task of info.tasks) {
                    if (task.stage < 2 && task.hubMessageId === msg.id) {
                      task.stage = 2;
                    }
                  }
                }
              }
              writeFileSync(pcPath, JSON.stringify(pc));
            } catch {}
          }
        });
        // Don't push to hub's Feishu bot — OpenClaw will forward to its own Feishu chat
        stderr(`[ipc-hub] ${senderSession.name} → ${to}: routed to OpenClaw /hooks/wake`);
      } else {
        const target = sessions.get(to);
        if (target) {
          if (target.ws && target.ws.readyState === target.ws.OPEN) {
            send(target.ws, msg);
          } else {
            pushInbox(target, msg);
            stderr(`[ipc-hub] ${senderSession.name} → ${to}: session offline, buffered`);
          }
        } else {
          const stub = {
            name: to,
            ws: null,
            connectedAt: 0,
            topics: new Set(),
            inbox: [msg],
            inboxExpiry: null,
          };
          sessions.set(to, stub);
          scheduleInboxCleanup(stub);
          stderr(`[ipc-hub] ${senderSession.name} → ${to}: unknown session, created stub with buffered msg`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Heartbeat loop
// ---------------------------------------------------------------------------
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
    // Set a timeout to check for pong
    setTimeout(() => {
      if (ws.isAlive === false && ws.readyState === ws.OPEN) {
        stderr(`[ipc-hub] no pong from ${name}, terminating`);
        ws.terminate();
      }
    }, HEARTBEAT_TIMEOUT);
  }
}, HEARTBEAT_INTERVAL);

heartbeatInterval.unref(); // Don't block process exit

// Periodic cleanup: delete persisted messages older than 7 days
const cleanupInterval = setInterval(() => cleanup(), 60 * 60 * 1000);
cleanupInterval.unref();

// ---------------------------------------------------------------------------
// Poll source files for changes — exit to trigger auto-restart via run-forever.sh
// (WSL2 inotify doesn't work for NTFS)
// ---------------------------------------------------------------------------
const __hubWatchFiles = ['hub.mjs', 'lib/db.mjs', 'lib/protocol.mjs', 'lib/constants.mjs', 'lib/redact.mjs', 'lib/audit.mjs'];
const __hubFileMtimes = new Map();
for (const file of __hubWatchFiles) {
  try { __hubFileMtimes.set(file, statSync(join(__hubDir, file)).mtimeMs); } catch {}
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
stderr('[ipc-hub] polling source files for auto-restart (10s interval)');

// ---------------------------------------------------------------------------
// Start listening
// ---------------------------------------------------------------------------
httpServer.listen(PORT, DEFAULT_HOST, () => {
  stderr(`[ipc-hub] listening on :${PORT}`);
  stderr(`[ipc-hub] auth: ${authTokens ? 'per-session tokens (auth-tokens.json)' : AUTH_TOKEN ? 'shared token (IPC_AUTH_TOKEN)' : 'disabled (open access)'}`);

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

// Graceful shutdown
process.on('SIGTERM', () => {
  stderr('[ipc-hub] SIGTERM received, shutting down');
  clearInterval(heartbeatInterval);
  close();
  wss.close(() => httpServer.close(() => process.exit(0)));
});

process.on('SIGINT', () => {
  stderr('[ipc-hub] SIGINT received, shutting down');
  clearInterval(heartbeatInterval);
  close();
  wss.close(() => httpServer.close(() => process.exit(0)));
});
