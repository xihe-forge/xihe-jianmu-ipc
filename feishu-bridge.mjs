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
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

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
//  Typing indicator via emoji reactions
// ---------------------------------------------------------------------------

const tokenCache = new Map(); // appName -> { token, expiry }
const pendingReactions = new Map(); // appName -> { messageId, reactionId }

async function getAppToken(app) {
  const cached = tokenCache.get(app.name);
  if (cached && Date.now() < cached.expiry - 60000) return cached.token;

  try {
    const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: app.appId, app_secret: app.appSecret }),
    });
    const data = await res.json();
    if (data.code === 0) {
      tokenCache.set(app.name, { token: data.tenant_access_token, expiry: Date.now() + (data.expire - 60) * 1000 });
      return data.tenant_access_token;
    }
  } catch {}
  return null;
}

async function addTypingReaction(appName, messageId) {
  const apps = loadConfig();
  if (!apps) return null;
  const app = apps.find(a => a.name === appName);
  if (!app) return null;

  try {
    const token = await getAppToken(app);
    if (!token) return null;

    const res = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ reaction_type: { emoji_type: 'Typing' } }),
    });
    const data = await res.json();
    if (data.code === 0) {
      return data.data?.reaction_id || null;
    }
    log(`[${appName}] typing reaction failed: ${data.msg}`);
    return null;
  } catch (err) {
    log(`[${appName}] typing reaction error: ${err.message}`);
    return null;
  }
}

async function removeTypingReaction(appName, messageId, reactionId) {
  if (!reactionId) return;
  const apps = loadConfig();
  if (!apps) return;
  const app = apps.find(a => a.name === appName);
  if (!app) return;

  try {
    const token = await getAppToken(app);
    if (!token) return;

    await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reactions/${reactionId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
  } catch {}
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

  // Add typing indicator reaction
  let reactionId = null;
  if (msg.messageId) {
    reactionId = await addTypingReaction(msg.appName, msg.messageId);
  }

  try {
    const result = await sendToHub(msg.from, msg.to, msg.content);
    log(
      `[${msg.appName}] -> Hub (${msg.chatType}): ${result.ok || result.accepted ? 'delivered' : 'failed'} (to=${msg.to}, online=${result.online}, buffered=${result.buffered})`,
    );

    // Send instant status reply to Feishu so user knows what happened
    if (msg.chatId) {
      if (result?.online) {
        await sendFeishuStatus(msg.appName, msg.chatId, '⏳ 处理中...');
      } else if (result?.buffered) {
        await sendFeishuStatus(msg.appName, msg.chatId, '💤 离线，消息已缓存');
      } else if (!result?.accepted) {
        await sendFeishuStatus(msg.appName, msg.chatId, '⚠️ 发送失败');
      }
    }
  } catch (err) {
    log(`[${msg.appName}] -> Hub failed: ${err.message}`);
    // Hub unreachable — notify user
    if (msg.chatId) {
      await sendFeishuStatus(msg.appName, msg.chatId, '⚠️ 发送失败，Hub可能不可达').catch(() => {});
    }
  }

  // Schedule typing reaction removal after 60s
  if (reactionId && msg.messageId) {
    setTimeout(() => {
      removeTypingReaction(msg.appName, msg.messageId, reactionId);
    }, 60000);
  }
}

// ---------------------------------------------------------------------------
//  Card action handler (bot setup form)
// ---------------------------------------------------------------------------

async function handleCardAction(data, appName) {
  const action = data?.action || data;
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
//  Config loading + hot-reload
// ---------------------------------------------------------------------------

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
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
const sourceWatchFiles = ['feishu-bridge.mjs', 'lib/feishu-worker-thread.mjs'];
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
