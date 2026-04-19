/**
 * lib/http-handlers.mjs — HTTP端点处理模块
 *
 * 通过闭包+ctx依赖注入模式，返回 (req, res) => void 函数。
 *
 * 端点清单：
 *   GET  /health
 *   POST /send
 *   POST /prepare-rebind
 *   POST /suspend
 *   POST /wake-suspended
 *   POST /feishu-reply
 *   POST /registry/register
 *   POST /registry/update
 *   GET  /sessions
 *   GET  /messages
 *   GET  /recent-messages
 *   GET  /stats
 *   POST /task
 *   GET  /tasks
 *   GET  /tasks/:id
 *   PATCH /tasks/:id
 *   GET  / | /dashboard | /dashboard/*
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { isLoopbackAddress } from './internal-auth.mjs';

/**
 * 创建HTTP请求处理函数
 *
 * @param {object} ctx
 * @param {Map}      ctx.sessions            — 会话注册表
 * @param {Function} ctx.routeMessage        — 消息路由函数（来自router.mjs）
 * @param {Function} ctx.broadcastToTopic    — topic广播函数（来自router.mjs）
 * @param {Function} ctx.broadcastNetworkDown — 广播 network-down 事件
 * @param {Function} ctx.broadcastNetworkUp  — 广播 network-up 事件并清理挂起表
 * @param {Function} ctx.checkAuth           — 认证函数
 * @param {object|null} ctx.authTokens       — 多session token表（或null）
 * @param {string|null} ctx.AUTH_TOKEN       — 全局共享token（或null）
 * @param {string}   ctx.INTERNAL_TOKEN      — Hub/watchdog 内部共享token
 * @param {Function} ctx.createMessage       — 消息工厂
 * @param {Function} ctx.createTask          — 任务工厂
 * @param {Array}    ctx.TASK_STATUSES       — 合法任务状态列表
 * @param {Function} ctx.saveTask            — 持久化任务
 * @param {Function} ctx.getTask             — 查询单个任务
 * @param {Function} ctx.updateTaskStatus    — 更新任务状态
 * @param {Function} ctx.listTasks           — 列举任务
 * @param {Function} ctx.getTaskStats        — 任务统计
 * @param {Function} ctx.getMessages         — 查询消息历史
 * @param {Function} ctx.getRecipientRecent  — 查询session近期消息
 * @param {Function} ctx.getMessageCount     — 消息总数
 * @param {Function} ctx.getMessageCountByAgent — 按agent统计消息数
 * @param {Function} ctx.suspendSession      — 记录挂起 session
 * @param {string}   ctx.ERR_REBIND_PENDING  — pending_rebind 冲突错误码
 * @param {Function} ctx.createPendingRebind — 创建 pending_rebind 记录
 * @param {Function} ctx.registerSessionRecord — 注册/更新 session registry 记录
 * @param {Function} ctx.updateSessionRecordProjects — 仅更新 session registry projects
 * @param {Array}    ctx.feishuApps          — 飞书应用配置
 * @param {Function} ctx.getFeishuToken      — 获取飞书token
 * @param {Function} ctx.stderr              — stderr输出
 * @param {Function} ctx.audit               — 审计日志
 * @param {string}   ctx.hubDir              — Hub根目录（用于静态文件）
 */
export function createHttpHandler(ctx) {
  const {
    sessions,
    routeMessage,
    broadcastToTopic,
    broadcastNetworkDown,
    broadcastNetworkUp,
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
    getRecipientRecent,
    getMessageCount,
    getMessageCountByAgent,
    suspendSession,
    ERR_REBIND_PENDING,
    createPendingRebind,
    registerSessionRecord,
    updateSessionRecordProjects,
    feishuApps,
    getFeishuToken,
    stderr,
    audit,
    hubDir,
    now = Date.now,
  } = ctx;
  const VALID_SUSPENDED_BY = new Set(['self', 'watchdog', 'harness']);
  const VALID_INTERNAL_EVENTS = new Set(['network-down', 'network-up']);
  const INTERNAL_EVENT_DEDUP_TTL_MS = 5_000;
  const internalEventDeduper = new Map();
  const DEFAULT_RECENT_SINCE_MS = 6 * 60 * 60 * 1000;
  const MAX_RECENT_SINCE_MS = 7 * 24 * 60 * 60 * 1000;
  const DEFAULT_RECENT_LIMIT = 50;
  const MAX_RECENT_LIMIT = 500;

  function clampRecentSince(value) {
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_RECENT_SINCE_MS;
    return Math.min(value, MAX_RECENT_SINCE_MS);
  }

  function clampRecentLimit(value) {
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_RECENT_LIMIT;
    return Math.min(Math.trunc(value), MAX_RECENT_LIMIT);
  }

  function readJsonBody(req, res, onSuccess, { maxBody = 1024 * 1024, allowEmpty = false } = {}) {
    let body = '';
    let size = 0;
    let aborted = false;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBody) {
        aborted = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'payload too large' }));
        req.destroy();
        return;
      }
      body += chunk;
    });

    req.on('end', async () => {
      if (aborted) return;

      let payload = {};
      if (body.trim() !== '') {
        try {
          payload = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
          return;
        }
      } else if (!allowEmpty) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
        return;
      }

      await onSuccess(payload);
    });
  }

  function getProvidedToken(req) {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.slice(7);
    }

    const customHeader = req.headers['x-ipc-token'];
    if (Array.isArray(customHeader)) {
      return customHeader[0] ?? null;
    }
    return customHeader ?? null;
  }

  function getBearerToken(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return null;
    }
    return authHeader.slice(7);
  }

  function getHeaderSessionName(req) {
    const header = req.headers['x-ipc-session'];
    if (Array.isArray(header)) {
      return typeof header[0] === 'string' ? header[0].trim() : '';
    }
    return typeof header === 'string' ? header.trim() : '';
  }

  function normalizeTopics(topics) {
    if (!Array.isArray(topics)) {
      return null;
    }

    return [
      ...new Set(
        topics
          .filter((topic) => typeof topic === 'string')
          .map((topic) => topic.trim())
          .filter(Boolean),
      ),
    ];
  }

  function pruneInternalEventDeduper(currentTime) {
    for (const [key, expiresAt] of internalEventDeduper) {
      if (expiresAt <= currentTime) {
        internalEventDeduper.delete(key);
      }
    }
  }

  function getFailingHash(failing = []) {
    const normalized = Array.isArray(failing) ? failing.map((name) => String(name)).sort() : [];
    return createHash('sha1').update(JSON.stringify(normalized)).digest('hex');
  }

  function buildInternalEventDedupKey(payload) {
    return `${payload.triggeredBy}:${payload.event}:${payload.ts}:${getFailingHash(payload.failing)}`;
  }

  function validateInternalEventPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return 'invalid payload';
    }

    if (typeof payload.event !== 'string' || payload.event.trim() === '') {
      return 'missing required field: event';
    }
    if (!VALID_INTERNAL_EVENTS.has(payload.event)) {
      return 'invalid event';
    }
    if (typeof payload.triggeredBy !== 'string' || payload.triggeredBy.trim() === '') {
      return 'missing required field: triggeredBy';
    }
    if (!Number.isFinite(payload.ts)) {
      return 'missing required field: ts';
    }

    if (payload.event === 'network-down') {
      if (
        !Array.isArray(payload.failing) ||
        payload.failing.length === 0 ||
        payload.failing.some((name) => typeof name !== 'string')
      ) {
        return 'missing required field: failing';
      }
      if (!Number.isFinite(payload.since)) {
        return 'missing required field: since';
      }
    }

    if (payload.event === 'network-up' && !Number.isFinite(payload.recoveredAfter)) {
      return 'missing required field: recoveredAfter';
    }

    return null;
  }

  return function handleRequest(req, res) {
    if (req.method === 'POST' && req.url === '/internal/network-event') {
      if (!isLoopbackAddress(req.socket.remoteAddress)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'forbidden' }));
        return;
      }

      const internalTokenHeader = Array.isArray(req.headers['x-internal-token'])
        ? req.headers['x-internal-token'][0]
        : req.headers['x-internal-token'];
      if (internalTokenHeader !== INTERNAL_TOKEN) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid token' }));
        return;
      }

      let body = '';
      let size = 0;
      let aborted = false;
      const MAX_BODY = 1024 * 1024;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          aborted = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'payload too large' }));
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
          res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
          return;
        }

        const validationError = validateInternalEventPayload(payload);
        if (validationError) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: validationError }));
          return;
        }

        const currentTime = now();
        pruneInternalEventDeduper(currentTime);
        const dedupKey = buildInternalEventDedupKey(payload);
        const expiresAt = internalEventDeduper.get(dedupKey);
        if (expiresAt && expiresAt > currentTime) {
          audit('http_internal_network_event', {
            event: payload.event,
            triggeredBy: payload.triggeredBy,
            ts: payload.ts,
            deduped: true,
            remoteAddress: req.socket.remoteAddress,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, deduped: true }));
          return;
        }

        internalEventDeduper.set(dedupKey, currentTime + INTERNAL_EVENT_DEDUP_TTL_MS);

        try {
          if (payload.event === 'network-down') {
            const result = await broadcastNetworkDown({
              failing: payload.failing,
              since: payload.since,
              triggeredBy: payload.triggeredBy,
              ts: payload.ts,
            });
            audit('http_internal_network_event', {
              event: payload.event,
              triggeredBy: payload.triggeredBy,
              ts: payload.ts,
              broadcastTo: result.broadcastTo,
              subscribers: result.subscribers,
              failing: [...payload.failing],
              since: payload.since,
            });
            stderr(
              `[ipc-hub] HTTP POST /internal/network-event: network-down broadcasted to ${result.broadcastTo} subscriber(s)`,
            );
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                ok: true,
                broadcastTo: result.broadcastTo,
              }),
            );
            return;
          }

          const result = await broadcastNetworkUp({
            recoveredAfter: payload.recoveredAfter,
            triggeredBy: payload.triggeredBy,
            ts: payload.ts,
          });
          audit('http_internal_network_event', {
            event: payload.event,
            triggeredBy: payload.triggeredBy,
            ts: payload.ts,
            broadcastTo: result.broadcastTo,
            subscribers: result.subscribers,
            recoveredAfter: payload.recoveredAfter,
            clearedSessions: result.clearedSessions,
          });
          stderr(
            `[ipc-hub] HTTP POST /internal/network-event: network-up broadcasted to ${result.broadcastTo} subscriber(s), cleared ${result.clearedSessions.length} suspended session(s)`,
          );
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: true,
              broadcastTo: result.broadcastTo,
              clearedSessions: result.clearedSessions,
            }),
          );
        } catch (error) {
          stderr(`[ipc-hub] HTTP POST /internal/network-event failed: ${error?.message ?? error}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'internal error' }));
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/prepare-rebind') {
      let body = '';
      let size = 0;
      let aborted = false;
      const MAX_BODY = 1024 * 1024;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          aborted = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'payload too large' }));
          req.destroy();
          return;
        }
        body += chunk;
      });
      req.on('end', () => {
        if (aborted) return;

        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
          return;
        }

        const requestedName = typeof payload?.name === 'string' ? payload.name.trim() : '';
        const headerSessionName = getHeaderSessionName(req);
        if (!requestedName || (headerSessionName && headerSessionName !== requestedName)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'session not connected' }));
          return;
        }

        if (AUTH_TOKEN || authTokens) {
          const bearerToken = getBearerToken(req);
          if (!bearerToken || !checkAuth(bearerToken, requestedName)) {
            audit('http_auth_fail', { url: req.url, method: req.method, name: requestedName });
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'unauthorized' }));
            return;
          }
        }

        const session = sessions.get(requestedName);
        if (!session?.ws || session.ws.readyState !== session.ws.OPEN) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'session not connected' }));
          return;
        }

        const ttlSeconds = payload?.ttl_seconds === undefined ? 5 : Number(payload.ttl_seconds);
        if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'ttl_seconds must be positive' }));
          return;
        }
        if (ttlSeconds > 60) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'ttl_seconds max 60' }));
          return;
        }

        const topics = normalizeTopics(payload?.topics) ?? [...session.topics];
        const releasedAt = now();

        try {
          createPendingRebind({
            name: requestedName,
            lastTopics: topics,
            releasedAt,
            ttlSeconds,
            nextSessionHint:
              typeof payload?.next_session_hint === 'string' ? payload.next_session_hint : null,
          });
        } catch (error) {
          if (error?.code === ERR_REBIND_PENDING) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                ok: false,
                error: 'rebind already pending',
                will_release_at: error.willReleaseAt,
              }),
            );
            return;
          }

          stderr(`[ipc-hub] HTTP POST /prepare-rebind failed: ${error?.message ?? error}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'internal error' }));
          return;
        }

        session.gracefulReleasing = true;
        audit('prepare_rebind', {
          name: requestedName,
          ttl_seconds: ttlSeconds,
          topics,
          next_session_hint:
            typeof payload?.next_session_hint === 'string' ? payload.next_session_hint : null,
        });

        const willReleaseAt = releasedAt + ttlSeconds * 1000;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            will_release_at: willReleaseAt,
            ttl_seconds: ttlSeconds,
          }),
        );
      });
      return;
    }

    // ---- 认证检查（/health除外所有路由均检查）----
    if (AUTH_TOKEN || authTokens) {
      const providedToken = getProvidedToken(req);
      if (!checkAuth(providedToken)) {
        audit('http_auth_fail', { url: req.url, method: req.method });
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
    }

    // ---- GET /health ----
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

      // ---- POST /send ----
    } else if (req.method === 'POST' && req.url === '/send') {
      let body = '';
      let size = 0;
      let aborted = false;
      const MAX_BODY = 1024 * 1024; // 1MB
      req.on('data', (chunk) => {
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

        // 若不是完整格式消息则自动构建
        if (!msg.type) {
          msg = createMessage({
            from: msg.from,
            to: msg.to,
            content: msg.content,
            topic: msg.topic ?? null,
          });
        }

        // 用虚拟发送方会话进行路由
        const fakeSender = { name: msg.from };
        routeMessage(msg, fakeSender);

        const target = sessions.get(msg.to);
        const online = target?.ws?.readyState === target?.ws?.OPEN;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ accepted: true, id: msg.id, online: !!online, buffered: !online }),
        );
        audit('http_send', { from: msg.from, to: msg.to, id: msg.id });
        stderr(`[ipc-hub] HTTP POST /send: ${msg.from} → ${msg.to}`);
      });

      // ---- POST /suspend ----
    } else if (req.method === 'POST' && req.url === '/suspend') {
      let body = '';
      let size = 0;
      let aborted = false;
      const MAX_BODY = 1024 * 1024;
      req.on('data', (chunk) => {
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

        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
          return;
        }

        const name = typeof payload?.from === 'string' ? payload.from.trim() : '';
        if (!name) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'missing required field: from' }));
          return;
        }

        const suspendedBy = payload?.suspended_by === undefined ? 'self' : payload.suspended_by;
        if (!VALID_SUSPENDED_BY.has(suspendedBy)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid suspended_by' }));
          return;
        }

        const suspended = suspendSession({
          name,
          reason: typeof payload?.reason === 'string' ? payload.reason : null,
          task_description:
            typeof payload?.task_description === 'string' ? payload.task_description : null,
          suspended_by: suspendedBy,
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            name: suspended.name,
            suspended_at: suspended.suspended_at,
            suspended_by: suspended.suspended_by,
          }),
        );
        audit('http_suspend', {
          name: suspended.name,
          suspended_by: suspended.suspended_by,
        });
        stderr(`[ipc-hub] HTTP POST /suspend: ${suspended.name} (${suspended.suspended_by})`);
      });

      // ---- POST /wake-suspended ----
    } else if (req.method === 'POST' && req.url === '/wake-suspended') {
      let body = '';
      let size = 0;
      let aborted = false;
      const MAX_BODY = 1024 * 1024;
      req.on('data', (chunk) => {
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

        let payload = {};
        if (body.trim() !== '') {
          try {
            payload = JSON.parse(body);
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
            return;
          }
        }

        const result = await broadcastNetworkUp({ triggeredBy: 'manual' });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            broadcastTo: result.broadcastTo,
            subscribers: result.subscribers,
            clearedSessions: result.clearedSessions,
          }),
        );
        audit('http_wake_suspended', {
          broadcastTo: result.broadcastTo,
          subscribers: result.subscribers,
          clearedSessions: result.clearedSessions,
        });
        stderr(
          `[ipc-hub] HTTP POST /wake-suspended: broadcasted to ${result.broadcastTo} network-up subscriber(s), cleared ${result.clearedSessions.length} suspended session(s)`,
        );
      });

      // ---- POST /feishu-reply ----
    } else if (req.method === 'POST' && req.url === '/feishu-reply') {
      let body = '';
      let size = 0;
      let aborted = false;
      const MAX_BODY = 1024 * 1024;
      req.on('data', (chunk) => {
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

        // 查找飞书app配置（有chatId传入时宽松匹配）
        const app = chatId
          ? feishuApps.find((a) => a.name === appName)
          : feishuApps.find((a) => a.name === appName && (a.chatId || a.targetOpenId));
        if (!app) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: chatId
                ? `no Feishu app "${appName}" configured`
                : `no Feishu app "${appName}" with chatId or targetOpenId configured`,
            }),
          );
          return;
        }

        const token = await getFeishuToken(app);
        if (!token) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'failed to get Feishu access token' }));
          return;
        }

        // 优先级：payload.chatId > app.chatId > app.targetOpenId
        const receiveId = chatId || app.chatId || app.targetOpenId;
        const receiveIdType = chatId || app.chatId ? 'chat_id' : 'open_id';

        try {
          const feishuRes = await fetch(
            `https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({
                receive_id: receiveId,
                msg_type: 'text',
                content: JSON.stringify({ text: content }),
              }),
            },
          );
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

      // ---- POST /registry/register ----
    } else if (req.method === 'POST' && req.url === '/registry/register') {
      readJsonBody(req, res, async (payload) => {
        const name = typeof payload?.name === 'string' ? payload.name.trim() : '';
        if (!name) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'name is required' }));
          return;
        }

        if (payload?.projects !== undefined && !Array.isArray(payload.projects)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'projects must be an array of strings' }));
          return;
        }

        const requestedBy =
          typeof payload?.requested_by === 'string' && payload.requested_by.trim() !== ''
            ? payload.requested_by.trim()
            : 'unknown';

        try {
          const result = await registerSessionRecord(payload, { updatedBy: requestedBy });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
          audit('registry_register', {
            name,
            action: result.action,
            requested_by: requestedBy,
          });
          stderr(`[ipc-hub] POST /registry/register: ${name} (${result.action}) by ${requestedBy}`);
        } catch (error) {
          stderr(`[ipc-hub] POST /registry/register failed: ${error?.message ?? error}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'internal error' }));
        }
      });

      // ---- POST /registry/update ----
    } else if (req.method === 'POST' && req.url === '/registry/update') {
      readJsonBody(req, res, async (payload) => {
        const name = typeof payload?.name === 'string' ? payload.name.trim() : '';
        if (!name) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'name is required' }));
          return;
        }
        if (!Array.isArray(payload?.projects)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'projects must be an array of strings' }));
          return;
        }

        const requestedBy =
          typeof payload?.requested_by === 'string' && payload.requested_by.trim() !== ''
            ? payload.requested_by.trim()
            : 'unknown';

        try {
          const result = await updateSessionRecordProjects(payload, { updatedBy: requestedBy });
          res.writeHead(result?.ok === false ? 404 : 200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
          audit('registry_update', {
            name,
            requested_by: requestedBy,
            ok: result?.ok !== false,
          });
          stderr(`[ipc-hub] POST /registry/update: ${name} by ${requestedBy}`);
        } catch (error) {
          stderr(`[ipc-hub] POST /registry/update failed: ${error?.message ?? error}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'internal error' }));
        }
      });

      // ---- GET /sessions ----
    } else if (req.method === 'GET' && req.url === '/sessions') {
      const list = [];
      for (const [, s] of sessions) {
        if (s.ws) list.push({ name: s.name, connectedAt: s.connectedAt, topics: [...s.topics] });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(list));

      // ---- GET /messages ----
    } else if (req.method === 'GET' && req.url?.startsWith('/messages')) {
      const url = new URL(req.url, 'http://localhost');
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      const peer = url.searchParams.get('peer');
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const messages = getMessages({ from, to, peer, limit });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(messages));

      // ---- GET /recent-messages ----
    } else if (req.method === 'GET' && req.url?.startsWith('/recent-messages')) {
      const url = new URL(req.url, 'http://localhost');
      const name = url.searchParams.get('name')?.trim() || '';
      if (!name) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'name query param required' }));
        return;
      }

      const since = clampRecentSince(
        Number(url.searchParams.get('since') ?? DEFAULT_RECENT_SINCE_MS),
      );
      const limit = clampRecentLimit(Number(url.searchParams.get('limit') ?? DEFAULT_RECENT_LIMIT));
      const messages = getRecipientRecent(name, since, limit);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name, since, limit, messages }));

      // ---- GET /stats ----
    } else if (req.method === 'GET' && req.url?.startsWith('/stats')) {
      const url = new URL(req.url, 'http://localhost');
      const hours = parseInt(url.searchParams.get('hours') || '24', 10);
      const stats = getMessageCountByAgent(hours * 60 * 60 * 1000);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ period_hours: hours, agents: stats }));

      // ---- POST /task ----
    } else if (req.method === 'POST' && req.url === '/task') {
      let body = '';
      let size = 0;
      let aborted = false;
      const MAX_BODY = 1024 * 1024;
      req.on('data', (chunk) => {
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
        try {
          data = JSON.parse(body);
        } catch {
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
        // 将任务作为消息路由给目标agent
        const taskMsg = createMessage({
          from: data.from,
          to: data.to,
          content: JSON.stringify({
            taskId: task.id,
            title: task.title,
            description: task.description,
            priority: task.priority,
          }),
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

      // ---- PATCH /tasks/:id ----
    } else if (req.method === 'PATCH' && req.url?.startsWith('/tasks/')) {
      const taskId = decodeURIComponent(req.url.slice('/tasks/'.length));
      let body = '';
      let size = 0;
      let aborted = false;
      const MAX_BODY = 4096;
      req.on('data', (chunk) => {
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
        try {
          data = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid JSON' }));
          return;
        }
        if (!data.status || !TASK_STATUSES.includes(data.status)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: `invalid status, must be one of: ${TASK_STATUSES.join(', ')}`,
            }),
          );
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

      // ---- GET /tasks/:id（注意：要在 GET /tasks 之前匹配）----
    } else if (req.method === 'GET' && req.url?.startsWith('/tasks/')) {
      const taskId = decodeURIComponent(req.url.slice('/tasks/'.length));
      const task = getTask(taskId);
      if (!task) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'task not found' }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(task));
      }

      // ---- GET /tasks ----
    } else if (req.method === 'GET' && req.url?.startsWith('/tasks')) {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const opts = {};
      if (params.get('agent')) opts.agent = params.get('agent');
      if (params.get('status')) opts.status = params.get('status');
      if (params.get('limit')) opts.limit = parseInt(params.get('limit'));
      const tasks = listTasks(opts);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tasks, stats: getTaskStats() }));

      // ---- GET / | /dashboard | /dashboard/* 静态文件 ----
    } else if (
      req.method === 'GET' &&
      (req.url === '/' || req.url === '/dashboard' || req.url?.startsWith('/dashboard/'))
    ) {
      const dashboardDir = resolve(hubDir, 'dashboard');
      const relative =
        req.url === '/' || req.url === '/dashboard' || req.url === '/dashboard/'
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
        const mimeTypes = {
          html: 'text/html',
          css: 'text/css',
          js: 'application/javascript',
          json: 'application/json',
          svg: 'image/svg+xml',
        };
        res.writeHead(200, {
          'Content-Type': (mimeTypes[ext] || 'text/plain') + '; charset=utf-8',
        });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end('Not Found');
      }

      // ---- 404 ----
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  };
}
