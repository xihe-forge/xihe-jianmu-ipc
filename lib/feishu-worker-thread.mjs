/**
 * feishu-worker-thread.mjs — Worker thread for a single Feishu WSClient
 *
 * Each Feishu app runs in its own worker_thread to avoid Lark SDK global
 * state interference when multiple WSClient instances coexist.
 *
 * Receives app config via workerData.app.
 * Sends messages to parent via parentPort.postMessage().
 */

import { parentPort, workerData } from 'node:worker_threads';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as Lark from '@larksuiteoapi/node-sdk';

const app = workerData.app;
const dataDir = workerData.dataDir; // absolute path to project root for saving files

function log(...args) {
  process.stderr.write(`[feishu-worker:${app.name}] ${args.join(' ')}\n`);
}

// ---------------------------------------------------------------------------
//  Bot identity
// ---------------------------------------------------------------------------

let botOpenId = '';

async function fetchBotOpenId() {
  const token = await getToken();
  if (!token) return;
  try {
    const res = await fetch('https://open.feishu.cn/open-apis/bot/v3/info', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.code === 0 && data.bot?.open_id) {
      botOpenId = data.bot.open_id;
      parentPort.postMessage({ type: 'bot_info', appName: app.name, botOpenId });
    }
  } catch (err) {
    log(`failed to fetch bot info: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
//  Token cache (per-worker)
// ---------------------------------------------------------------------------

let tokenCache = { token: '', expiry: 0 };

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiry - 60000) return tokenCache.token;
  try {
    const res = await fetch(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: app.appId, app_secret: app.appSecret }),
      },
    );
    const data = await res.json();
    if (data.code === 0) {
      tokenCache = {
        token: data.tenant_access_token,
        expiry: Date.now() + (data.expire - 60) * 1000,
      };
      return tokenCache.token;
    }
    log(`token error: ${data.msg}`);
    return null;
  } catch (err) {
    log(`token fetch failed: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
//  Feishu API helpers
// ---------------------------------------------------------------------------

async function fetchQuotedText(parentId) {
  try {
    const token = await getToken();
    if (!token) return '';
    const res = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages/${parentId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
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

async function replyToFeishu(chatId, text) {
  const token = await getToken();
  if (!token) return;
  try {
    await fetch(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        }),
      },
    );
  } catch (err) {
    log(`reply failed: ${err.message}`);
  }
}

async function downloadFeishuResource(messageId, fileKey, type, savePath) {
  const token = await getToken();
  if (!token) return null;
  try {
    const res = await fetch(
      `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=${type}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      log(`resource download failed: ${res.status} ${res.statusText}`);
      return null;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    mkdirSync(dirname(savePath), { recursive: true });
    writeFileSync(savePath, buffer);
    log(`resource saved: ${savePath} (${buffer.length} bytes)`);
    return savePath;
  } catch (err) {
    log(`resource download error: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
//  Message content extraction
// ---------------------------------------------------------------------------

function parsePostContent(content) {
  try {
    const post = JSON.parse(content);
    const lang = post.zh_cn || post.en_us || Object.values(post)[0];
    if (!lang) return '';
    const title = lang.title || '';
    const lines = (lang.content || [])
      .map((line) =>
        line
          .map((node) => {
            if (node.tag === 'text') return node.text || '';
            if (node.tag === 'a') return `[${node.text}](${node.href})`;
            if (node.tag === 'at') return `@${node.user_name || node.user_id || ''}`;
            if (node.tag === 'img') return '[图片]';
            return '';
          })
          .join(''),
      )
      .join('\n');
    return title ? `${title}\n${lines}` : lines;
  } catch {
    return content || '';
  }
}

async function extractMessageContent(msg) {
  switch (msg.message_type) {
    case 'text': {
      try {
        return JSON.parse(msg.content).text || '';
      } catch {
        return msg.content || '';
      }
    }
    case 'image': {
      try {
        const { image_key } = JSON.parse(msg.content);
        const savePath = resolve(dataDir, `data/feishu-images/${msg.message_id}.png`);
        const saved = await downloadFeishuResource(msg.message_id, image_key, 'image', savePath);
        if (saved) return `[图片: ${saved}]`;
        return '[图片: 下载失败]';
      } catch (err) {
        log(`image extract error: ${err.message}`);
        return '[图片]';
      }
    }
    case 'file': {
      try {
        const { file_key, file_name } = JSON.parse(msg.content);
        const savePath = resolve(dataDir, `data/feishu-files/${file_name}`);
        const saved = await downloadFeishuResource(msg.message_id, file_key, 'file', savePath);
        if (saved) return `[文件: ${file_name}] ${saved}`;
        return `[文件: ${file_name}] 下载失败`;
      } catch (err) {
        log(`file extract error: ${err.message}`);
        return '[文件]';
      }
    }
    case 'post':
      return parsePostContent(msg.content);
    case 'audio':
      return '[语音消息]';
    case 'sticker':
      return '[表情]';
    case 'merge_forward':
      return '[合并转发消息]';
    default:
      return `[${msg.message_type} message]`;
  }
}

// ---------------------------------------------------------------------------
//  Event handler
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
//  Interactive card: bot setup form
// ---------------------------------------------------------------------------

const BOT_SETUP_CARD = {
  config: { wide_screen_mode: true },
  header: {
    title: { tag: 'plain_text', content: '新增飞书机器人' },
    template: 'blue',
  },
  elements: [
    {
      tag: 'div',
      text: {
        tag: 'plain_text',
        content: '请填写飞书应用信息，提交后自动配置并启动 Worker。',
      },
    },
    {
      tag: 'form',
      name: 'bot_setup_form',
      elements: [
        {
          tag: 'input',
          name: 'app_id',
          placeholder: { tag: 'plain_text', content: 'App ID (cli_xxx)' },
          max_length: 100,
        },
        {
          tag: 'input',
          name: 'app_secret',
          placeholder: { tag: 'plain_text', content: 'App Secret' },
          max_length: 200,
        },
        {
          tag: 'input',
          name: 'session_name',
          placeholder: { tag: 'plain_text', content: 'Session 名称 (如 my-agent)' },
          max_length: 60,
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '提交' },
          type: 'primary',
          action_type: 'form_submit',
          name: 'submit',
        },
      ],
    },
  ],
};

async function sendSetupCard(chatId) {
  const token = await getToken();
  if (!token) return;
  try {
    const res = await fetch(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(BOT_SETUP_CARD),
        }),
      },
    );
    const data = await res.json();
    if (data.code !== 0) {
      log(`send card failed: ${data.msg}`);
    }
  } catch (err) {
    log(`send card error: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
//  Event handler
// ---------------------------------------------------------------------------

// Message dedup: track processed message IDs to prevent duplicate handling
const processedMsgIds = new Set();
setInterval(() => { if (processedMsgIds.size > 1000) processedMsgIds.clear(); }, 300000);

const eventDispatcher = new Lark.EventDispatcher({}).register({
  'im.message.receive_v1': async (data) => {
    try {
      const msg = data?.message;
      if (!msg) return;

      // Dedup: skip already processed messages
      if (msg.message_id && processedMsgIds.has(msg.message_id)) {
        log(`dedup: skipping ${msg.message_id}`);
        return;
      }
      if (msg.message_id) processedMsgIds.add(msg.message_id);

      log(
        `event: chat_type=${msg.chat_type} msg_type=${msg.message_type} msg_id=${msg.message_id}`,
      );

      // Extract content based on message type
      let text = await extractMessageContent(msg);

      // Handle reply/quote messages
      if (msg.parent_id) {
        const quoted = await fetchQuotedText(msg.parent_id);
        if (quoted) {
          text = `[引用: ${quoted}]\n${text}`;
        }
      }

      // Extract mentions
      const mentions = msg?.mentions || [];

      if (msg.chat_type === 'p2p') {
        // --- Intercept setup commands ---
        const cmd = text.trim();
        if (cmd === '新增机器人' || cmd === '/add-bot') {
          log('p2p: sending bot setup card');
          await sendSetupCard(msg.chat_id);
          return; // Don't forward to Hub
        }

        // --- P2P ---
        log(`p2p: "${text.substring(0, 80)}"`);

        parentPort.postMessage({
          type: 'feishu_message',
          appName: app.name,
          from: `feishu:${app.name}`,
          to: app.routeTo || app.name,
          content: text,
          chatType: 'p2p',
          chatId: msg.chat_id,
          messageId: msg.message_id,
        });
      } else if (msg.chat_type === 'group') {
        // --- Group: only if bot @mentioned ---
        const isBotMentioned =
          botOpenId &&
          ((msg.content ?? '').includes('@_all') ||
            mentions.some((m) => m.id?.open_id === botOpenId));

        if (!isBotMentioned) {
          log(
            `group: no bot mention (mentions=${mentions.length}, botOpenId=${botOpenId || 'unset'})`,
          );
          return;
        }

        // Strip bot @mention
        let cleanText = text;
        for (const m of mentions) {
          if (m.id?.open_id === botOpenId && m.key) {
            cleanText = cleanText
              .replace(
                new RegExp(m.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
                '',
              )
              .trim();
          }
        }
        if (!cleanText) return;

        const senderOpenId = data?.sender?.sender_id?.open_id || 'unknown';
        const senderName =
          mentions.find((m) => m.id?.open_id === senderOpenId)?.name || senderOpenId;

        log(`group @: "${cleanText.substring(0, 80)}" (from=${senderName})`);

        parentPort.postMessage({
          type: 'feishu_message',
          appName: app.name,
          from: `feishu-group:${msg.chat_id}`,
          to: app.routeTo || app.name,
          content: cleanText,
          chatType: 'group',
          chatId: msg.chat_id,
        });
      } else {
        log(`ignored ${msg.chat_type} message`);
      }
    } catch (err) {
      log(`error: ${err.stack || err.message}`);
    }
  },

  'card.action.trigger': async (data) => {
    try {
      log(`card action received: ${JSON.stringify(data).substring(0, 200)}`);
      parentPort.postMessage({ type: 'card_action', data, appName: app.name });
    } catch (err) {
      log(`card action error: ${err.stack || err.message}`);
    }
  },
});

// ---------------------------------------------------------------------------
//  Start WSClient
// ---------------------------------------------------------------------------

const wsClient = new Lark.WSClient({
  appId: app.appId,
  appSecret: app.appSecret,
  loggerLevel: Lark.LoggerLevel.info,
});

wsClient
  .start({ eventDispatcher })
  .then(async () => {
    log('WSClient connected');
    parentPort.postMessage({ type: 'connected', appName: app.name });
    await fetchBotOpenId();
  })
  .catch((err) => {
    log(`WSClient FAILED: ${err.stack || err.message}`);
    process.exit(1);
  });

log('starting...');
