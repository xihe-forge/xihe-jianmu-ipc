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

    let body, path;

    if (groupIdx > p2pIdx) {
      // Group message — extract chatId and send via /send for Hub routing
      const lastGroupMatch = groupMatch[groupMatch.length - 1];
      const chatId = lastGroupMatch.replace('feishu-group:', '');
      if (!chatId) process.exit(0);

      body = JSON.stringify({ from: 'auto-reply', to: `feishu-group:${chatId}`, content: msg });
      path = '/send';
    } else {
      // P2P message — existing behavior via /feishu-reply
      const lastP2pMatch = p2pMatch[p2pMatch.length - 1];
      const appName = lastP2pMatch.replace('feishu:', '');
      if (!appName) process.exit(0);

      body = JSON.stringify({ app: appName, content: msg, from: 'auto-reply' });
      path = '/feishu-reply';
    }

    const req = http.request({
      hostname: HUB_HOST,
      port: parseInt(HUB_PORT),
      path: path,
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
