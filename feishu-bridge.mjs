#!/usr/bin/env node
/**
 * feishu-bridge.mjs — Multi-app Feishu message relay (orchestrator)
 *
 * For each receive-enabled app in feishu-apps.json, spawns a dedicated
 * worker_thread running lib/feishu-worker-thread.mjs. This avoids Lark SDK
 * global state conflicts between multiple WSClient instances.
 *
 * Watches feishu-apps.json for changes and hot-reloads: adds new apps,
 * removes deleted apps, restarts changed apps, keeps unchanged ones running.
 *
 * Usage: node feishu-bridge.mjs
 * Config: feishu-apps.json
 */

import { Worker } from 'node:worker_threads';
import { readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { parseCommand } from './lib/command-parser.mjs';
import { startTracking, getAllStatus, getHubHealth, markActivity, onStatusChange } from './lib/agent-status.mjs';
import { buildStatusCard, buildHelpCard, buildDispatchCard, buildBroadcastCard, buildApprovalCard, buildReportCard, buildErrorCard } from './lib/console-cards.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HUB_HOST = process.env.IPC_HUB_HOST || '127.0.0.1';
const HUB_PORT = process.env.IPC_PORT || '3179';
const CONFIG_PATH = resolve(__dirname, 'feishu-apps.json');
const WORKER_PATH = new URL('./lib/feishu-worker-thread.mjs', import.meta.url);

function log(...args) {
  process.stderr.write(`[feishu-bridge] ${args.join(' ')}\n`);
}

// ---------------------------------------------------------------------------
//  Hub communication
// ---------------------------------------------------------------------------

function sendToHub(from, to, content) {
  return new Promise((ok, fail) => {
    const body = JSON.stringify({ from, to, content });
    const req = http.request(
      {
        hostname: HUB_HOST,
        port: parseInt(HUB_PORT),
        path: '/send',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try {
            ok(JSON.parse(buf));
          } catch {
            ok({ ok: false });
          }
        });
      },
    );
    req.on('error', fail);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
//  Feishu status reply via Hub's /feishu-reply endpoint
// ---------------------------------------------------------------------------

async function sendFeishuStatus(appName, chatId, text) {
  if (!chatId) return;
  const body = JSON.stringify({ app: appName, content: text, chatId });
  return new Promise((ok) => {
    const req = http.request(
      {
        hostname: HUB_HOST,
        port: parseInt(HUB_PORT),
        path: '/feishu-reply',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => ok());
      },
    );
    req.on('error', () => ok());
    req.setTimeout(5000, () => { req.destroy(); ok(); });
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
//  Interactive card status indicator
// ---------------------------------------------------------------------------

const PENDING_CARDS_FILE = resolve(__dirname, 'data', 'pending-cards.json');

/** @type {Map<string, { chatId: string, cardMessageId: string, tasks: Array<{ id: string, preview: string, stage: number, hubMessageId?: string }> }>} */
const pendingCards = new Map();

/**
 * Build a consolidated summary card showing multiple tasks per chat.
 * @param {Array<{ id: string, preview: string, stage: number }>} tasks
 */
function buildSummaryCard(tasks) {
  const completed = tasks.filter(t => t.stage >= 3).length;
  const total = tasks.length;
  const allDone = completed === total;

  const stageEmoji = (stage) => {
    if (stage >= 3) return '✅';
    if (stage >= 2) return '🔄';
    return '📨';
  };

  const stageText = (stage) => {
    if (stage >= 3) return '已完成';
    if (stage >= 2) return '处理中';
    return '已送达';
  };

  const lines = tasks.map(t =>
    `${stageEmoji(t.stage)} "${t.preview}"  —  ${stageText(t.stage)}`
  ).join('\n');

  const title = allDone
    ? `✅ 全部完成 (${total}/${total})`
    : `⏳ 处理中 (${completed}/${total} 已完成)`;
  const template = allDone ? 'green' : 'wathet';

  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: lines } },
    ],
  };
}

/** Load feishu-apps.json (needed for token retrieval in bridge) */
let currentApps = [];
try { currentApps = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch {}

/** Token cache per app: Map<appId, { token, expiry }> */
const bridgeTokenCache = new Map();

async function getAppToken(app) {
  const cached = bridgeTokenCache.get(app.appId);
  if (cached && Date.now() < cached.expiry - 60000) return cached.token;
  try {
    const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: app.appId, app_secret: app.appSecret }),
    });
    const data = await res.json();
    if (data.code === 0) {
      bridgeTokenCache.set(app.appId, {
        token: data.tenant_access_token,
        expiry: Date.now() + (data.expire - 60) * 1000,
      });
      return data.tenant_access_token;
    }
    log(`[${app.name}] token error: ${data.msg}`);
    return null;
  } catch (err) {
    log(`[${app.name}] token fetch failed: ${err.message}`);
    return null;
  }
}

async function sendStatusCard(appName, chatId, replyToMessageId, statusTextOrCard) {
  const app = currentApps.find(a => a.name === appName);
  if (!app) return null;
  const token = await getAppToken(app);
  if (!token) return null;

  // Accept either a plain string (legacy) or a card object from buildProgressCard
  const card = typeof statusTextOrCard === 'string'
    ? {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: statusTextOrCard }, template: 'wathet' },
        elements: [{ tag: 'div', text: { tag: 'lark_md', content: '正在处理您的请求...' } }],
      }
    : statusTextOrCard;

  try {
    const body = {
      receive_id: chatId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    };
    if (replyToMessageId) {
      body.reply_to_message_id = replyToMessageId;
    }

    const res = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.code === 0) {
      return data.data?.message_id;
    }
    log(`[${appName}] send status card failed: ${data.msg}`);
    return null;
  } catch (err) {
    log(`[${appName}] send status card error: ${err.message}`);
    return null;
  }
}

async function pinMessage(appName, messageId) {
  const app = currentApps.find(a => a.name === appName);
  if (!app) return;
  const token = await getAppToken(app);
  if (!token) return;
  try {
    await fetch('https://open.feishu.cn/open-apis/im/v1/pins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ message_id: messageId }),
    });
  } catch {}
}

async function unpinMessage(appName, messageId) {
  const app = currentApps.find(a => a.name === appName);
  if (!app) return;
  const token = await getAppToken(app);
  if (!token) return;
  try {
    await fetch(`https://open.feishu.cn/open-apis/im/v1/pins/${messageId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
  } catch {}
}

async function updateStatusCard(appName, cardMessageId, titleOrCard, content, template) {
  const app = currentApps.find(a => a.name === appName);
  if (!app) return;
  const token = await getAppToken(app);
  if (!token) return;

  // Accept either (appName, id, cardObj) or (appName, id, title, content, template)
  const card = typeof titleOrCard === 'object'
    ? titleOrCard
    : {
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: titleOrCard }, template: template || 'green' },
        elements: [{ tag: 'div', text: { tag: 'lark_md', content: content } }],
      };

  try {
    await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${cardMessageId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ msg_type: 'interactive', content: JSON.stringify(card) }),
    });
  } catch {}
}

function savePendingCards() {
  try {
    const obj = {};
    for (const [key, val] of pendingCards) {
      obj[key] = {
        chatId: val.chatId || null,
        cardMessageId: val.cardMessageId,
        tasks: val.tasks || [],
        ts: Date.now(),
      };
    }
    mkdirSync(dirname(PENDING_CARDS_FILE), { recursive: true });
    writeFileSync(PENDING_CARDS_FILE, JSON.stringify(obj));
  } catch (err) {
    log(`save pending cards failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
//  Worker lifecycle
// ---------------------------------------------------------------------------

/** @type {Map<string, { worker: Worker, app: object }>} */
const workers = new Map();

/** Names we intentionally stopped — skip auto-restart */
const suppressRestart = new Set();

function startWorker(app) {
  log(`[${app.name}] spawning worker_thread...`);

  const worker = new Worker(WORKER_PATH, {
    workerData: { app, dataDir: __dirname },
  });

  worker.on('message', (msg) => {
    switch (msg.type) {
      case 'connected':
        log(`[${msg.appName}] worker connected`);
        break;
      case 'bot_info':
        log(`[${msg.appName}] bot open_id: ${msg.botOpenId}`);
        break;
      case 'feishu_message':
        handleWorkerMessage(msg);
        break;
      case 'card_action':
        handleCardAction(msg.data, msg.appName);
        break;
      default:
        log(`[${app.name}] unknown worker msg: ${msg.type}`);
    }
  });

  worker.on('error', (err) => {
    log(`[${app.name}] worker error: ${err.message}`);
  });

  worker.on('exit', (code) => {
    log(`[${app.name}] worker exited (code=${code})`);
    workers.delete(app.name);

    if (!suppressRestart.has(app.name)) {
      log(`[${app.name}] restarting in 5s...`);
      setTimeout(() => {
        if (!suppressRestart.has(app.name) && !workers.has(app.name)) {
          startWorker(app);
        }
      }, 5000);
    }
  });

  workers.set(app.name, { worker, app });
}

async function stopWorker(appName) {
  const entry = workers.get(appName);
  if (!entry) return;
  suppressRestart.add(appName);
  log(`[${appName}] terminating worker...`);
  try {
    await entry.worker.terminate();
  } catch (err) {
    log(`[${appName}] terminate error: ${err.message}`);
  }
  workers.delete(appName);
}

async function handleConsoleCommand(cmd, msg) {
  const { appName, chatId, messageId } = msg;
  log(`[${appName}] console command: ${cmd.type}`);

  switch (cmd.type) {
    case 'status': {
      const agents = getAllStatus();
      const health = getHubHealth();
      const card = buildStatusCard(agents, health);
      await sendStatusCard(appName, chatId, messageId, card);
      break;
    }

    case 'help': {
      const card = buildHelpCard();
      await sendStatusCard(appName, chatId, messageId, card);
      break;
    }

    case 'dispatch': {
      try {
        const result = await sendToHub(`feishu:${appName}`, cmd.target, cmd.content);
        markActivity(cmd.target);
        const sent = !!(result?.online);
        const card = buildDispatchCard(cmd.target, cmd.content, result?.id, sent);
        await sendStatusCard(appName, chatId, messageId, card);
      } catch (err) {
        log(`[${appName}] dispatch failed: ${err.message}`);
        const card = buildErrorCard('派发失败', `无法将任务发送给 ${cmd.target}: ${err.message}`);
        await sendStatusCard(appName, chatId, messageId, card);
      }
      break;
    }

    case 'broadcast': {
      const agents = getAllStatus();
      const onlineAgents = agents.filter(a => a.online);
      let sentCount = 0;
      for (const agent of onlineAgents) {
        try {
          await sendToHub(`feishu:${appName}`, agent.name, cmd.content);
          markActivity(agent.name);
          sentCount++;
        } catch {}
      }
      const card = buildBroadcastCard(cmd.content, sentCount, agents.length);
      await sendStatusCard(appName, chatId, messageId, card);
      break;
    }

    case 'restart': {
      // For now, only support restarting feishu workers
      const target = cmd.target;
      if (target === 'bridge') {
        await sendFeishuStatus(appName, chatId, '🔄 Bridge正在重启...');
        setTimeout(() => process.exit(0), 1000); // run-forever.sh restarts
      } else if (target === 'hub') {
        await sendFeishuStatus(appName, chatId, '⚠️ Hub重启需要手动操作');
      } else if (workers.has(target)) {
        await stopWorker(target);
        const app = currentApps.find(a => a.name === target);
        if (app) {
          suppressRestart.delete(target);
          startWorker(app);
          await sendFeishuStatus(appName, chatId, `🔄 ${target} Worker已重启`);
        }
      } else {
        await sendFeishuStatus(appName, chatId, `❓ 未知目标: ${target}`);
      }
      break;
    }

    case 'history': {
      try {
        const params = new URLSearchParams();
        if (cmd.peer) params.set('peer', cmd.peer);
        params.set('limit', String(cmd.limit || 10));
        const url = `http://${HUB_HOST}:${parseInt(HUB_PORT)}/messages?${params}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        const messages = await res.json();
        if (Array.isArray(messages) && messages.length > 0) {
          const lines = messages.slice(0, 15).map(m => {
            const preview = (m.content || '').substring(0, 30);
            const time = new Date(m.ts || m.timestamp).toLocaleTimeString('zh-CN');
            return `${time} **${m.from}** → ${m.to}: ${preview}`;
          }).join('\n');
          await sendFeishuStatus(appName, chatId, `📜 最近消息:\n${lines}`);
        } else {
          await sendFeishuStatus(appName, chatId, '📜 暂无消息记录');
        }
      } catch (err) {
        await sendFeishuStatus(appName, chatId, `❌ 查询失败: ${err.message}`);
      }
      break;
    }

    case 'report': {
      const agents = getAllStatus();
      const health = getHubHealth();
      const today = new Date().toISOString().slice(0, 10);
      const reportData = {
        date: today,
        agents: agents.map(a => ({
          name: a.name,
          messagesHandled: 0, // TODO: per-agent message count from Hub
          status: a.online ? 'online' : 'offline',
        })),
        totalMessages: health?.messageCount || 0,
        hubUptime: health?.uptime || 0,
      };
      const card = buildReportCard(reportData);
      await sendStatusCard(appName, chatId, messageId, card);
      break;
    }

    default:
      log(`[${appName}] unhandled command type: ${cmd.type}`);
  }
}

async function handleWorkerMessage(msg) {
  // Persist chat_id to feishu-apps.json so Hub can use it for replies
  if (msg.chatId && msg.chatType === 'p2p') {
    try {
      const apps = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
      const appConfig = apps.find(a => a.name === msg.appName);
      if (appConfig && appConfig.chatId !== msg.chatId) {
        appConfig.chatId = msg.chatId;
        writeFileSync(CONFIG_PATH, JSON.stringify(apps, null, 2));
        log(`[${msg.appName}] saved chat_id: ${msg.chatId}`);
      }
    } catch (err) {
      log(`[${msg.appName}] failed to persist chat_id: ${err.message}`);
    }
  }

  // ── Console command interception (p2p only) ────────────────────────────
  if (msg.chatType === 'p2p') {
    const cmd = parseCommand(msg.content);
    if (cmd) {
      await handleConsoleCommand(cmd, msg);
      return; // Don't forward commands to Hub
    }
  }

  try {
    const result = await sendToHub(msg.from, msg.to, msg.content);
    log(
      `[${msg.appName}] -> Hub (${msg.chatType}): ${result.ok || result.accepted ? 'delivered' : 'failed'} (to=${msg.to}, online=${result.online}, buffered=${result.buffered})`,
    );

    // Send or update consolidated status card for this chat
    if (msg.chatId) {
      if (result?.online) {
        const preview = msg.content.substring(0, 20) + (msg.content.length > 20 ? '...' : '');
        const taskEntry = { id: result?.id || Date.now().toString(), preview, stage: 1, hubMessageId: result?.id };

        let pending = pendingCards.get(msg.appName);

        // If all existing tasks are done, unpin old card and start fresh
        if (pending?.tasks?.every(t => t.stage >= 3)) {
          if (pending.cardMessageId) await unpinMessage(msg.appName, pending.cardMessageId);
          pendingCards.delete(msg.appName);
          pending = null;
        }

        if (pending?.cardMessageId) {
          // Add task to existing card
          pending.tasks.push(taskEntry);
          const card = buildSummaryCard(pending.tasks);
          await updateStatusCard(msg.appName, pending.cardMessageId, card);
        } else {
          // Create new card with one task
          const tasks = [taskEntry];
          const card = buildSummaryCard(tasks);
          const cardMsgId = await sendStatusCard(msg.appName, msg.chatId, msg.messageId, card);
          if (cardMsgId) {
            await pinMessage(msg.appName, cardMsgId);
            pending = { chatId: msg.chatId, cardMessageId: cardMsgId, tasks };
            pendingCards.set(msg.appName, pending);
          }
        }
        savePendingCards();
      } else if (result?.buffered) {
        await sendStatusCard(msg.appName, msg.chatId, msg.messageId, '💤 离线，消息已缓存');
      } else if (!result?.accepted) {
        await sendStatusCard(msg.appName, msg.chatId, msg.messageId, '⚠️ 发送失败');
      }
    }
  } catch (err) {
    log(`[${msg.appName}] -> Hub failed: ${err.message}`);
    // Hub unreachable — notify user
    if (msg.chatId) {
      await sendStatusCard(msg.appName, msg.chatId, msg.messageId, '⚠️ 发送失败，Hub可能不可达').catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
//  Card action handler (bot setup form)
// ---------------------------------------------------------------------------

async function handleCardAction(data, appName) {
  const action = data?.action || data;

  // Check for console card actions (refresh, approve, reject)
  const actionValue = action?.value || {};
  if (actionValue.action === 'refresh_status') {
    // Find chatId for this app and send updated status card
    const notifyApp = currentApps.find(a => a.name === appName);
    if (notifyApp?.chatId) {
      const agents = getAllStatus();
      const health = getHubHealth();
      const card = buildStatusCard(agents, health);
      // We don't have the original card messageId here easily, so send a new card
      await sendStatusCard(appName, notifyApp.chatId, null, card);
    }
    return;
  }

  if (actionValue.action === 'approve' || actionValue.action === 'reject') {
    const approved = actionValue.action === 'approve';
    const approvalId = actionValue.id;
    log(`[${appName}] approval ${approvalId}: ${approved ? 'approved' : 'rejected'}`);
    // Send approval result back via Hub
    try {
      await sendToHub(`feishu:${appName}`, approvalId, JSON.stringify({
        type: 'approval_response',
        approved,
        approvalId,
      }));
    } catch {}
    // Notify user
    const notifyApp = currentApps.find(a => a.name === appName);
    if (notifyApp?.chatId) {
      await sendFeishuStatus(appName, notifyApp.chatId, approved ? '✅ 已确认' : '❌ 已拒绝');
    }
    return;
  }

  const formData = action?.form_value || action?.value || {};

  const appId = (formData.app_id || '').trim();
  const appSecret = (formData.app_secret || '').trim();
  const sessionName = (formData.session_name || '').trim();

  if (!appId || !appSecret || !sessionName) {
    log(`[${appName}] card action: missing fields (app_id=${!!appId}, app_secret=${!!appSecret}, session_name=${!!sessionName})`);
    return;
  }

  log(`[${appName}] card action: add_bot app_id=${appId} session=${sessionName}`);

  // Load current config
  let apps = [];
  try {
    apps = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    log(`[${appName}] card action: failed to read config: ${err.message}`);
    return;
  }

  // Check duplicate
  if (apps.some((a) => a.appId === appId)) {
    log(`[${appName}] card action: app ${appId} already configured, skipping`);
    // Notify via Hub so the managing bot can reply
    try {
      await sendToHub('feishu-bridge', appName, `机器人 ${appId} 已存在，无需重复添加。`);
    } catch {}
    return;
  }

  if (apps.some((a) => a.name === sessionName)) {
    log(`[${appName}] card action: session name "${sessionName}" already taken`);
    try {
      await sendToHub('feishu-bridge', appName, `Session名称 "${sessionName}" 已被占用，请换一个。`);
    } catch {}
    return;
  }

  // Check if target session is online
  let sessionOnline = false;
  try {
    const res = await new Promise((ok, fail) => {
      const req = http.get(`http://${HUB_HOST}:${parseInt(HUB_PORT)}/sessions`, (r) => {
        let buf = '';
        r.on('data', (c) => (buf += c));
        r.on('end', () => {
          try { ok(JSON.parse(buf)); } catch { ok([]); }
        });
      });
      req.on('error', fail);
      req.setTimeout(3000, () => req.destroy(new Error('timeout')));
    });
    sessionOnline = Array.isArray(res) && res.some((s) => s.name === sessionName);
  } catch {}

  // Append to config
  const newApp = {
    name: sessionName,
    appId,
    appSecret,
    targetOpenId: '',
    receive: true,
    send: false,
    routeTo: sessionName,
  };
  apps.push(newApp);

  try {
    writeFileSync(CONFIG_PATH, JSON.stringify(apps, null, 2));
    log(`[${appName}] card action: wrote config, ${apps.length} apps total`);
    // Apply immediately instead of waiting for poll
    lastConfigMtime = statSync(CONFIG_PATH).mtimeMs;
    reloadConfig();
  } catch (err) {
    log(`[${appName}] card action: write config failed: ${err.message}`);
    return;
  }

  // Hot-reload via file watcher will pick up the change and start the new worker.
  // If the target session is not online, request spawn through Hub.
  if (!sessionOnline) {
    try {
      await sendToHub(
        'feishu-bridge',
        appName,
        `新机器人 ${sessionName} (${appId}) 已添加到配置，Worker正在启动。如需对应的IPC session，请执行: ipc_spawn(name="${sessionName}", task="你是${sessionName}，通过IPC协作")`,
      );
    } catch {}
  } else {
    try {
      await sendToHub(
        'feishu-bridge',
        appName,
        `新机器人 ${sessionName} (${appId}) 已添加到配置，Worker正在启动，目标session已在线。`,
      );
    } catch {}
  }
}

// ---------------------------------------------------------------------------
//  Poll pending-cards.json for ACK updates from mcp-server
// ---------------------------------------------------------------------------

setInterval(() => {
  try {
    const raw = readFileSync(PENDING_CARDS_FILE, 'utf8');
    const fileData = JSON.parse(raw);

    for (const [appName, pending] of pendingCards) {
      const filePending = fileData[appName];
      if (!filePending) continue;

      let changed = false;
      // Check each task: if any task has hubMessageId matching an acked message, advance to stage 2
      for (const task of pending.tasks) {
        if (task.stage < 2) {
          // Check if this specific task was acked (by hubMessageId match or general ack)
          const fileTask = filePending.tasks?.find(ft => ft.id === task.id);
          if (fileTask?.stage >= 2 || filePending.acked) {
            task.stage = 2;
            changed = true;
          }
        }
      }

      if (changed && pending.cardMessageId) {
        updateStatusCard(appName, pending.cardMessageId, buildSummaryCard(pending.tasks));
        savePendingCards();
        log(`[${appName}] card updated — tasks advanced to stage 2 (session ACK)`);
      }
    }
  } catch {}
}, 3000);

// ---------------------------------------------------------------------------
//  Config loading + hot-reload
// ---------------------------------------------------------------------------

function loadConfig() {
  try {
    const apps = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    currentApps = apps; // Keep bridge's app list in sync for token retrieval
    return apps;
  } catch (err) {
    log(`failed to load feishu-apps.json: ${err.message}`);
    return null;
  }
}

/** Fingerprint to detect config changes for an app */
function appFingerprint(a) {
  return JSON.stringify({
    appId: a.appId,
    appSecret: a.appSecret,
    receive: a.receive,
    routeTo: a.routeTo,
  });
}

function applyConfig(apps) {
  const receiveApps = apps.filter((a) => a.receive);

  if (receiveApps.length === 0) {
    log('warning: no app with receive=true');
  }

  const desired = new Map();
  for (const a of receiveApps) desired.set(a.name, a);

  // Stop removed or changed apps
  for (const [name, entry] of workers) {
    const newApp = desired.get(name);
    if (!newApp) {
      log(`[${name}] removed from config, stopping`);
      stopWorker(name);
      desired.delete(name);
    } else if (appFingerprint(newApp) !== appFingerprint(entry.app)) {
      log(`[${name}] config changed, restarting`);
      stopWorker(name).then(() => {
        suppressRestart.delete(name);
        startWorker(newApp);
      });
      desired.delete(name);
    } else {
      // Unchanged
      desired.delete(name);
    }
  }

  // Start new apps
  for (const [name, a] of desired) {
    if (!workers.has(name)) {
      suppressRestart.delete(name);
      startWorker(a);
    }
  }
}

// Debounce (fs.watch fires multiple times on a single save)
let reloadTimer = null;

function reloadConfig() {
  if (reloadTimer) return;
  reloadTimer = setTimeout(() => {
    reloadTimer = null;
    log('feishu-apps.json changed, reloading...');
    const apps = loadConfig();
    if (apps) {
      log(`loaded ${apps.length} app(s), ${apps.filter((a) => a.receive).length} receive-enabled`);
      applyConfig(apps);
    }
  }, 500);
}

// ---------------------------------------------------------------------------
//  Startup
// ---------------------------------------------------------------------------

const initialApps = loadConfig();
if (!initialApps) {
  process.exit(1);
}
log(
  `loaded ${initialApps.length} app(s), ${initialApps.filter((a) => a.receive).length} receive-enabled`,
);
applyConfig(initialApps);

// Start agent status tracking
startTracking();

// Notify on Feishu when agents go online/offline
onStatusChange(async ({ name, online }) => {
  // Find the first send-enabled app to use for notifications (or any app with chatId)
  const notifyApp = currentApps.find(a => a.chatId);
  if (!notifyApp) return;
  const emoji = online ? '🟢' : '🔴';
  const text = `${emoji} ${name} ${online ? '已上线' : '已离线'}`;
  await sendFeishuStatus(notifyApp.name, notifyApp.chatId, text);
});

// Poll config for hot-reload (WSL2 inotify doesn't work for NTFS)
let lastConfigMtime = 0;
try { lastConfigMtime = statSync(CONFIG_PATH).mtimeMs; } catch {}

setInterval(() => {
  try {
    const mtime = statSync(CONFIG_PATH).mtimeMs;
    if (mtime !== lastConfigMtime) {
      lastConfigMtime = mtime;
      reloadConfig();
    }
  } catch {}
}, 5000);
log('polling feishu-apps.json for changes (5s interval)');

// ---------------------------------------------------------------------------
//  Poll source files for changes — exit to trigger auto-restart via run-forever.sh
//  (WSL2 inotify doesn't work for NTFS)
// ---------------------------------------------------------------------------
const sourceWatchFiles = ['feishu-bridge.mjs', 'lib/feishu-worker-thread.mjs', 'lib/command-parser.mjs', 'lib/agent-status.mjs', 'lib/console-cards.mjs'];
const fileMtimes = new Map();
for (const f of sourceWatchFiles) {
  try { fileMtimes.set(f, statSync(resolve(__dirname, f)).mtimeMs); } catch {}
}

setInterval(() => {
  for (const [f, oldMtime] of fileMtimes) {
    try {
      const mtime = statSync(resolve(__dirname, f)).mtimeMs;
      if (mtime !== oldMtime) {
        log(`source file changed: ${f}, restarting...`);
        process.exit(0); // run-forever.sh will restart us
      }
    } catch {}
  }
}, 10000);
log('polling source files for auto-restart (10s interval)');

// ---------------------------------------------------------------------------
//  Graceful shutdown
// ---------------------------------------------------------------------------

async function shutdown(signal) {
  log(`${signal} received, shutting down ${workers.size} worker(s)...`);
  const promises = [];
  for (const [name] of workers) {
    promises.push(stopWorker(name));
  }
  await Promise.allSettled(promises);
  log('all workers stopped');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
