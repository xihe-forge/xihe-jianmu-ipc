/**
 * lib/http-handlers.mjs — HTTP端点处理模块
 *
 * 通过闭包+ctx依赖注入模式，返回 (req, res) => void 函数。
 *
 * 端点清单：
 *   GET  /health
 *   POST /send
 *   POST /feishu-reply
 *   GET  /sessions
 *   GET  /messages
 *   GET  /stats
 *   POST /task
 *   GET  /tasks
 *   GET  /tasks/:id
 *   PATCH /tasks/:id
 *   GET  / | /dashboard | /dashboard/*
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 创建HTTP请求处理函数
 *
 * @param {object} ctx
 * @param {Map}      ctx.sessions            — 会话注册表
 * @param {Function} ctx.routeMessage        — 消息路由函数（来自router.mjs）
 * @param {Function} ctx.checkAuth           — 认证函数
 * @param {object|null} ctx.authTokens       — 多session token表（或null）
 * @param {string|null} ctx.AUTH_TOKEN       — 全局共享token（或null）
 * @param {Function} ctx.createMessage       — 消息工厂
 * @param {Function} ctx.createTask          — 任务工厂
 * @param {Array}    ctx.TASK_STATUSES       — 合法任务状态列表
 * @param {Function} ctx.saveTask            — 持久化任务
 * @param {Function} ctx.getTask             — 查询单个任务
 * @param {Function} ctx.updateTaskStatus    — 更新任务状态
 * @param {Function} ctx.listTasks           — 列举任务
 * @param {Function} ctx.getTaskStats        — 任务统计
 * @param {Function} ctx.getMessages         — 查询消息历史
 * @param {Function} ctx.getMessageCount     — 消息总数
 * @param {Function} ctx.getMessageCountByAgent — 按agent统计消息数
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
    checkAuth,
    authTokens,
    AUTH_TOKEN,
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
    feishuApps,
    getFeishuToken,
    stderr,
    audit,
    hubDir,
  } = ctx;

  return function handleRequest(req, res) {
    // ---- 认证检查（/health除外所有路由均检查）----
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

        // 若不是完整格式消息则自动构建
        if (!msg.type) {
          msg = createMessage({ from: msg.from, to: msg.to, content: msg.content, topic: msg.topic ?? null });
        }

        // 用虚拟发送方会话进行路由
        const fakeSender = { name: msg.from };
        routeMessage(msg, fakeSender);

        const target = sessions.get(msg.to);
        const online = target?.ws?.readyState === target?.ws?.OPEN;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ accepted: true, id: msg.id, online: !!online, buffered: !online }));
        audit('http_send', { from: msg.from, to: msg.to, id: msg.id });
        stderr(`[ipc-hub] HTTP POST /send: ${msg.from} → ${msg.to}`);
      });

    // ---- POST /feishu-reply ----
    } else if (req.method === 'POST' && req.url === '/feishu-reply') {
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

        // 查找飞书app配置（有chatId传入时宽松匹配）
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

        // 优先级：payload.chatId > app.chatId > app.targetOpenId
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
        // 将任务作为消息路由给目标agent
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

    // ---- PATCH /tasks/:id ----
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
    } else if (req.method === 'GET' && (req.url === '/' || req.url === '/dashboard' || req.url?.startsWith('/dashboard/'))) {
      const dashboardDir = resolve(hubDir, 'dashboard');
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

    // ---- 404 ----
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  };
}
