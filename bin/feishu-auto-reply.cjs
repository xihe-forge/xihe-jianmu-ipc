#!/usr/bin/env node
const fs = require('fs');
const http = require('http');

const HUB_HOST = process.env.IPC_HUB_HOST || '172.26.229.111';
const HUB_PORT = process.env.IPC_PORT || '3179';

let input = '';
process.stdin.on('data', c => input += c);
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const msg = data.last_assistant_message;
    if (!msg) process.exit(0);

    const transcriptPath = data.transcript_path;
    if (!transcriptPath) process.exit(0);

    const transcript = fs.readFileSync(transcriptPath, 'utf8');
    const tail = transcript.slice(-20000);
    const feishuMatch = tail.match(/feishu:([a-zA-Z0-9_-]+)/g);
    if (!feishuMatch) process.exit(0);

    const lastMatch = feishuMatch[feishuMatch.length - 1];
    const appName = lastMatch.replace('feishu:', '');
    if (!appName) process.exit(0);

    const lastUserFeishuIdx = tail.lastIndexOf('"role":"user"');
    const lastFeishuIdx = tail.lastIndexOf(`feishu:${appName}`);
    if (lastUserFeishuIdx < 0 || lastFeishuIdx < lastUserFeishuIdx) process.exit(0);

    const body = JSON.stringify({ app: appName, content: msg, from: 'auto-reply' });
    const req = http.request({
      hostname: HUB_HOST,
      port: parseInt(HUB_PORT),
      path: '/feishu-reply',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => process.exit(0));
    });
    req.on('error', () => process.exit(0));
    req.setTimeout(5000, () => { req.destroy(); process.exit(0); });
    req.write(body);
    req.end();
  } catch {
    process.exit(0);
  }
});
