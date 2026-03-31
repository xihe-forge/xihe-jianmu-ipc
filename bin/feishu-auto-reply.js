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

    // Find the last channel message from feishu
    // Look for the pattern: from="feishu:xxx" in the last few thousand characters
    const tail = transcript.slice(-5000);
    const feishuMatch = tail.match(/from="feishu:([^"]+)"/g);
    if (!feishuMatch) process.exit(0);

    // Get the last feishu source
    const lastMatch = feishuMatch[feishuMatch.length - 1];
    const appName = lastMatch.match(/from="feishu:([^"]+)"/)?.[1];
    if (!appName) process.exit(0);

    // Check that the feishu message is recent (within last few messages, not old history)
    // Simple heuristic: the feishu channel tag should appear after the last "Human:" or user turn
    const lastHumanIdx = Math.max(tail.lastIndexOf('Human:'), tail.lastIndexOf('"role":"user"'));
    const lastFeishuIdx = tail.lastIndexOf(`feishu:${appName}`);

    // If the feishu message is not in the most recent turn, skip
    if (lastFeishuIdx < lastHumanIdx && lastHumanIdx > 0) process.exit(0);

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
