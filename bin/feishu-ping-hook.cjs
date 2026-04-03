#!/usr/bin/env node
/**
 * UserPromptSubmit hook — intercepts feishu "ping" messages before LLM.
 *
 * If the incoming prompt is a feishu channel message containing "ping",
 * replies "pong" via Hub /feishu-reply and exits with code 2 (block LLM).
 * Otherwise exits 0 (let LLM process normally).
 */
const fs = require('fs');
const http = require('http');

const HUB_HOST = process.env.IPC_HUB_HOST || '172.26.229.111';
const HUB_PORT = process.env.IPC_PORT || '3179';

let input = '';
process.stdin.on('data', c => input += c);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const prompt = data.prompt || '';

    // Check if this is a feishu channel message containing ping
    // Channel messages look like: <channel source="ipc" from="feishu:xxx" ...>ping</channel>
    const feishuMatch = prompt.match(/from="(feishu:([^"]+))"/);
    if (!feishuMatch) { process.exit(0); return; }

    // Extract content between channel tags
    const contentMatch = prompt.match(/<channel[^>]*>\s*([\s\S]*?)\s*<\/channel>/);
    const content = contentMatch ? contentMatch[1].trim() : '';
    const trimmed = content.toLowerCase();

    if (trimmed !== 'ping' && trimmed !== '/ping') { process.exit(0); return; }

    // It's a feishu ping — determine reply target
    const from = feishuMatch[1]; // "feishu:jianmu-pm" or "feishu-group:oc_xxx"
    const appName = feishuMatch[2]; // "jianmu-pm" or group chat_id

    // Check if it's a group message
    const isGroup = from.startsWith('feishu-group:');

    if (isGroup) {
      // Group: reply via Hub /send to feishu-group:{chatId}
      const body = JSON.stringify({ from: 'pong', to: from, content: `pong (full chain: feishu → bridge → hub → session → feishu)` });
      const req = http.request({
        hostname: HUB_HOST, port: parseInt(HUB_PORT), path: '/send', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, () => process.exit(2));
      req.on('error', () => process.exit(2));
      req.setTimeout(5000, () => process.exit(2));
      req.write(body);
      req.end();
    } else {
      // P2P: reply via Hub /feishu-reply
      const body = JSON.stringify({ app: appName, content: `pong (full chain: feishu → bridge → hub → session → feishu)` });
      const req = http.request({
        hostname: HUB_HOST, port: parseInt(HUB_PORT), path: '/feishu-reply', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, () => process.exit(2));
      req.on('error', () => process.exit(2));
      req.setTimeout(5000, () => process.exit(2));
      req.write(body);
      req.end();
    }
  } catch {
    process.exit(0); // Don't block on errors
  }
});
