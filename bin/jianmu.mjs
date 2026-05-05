#!/usr/bin/env node
/**
 * bin/jianmu.mjs - CLI for xihe-jianmu-ipc
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const cmd = process.argv[2];

function hubBaseUrl() {
  const port = process.env.IPC_PORT || 3179;
  const host = process.env.IPC_HUB_HOST || '127.0.0.1';
  return `http://${host}:${port}`;
}

function parseArgs(args) {
  const result = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      result._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (key === 'dry-run' || key === 'enforce' || key === 'orphan' || key === 'json' || key === 'yes') {
      result[key] = true;
      continue;
    }
    result[key] = args[i + 1];
    i += 1;
  }
  return result;
}

function parseDurationMs(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d+)([dhm])$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === 'd') return amount * 24 * 60 * 60 * 1000;
  if (unit === 'h') return amount * 60 * 60 * 1000;
  return amount * 60 * 1000;
}

function formatTime(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return '-';
  return new Date(ts).toISOString();
}

function truncate(value, width) {
  const text = String(value ?? '-');
  return text.length > width ? `${text.slice(0, Math.max(0, width - 3))}...` : text;
}

function printTable(rows, { action = 'delete' } = {}) {
  const normalized = rows.map((row) => ({
    Action: action,
    SessionId: truncate(row.sessionId, 36),
    Name: truncate(row.name, 28),
    SpawnAt: formatTime(row.spawnAt),
    Reason: row.reason ?? '-',
  }));
  const headers = ['Action', 'SessionId', 'Name', 'SpawnAt', 'Reason'];
  const widths = Object.fromEntries(headers.map((header) => [
    header,
    Math.max(header.length, ...normalized.map((row) => String(row[header]).length)),
  ]));
  console.log(headers.map((header) => header.padEnd(widths[header])).join('  '));
  console.log(headers.map((header) => '-'.repeat(widths[header])).join('  '));
  for (const row of normalized) {
    console.log(headers.map((header) => String(row[header]).padEnd(widths[header])).join('  '));
  }
}

async function requestJson(path, options = {}) {
  const res = await fetch(`${hubBaseUrl()}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(data.error || data.reason || `HTTP ${res.status}`);
  }
  return data;
}

async function confirmNameCleanup(name, args) {
  if (args.yes || !args.enforce || !process.stdin.isTTY) return true;
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`Delete all sessions_history rows for "${name}"? Type the name to confirm: `);
    return answer.trim() === name;
  } finally {
    rl.close();
  }
}

async function runSessions(argv) {
  const sub = argv[0];
  const args = parseArgs(argv.slice(1));
  const jsonMode = args.json === true;

  if (sub === 'list') {
    const params = new URLSearchParams();
    if (args.name) params.set('name', args.name);
    if (args.limit) params.set('limit', args.limit);
    const rows = await requestJson(`/sessions-history?${params}`);
    if (jsonMode) {
      console.log(JSON.stringify({ ok: true, count: rows.length, sessions: rows }, null, 2));
    } else if (rows.length === 0) {
      console.log('No sessions_history rows.');
    } else {
      printTable(rows, { action: 'list' });
    }
    return;
  }

  if (sub === 'cleanup') {
    const hasStrategy = Boolean(args.name || args['older-than'] || args.orphan);
    const dryRun = args.enforce ? false : true;
    const body = { dryRun };

    if (args.name) {
      if (!(await confirmNameCleanup(args.name, args))) {
        console.error('Cleanup cancelled.');
        process.exit(1);
      }
      body.name = args.name;
    }

    if (args['older-than']) {
      const olderThanMs = parseDurationMs(args['older-than']);
      if (!olderThanMs) throw new Error('--older-than expects Nd, Nh or Nm');
      body.endedOlderThanDays = olderThanMs / (24 * 60 * 60 * 1000);
    }

    if (args.orphan) body.orphan = true;

    if (!hasStrategy) {
      body.endedOlderThanDays = 30;
      body.lastSeenOlderThanDays = 90;
      body.orphan = true;
    }

    const result = await requestJson('/sessions-history/cleanup', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`${result.dryRun ? 'Dry-run' : 'Deleted'} sessions: ${result.count}`);
      if (result.deleted?.length) printTable(result.deleted, { action: result.dryRun ? 'would-delete' : 'delete' });
    }
    return;
  }

  console.log('Usage: jianmu sessions <list|cleanup>');
  console.log('  sessions list [--name <name>] [--limit 20] [--json]');
  console.log('  sessions cleanup [--dry-run] [--enforce] [--name <name>] [--older-than 30d] [--orphan] [--yes] [--json]');
  process.exit(1);
}

if (cmd === 'start' || cmd === 'hub') {
  await import(pathToFileURL(join(root, 'hub.mjs')).href);
} else if (cmd === 'mcp') {
  const child = spawn(process.execPath, [join(root, 'mcp-server.mjs')], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  child.once('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });
} else if (cmd === 'status') {
  try {
    const res = await fetch(`${hubBaseUrl()}/health`);
    const data = await res.json();
    console.log(`Hub uptime: ${Math.floor(data.uptime)}s`);
    if (data.sessions.length === 0) {
      console.log('No sessions connected.');
    } else {
      for (const s of data.sessions) {
        const ago = Math.floor((Date.now() - s.connectedAt) / 1000);
        const topics = s.topics.length ? ` [${s.topics.join(', ')}]` : '';
        console.log(`  ${s.name} - connected ${ago}s ago${topics}`);
      }
    }
  } catch {
    console.error('Hub is not running.');
    process.exit(1);
  }
} else if (cmd === 'sessions') {
  try {
    await runSessions(process.argv.slice(3));
  } catch (error) {
    console.error(error?.message ?? error);
    process.exit(1);
  }
} else {
  console.log('Usage: jianmu <command>');
  console.log('  start     Start the hub server');
  console.log('  hub       Start the hub server');
  console.log('  mcp       Start the MCP server over stdio');
  console.log('  status    Show connected sessions');
  console.log('  sessions  Manage sessions_history');
  process.exit(1);
}
