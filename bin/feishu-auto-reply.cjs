#!/usr/bin/env node
const fs = require('fs');
const http = require('http');

const HUB_HOST = process.env.IPC_HUB_HOST || '127.0.0.1';
const HUB_PORT = process.env.IPC_PORT || '3179';
const PENDING_CARDS_FILE = 'D:/workspace/ai/research/xiheAi/xihe-jianmu-ipc/data/pending-cards.json';

/**
 * Read feishu-apps.json to get app credentials for token retrieval.
 */
function loadFeishuApps() {
  try {
    return JSON.parse(fs.readFileSync('D:/workspace/ai/research/xiheAi/xihe-jianmu-ipc/feishu-apps.json', 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Get Feishu tenant access token for an app.
 */
function getFeishuToken(app) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ app_id: app.appId, app_secret: app.appSecret });
    const req = http.request({
      hostname: 'open.feishu.cn',
      port: 443,
      path: '/open-apis/auth/v3/tenant_access_token/internal',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(buf);
          resolve(data.code === 0 ? data.tenant_access_token : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

/**
 * Update an interactive card via PATCH using https.
 */
function updateCard(token, cardMessageId, title, content, template) {
  const https = require('https');
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template: template || 'green',
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: content },
      },
    ],
  };
  const body = JSON.stringify({ msg_type: 'interactive', content: JSON.stringify(card) });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'open.feishu.cn',
      port: 443,
      path: `/open-apis/im/v1/messages/${cardMessageId}`,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve(true));
    });
    req.on('error', () => resolve(false));
    req.setTimeout(5000, () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

/**
 * Send reply via Hub's /feishu-reply (fallback when no pending card).
 */
function sendViaHub(body, path) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: HUB_HOST,
      port: parseInt(HUB_PORT),
      path: path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve());
    });
    req.on('error', () => resolve());
    req.setTimeout(5000, () => { req.destroy(); resolve(); });
    req.write(body);
    req.end();
  });
}

let input = '';
process.stdin.on('data', c => input += c);
process.stdin.on('end', async () => {
  try {
    const data = JSON.parse(input);
    const msg = data.last_assistant_message;
    if (!msg) process.exit(0);

    const transcriptPath = data.transcript_path;
    if (!transcriptPath) process.exit(0);

    const transcript = fs.readFileSync(transcriptPath, 'utf8');
    const tail = transcript.slice(-20000);

    // Check for group messages first (feishu-group:{chatId})
    const groupMatch = tail.match(/feishu-group:(oc_[a-zA-Z0-9_-]+)/g);
    // Check for p2p messages (feishu:{appName}, but NOT feishu-group)
    const p2pMatch = tail.match(/(?<![a-z-])feishu:([a-zA-Z0-9_-]+)/g);

    if (!groupMatch && !p2pMatch) process.exit(0);

    // Determine which was last in the user turn
    const lastUserIdx = tail.lastIndexOf('"role":"user"');
    if (lastUserIdx < 0) process.exit(0);

    let groupIdx = groupMatch ? tail.lastIndexOf(groupMatch[groupMatch.length - 1]) : -1;
    let p2pIdx = p2pMatch ? tail.lastIndexOf(p2pMatch[p2pMatch.length - 1]) : -1;

    // Only consider matches that appear within the last user turn
    if (groupIdx < lastUserIdx) groupIdx = -1;
    if (p2pIdx < lastUserIdx) p2pIdx = -1;

    if (groupIdx < 0 && p2pIdx < 0) process.exit(0);

    if (groupIdx > p2pIdx) {
      // Group message — send via /send for Hub routing (no card support for groups yet)
      const lastGroupMatch = groupMatch[groupMatch.length - 1];
      const chatId = lastGroupMatch.replace('feishu-group:', '');
      if (!chatId) process.exit(0);

      const body = JSON.stringify({ from: 'auto-reply', to: `feishu-group:${chatId}`, content: msg });
      await sendViaHub(body, '/send');
      process.exit(0);
    }

    // P2P message — try to update pending status card first
    const lastP2pMatch = p2pMatch[p2pMatch.length - 1];
    const appName = lastP2pMatch.replace('feishu:', '');
    if (!appName) process.exit(0);

    // Check for pending card
    let pendingCards = {};
    try { pendingCards = JSON.parse(fs.readFileSync(PENDING_CARDS_FILE, 'utf8')); } catch {}

    const pending = pendingCards[appName];
    if (pending?.cardMessageId) {
      // Try to update the card with the reply content
      const apps = loadFeishuApps();
      const app = apps.find(a => a.name === appName);
      if (app) {
        const https = require('https');
        // Get token via HTTPS directly
        const token = await new Promise((resolve) => {
          const tokenBody = JSON.stringify({ app_id: app.appId, app_secret: app.appSecret });
          const req = https.request({
            hostname: 'open.feishu.cn',
            port: 443,
            path: '/open-apis/auth/v3/tenant_access_token/internal',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(tokenBody) },
          }, (res) => {
            let buf = '';
            res.on('data', c => buf += c);
            res.on('end', () => {
              try {
                const d = JSON.parse(buf);
                resolve(d.code === 0 ? d.tenant_access_token : null);
              } catch { resolve(null); }
            });
          });
          req.on('error', () => resolve(null));
          req.setTimeout(5000, () => { req.destroy(); resolve(null); });
          req.write(tokenBody);
          req.end();
        });

        if (token) {
          const updated = await updateCard(token, pending.cardMessageId, '✅ 已回复', msg, 'green');
          if (updated) {
            // Remove from pending
            delete pendingCards[appName];
            try { fs.writeFileSync(PENDING_CARDS_FILE, JSON.stringify(pendingCards)); } catch {}
            process.exit(0);
          }
        }
      }

      // Card update failed — fall through to regular reply
      delete pendingCards[appName];
      try { fs.writeFileSync(PENDING_CARDS_FILE, JSON.stringify(pendingCards)); } catch {}
    }

    // Fallback: send as regular message via /feishu-reply
    const body = JSON.stringify({ app: appName, content: msg, from: 'auto-reply' });
    await sendViaHub(body, '/feishu-reply');
    process.exit(0);
  } catch {
    process.exit(0);
  }
});
