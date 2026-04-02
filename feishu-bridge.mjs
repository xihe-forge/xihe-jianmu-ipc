#!/usr/bin/env node
/**
 * feishu-bridge.mjs — Standalone Feishu message relay
 *
 * Receives Feishu messages via Lark SDK WSClient and forwards
 * to Hub via HTTP POST /send. No LLM involved, 0 token cost.
 *
 * Usage: node feishu-bridge.mjs
 * Config: feishu-apps.json (same format as Hub uses)
 */

import * as Lark from '@larksuiteoapi/node-sdk';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HUB_HOST = process.env.IPC_HUB_HOST || '127.0.0.1';
const HUB_PORT = process.env.IPC_PORT || '3179';

function log(...args) {
  process.stderr.write(`[feishu-bridge] ${args.join(' ')}\n`);
}

// Load feishu-apps.json
let apps = [];
try {
  apps = JSON.parse(readFileSync(resolve(__dirname, 'feishu-apps.json'), 'utf8'));
  log(`loaded ${apps.length} app(s) from feishu-apps.json`);
} catch (err) {
  log(`failed to load feishu-apps.json: ${err.message}`);
  process.exit(1);
}

const receiveApp = apps.find(a => a.receive);
if (!receiveApp) {
  log('no app with receive=true');
  process.exit(1);
}

// Token cache for fetching quoted messages
let tokenCache = { token: '', expiry: 0 };

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiry - 60000) return tokenCache.token;
  try {
    const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: receiveApp.appId, app_secret: receiveApp.appSecret }),
    });
    const data = await res.json();
    if (data.code === 0) {
      tokenCache = { token: data.tenant_access_token, expiry: Date.now() + (data.expire - 60) * 1000 };
      return tokenCache.token;
    }
    log(`token error: ${data.msg}`);
    return null;
  } catch (err) {
    log(`token fetch failed: ${err.message}`);
    return null;
  }
}

// Fetch quoted message content
async function fetchQuotedText(parentId) {
  try {
    const token = await getToken();
    if (!token) return '';
    const res = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${parentId}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.code === 0 && data.data?.items?.[0]?.body?.content) {
      try {
        return JSON.parse(data.data.items[0].body.content).text || '';
      } catch {
        return data.data.items[0].body.content;
      }
    }
  } catch (err) {
    log(`quote fetch failed: ${err.message}`);
  }
  return '';
}

// Reply directly to Feishu (for ping, no Hub/LLM needed)
async function replyToFeishu(chatId, text) {
  const token = await getToken();
  if (!token) return;
  try {
    await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) }),
    });
  } catch (err) {
    log(`reply failed: ${err.message}`);
  }
}

// Send to Hub via HTTP POST /send
function sendToHub(from, to, content) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ from, to, content });
    const req = http.request({
      hostname: HUB_HOST,
      port: parseInt(HUB_PORT),
      path: '/send',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { resolve({ ok: false }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

// Start WSClient
const eventDispatcher = new Lark.EventDispatcher({}).register({
  'im.message.receive_v1': async (data) => {
    try {
      const msg = data?.message;
      if (!msg) return;

      // Extract text content
      let text = '';
      if (msg.message_type === 'text') {
        try {
          text = JSON.parse(msg.content).text || '';
        } catch {
          text = msg.content || '';
        }
      } else {
        text = `[${msg.message_type} message]`;
      }

      // Handle reply/quote messages
      if (msg.parent_id) {
        const quoted = await fetchQuotedText(msg.parent_id);
        if (quoted) {
          text = `[引用: ${quoted}]\n${text}`;
        }
      }

      // Extract mentions (@user) from the message
      const mentions = data?.event?.message?.mentions || [];

      if (msg.chat_type === 'p2p') {
        // --- P2P: direct message to bot ---
        log(`[${receiveApp.name}] p2p: "${text.substring(0, 80)}"`);

        // Ping: auto-reply without Hub/LLM
        const trimmed = text.trim().toLowerCase();
        if (trimmed === 'ping' || trimmed === '/ping') {
          await replyToFeishu(msg.chat_id, `pong (bridge: ${receiveApp.name}, hub: ${HUB_HOST}:${HUB_PORT})`);
          log(`[${receiveApp.name}] ping → pong (direct)`);
          return;
        }

        // Forward to Hub
        const target = receiveApp.routeTo || receiveApp.name;
        try {
          const result = await sendToHub(`feishu:${receiveApp.name}`, target, text);
          log(`[${receiveApp.name}] → Hub (p2p): ${result.ok ? 'delivered' : 'failed'} (to=${target})`);
        } catch (err) {
          log(`[${receiveApp.name}] → Hub failed: ${err.message}`);
        }

      } else if (msg.chat_type === 'group') {
        // --- Group: only process if bot is @mentioned ---
        // Debug: log full event structure to understand mentions format
        log(`[${receiveApp.name}] group raw mentions: ${JSON.stringify(mentions)}`);
        log(`[${receiveApp.name}] group raw msg keys: ${JSON.stringify(Object.keys(msg))}`);

        if (mentions.length === 0) {
          // No mentions at all, skip
          return;
        }

        // Clean @mentions from text (飞书 uses @_user_X placeholders)
        let cleanText = text;
        for (const m of mentions) {
          cleanText = cleanText.replace(new RegExp(`@_user_\\d+`, 'g'), '').trim();
        }
        if (!cleanText) return;

        // Determine sender info
        const senderName = data?.event?.sender?.sender_id?.open_id || 'unknown';

        log(`[${receiveApp.name}] group: "${cleanText.substring(0, 80)}" (from=${senderName})`);

        // Ping in group
        const trimmedGroup = cleanText.trim().toLowerCase();
        if (trimmedGroup === 'ping' || trimmedGroup === '/ping') {
          await replyToFeishu(msg.chat_id, `pong (bridge: ${receiveApp.name}, hub: ${HUB_HOST}:${HUB_PORT})`);
          log(`[${receiveApp.name}] group ping → pong`);
          return;
        }

        // Forward to Hub — from identifies the sender, to is this bot's routeTo
        const target = receiveApp.routeTo || receiveApp.name;
        try {
          const result = await sendToHub(`feishu-group:${senderName}`, target, cleanText);
          log(`[${receiveApp.name}] → Hub (group): ${result.ok ? 'delivered' : 'failed'} (to=${target})`);
        } catch (err) {
          log(`[${receiveApp.name}] → Hub failed: ${err.message}`);
        }

      } else {
        log(`[${receiveApp.name}] ignored ${msg.chat_type} message`);
      }
    } catch (err) {
      log(`[${receiveApp.name}] error: ${err.stack || err.message}`);
    }
  },
});

const wsClient = new Lark.WSClient({
  appId: receiveApp.appId,
  appSecret: receiveApp.appSecret,
  loggerLevel: Lark.LoggerLevel.info,
});

wsClient.start({ eventDispatcher }).then(() => {
  log(`[${receiveApp.name}] WSClient connected`);
}).catch(err => {
  log(`[${receiveApp.name}] WSClient FAILED: ${err.stack || err.message}`);
  process.exit(1);
});

log(`[${receiveApp.name}] starting...`);

// Keep process alive
process.on('SIGTERM', () => { log('SIGTERM'); process.exit(0); });
process.on('SIGINT', () => { log('SIGINT'); process.exit(0); });
