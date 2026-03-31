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

    // Read transcript to check if triggered by feishu
    const transcriptPath = data.transcript_path;
    if (!transcriptPath) process.exit(0);

    const transcript = fs.readFileSync(transcriptPath, 'utf8');

    // Find the last channel message from feishu in transcript (JSONL format)
    // In JSONL, quotes are escaped: from=\"feishu:xxx\" or from=\\"feishu:xxx\\"
    const tail = transcript.slice(-20000);
    const feishuMatch = tail.match(/feishu:([a-zA-Z0-9_-]+)/g);
    if (!feishuMatch) process.exit(0);

    // Get the last feishu app name
    const lastMatch = feishuMatch[feishuMatch.length - 1];
    const appName = lastMatch.replace('feishu:', '');
    if (!appName) process.exit(0);

    // Check the last feishu mention is in the last user message (not in tool calls/old history)
    // Find last "role":"user" that contains "feishu:" — that's the channel notification turn
    const lastUserFeishuIdx = tail.lastIndexOf('"role":"user"');
    const lastFeishuIdx = tail.lastIndexOf(`feishu:${appName}`);

    // feishu mention must be near the last user turn (within a few hundred chars)
    if (lastUserFeishuIdx < 0 || lastFeishuIdx < lastUserFeishuIdx) process.exit(0);

    // Send reply to Hub
    const body = JSON.stringify({ app: appName, content: msg, from: 'auto-reply' });
    const req = http.request({
      hostname: HUB_HOST,
      port: parseInt(HUB_PORT),
      path: '/feishu-reply',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      process.exit(0);
    });
    req.on('error', () => process.exit(0));
    req.setTimeout(5000, () => { req.destroy(); process.exit(0); });
    req.write(body);
    req.end();
  } catch {
    process.exit(0);
  }
});
