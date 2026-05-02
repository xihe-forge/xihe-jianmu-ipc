#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tarball = process.argv[2];
if (!tarball) {
  console.error('usage: node tests/dogfood-npm-pack-live.mjs <package.tgz>');
  process.exit(2);
}

const tempRoot = mkdtempSync(join(tmpdir(), 'jianmu-ipc-dogfood-'));
const npmCommand = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm';
const port = Math.floor(Math.random() * 10_000 + 45_000);
const dbPath = join(tempRoot, 'messages.db');
const senderName = `dogfood-sender-${process.pid}`;
const receiverName = `dogfood-receiver-${process.pid}`;
const content = `dogfood-live-${Date.now()}`;

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: options.shell ?? false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveRun({ stdout, stderr });
      } else {
        rejectRun(new Error(`${command} ${args.join(' ')} failed code=${code} signal=${signal}\n${stdout}\n${stderr}`));
      }
    });
  });
}

function waitForOutput(getOutput, pattern, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveWait, rejectWait) => {
    const timer = setInterval(() => {
      const output = getOutput();
      if (pattern.test(output)) {
        clearInterval(timer);
        resolveWait(output);
        return;
      }
      if (Date.now() >= deadline) {
        clearInterval(timer);
        rejectWait(new Error(`timed out waiting for ${pattern}\n${output}`));
      }
    }, 25);
  });
}

function spawnLong(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  return {
    child,
    getOutput: () => `${stdout}\n${stderr}`,
    getStdout: () => stdout,
    getStderr: () => stderr,
  };
}

function writeMessage(stream, payload) {
  stream.write(`${JSON.stringify(payload)}\n`);
}

function createMcpClient(proc) {
  let buffer = '';
  let nextId = 1;
  const pending = new Map();

  proc.child.stdout.on('data', (chunk) => {
    buffer += chunk;
    while (true) {
      const lineEnd = buffer.indexOf('\n');
      if (lineEnd < 0) return;
      const line = buffer.slice(0, lineEnd).replace(/\r$/, '');
      buffer = buffer.slice(lineEnd + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (Object.hasOwn(message, 'id') && pending.has(message.id)) {
        const { resolveRequest, rejectRequest, timer } = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(timer);
        if (message.error) rejectRequest(new Error(JSON.stringify(message.error)));
        else resolveRequest(message.result);
      }
    }
  });

  return {
    request(method, params = {}, timeoutMs = 8_000) {
      const id = nextId++;
      writeMessage(proc.child.stdin, { jsonrpc: '2.0', id, method, params });
      return new Promise((resolveRequest, rejectRequest) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectRequest(new Error(`MCP request timed out: ${method}\n${proc.getOutput()}`));
        }, timeoutMs);
        pending.set(id, { resolveRequest, rejectRequest, timer });
      });
    },
    notify(method, params = {}) {
      writeMessage(proc.child.stdin, { jsonrpc: '2.0', method, params });
    },
  };
}

async function stopProcess(proc) {
  if (!proc?.child || proc.child.exitCode !== null) return;
  proc.child.kill();
  await new Promise((resolveStop) => setTimeout(resolveStop, 250));
  if (proc.child.exitCode === null) proc.child.kill('SIGKILL');
}

let hub;
let mcp;

try {
  const installArgs = process.platform === 'win32'
    ? ['/d', '/c', 'npm', 'install', '--silent', '--ignore-scripts', resolve(tarball)]
    : ['install', '--silent', '--ignore-scripts', resolve(tarball)];
  await run(npmCommand, installArgs, { cwd: tempRoot });
  const rebuildArgs = process.platform === 'win32'
    ? ['/d', '/c', 'npm', 'rebuild', 'better-sqlite3', '--silent']
    : ['rebuild', 'better-sqlite3', '--silent'];
  await run(npmCommand, rebuildArgs, { cwd: tempRoot });

  const binPath = join(tempRoot, 'node_modules', '@xihe-forge', 'jianmu-ipc', 'bin', 'jianmu.mjs');
  const env = {
    IPC_PORT: String(port),
    IPC_DB_PATH: dbPath,
    IPC_MCP_TRACE_DISABLE: '1',
  };

  hub = spawnLong(process.execPath, [binPath, 'start'], { cwd: tempRoot, env });
  await waitForOutput(hub.getOutput, /listening on/, 8_000);

  mcp = spawnLong(process.execPath, [binPath, 'mcp'], {
    cwd: tempRoot,
    env: {
      ...env,
      IPC_NAME: senderName,
      IPC_RUNTIME: 'claude',
      IPC_ALLOW_TRANSIENT_DEBUG_NAME: '1',
    },
  });
  await waitForOutput(mcp.getOutput, /MCP server ready/, 8_000);

  const client = createMcpClient(mcp);
  await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'jianmu-dogfood-live', version: '0.1.0' },
  });
  client.notify('notifications/initialized');
  await waitForOutput(mcp.getOutput, /hub connection established/, 8_000);

  const sendResult = await client.request('tools/call', {
    name: 'ipc_send',
    arguments: { to: receiverName, content, topic: 'dogfood-live' },
  });
  assert.equal(sendResult.isError, undefined);

  const recentResult = await client.request('tools/call', {
    name: 'ipc_recent_messages',
    arguments: { name: receiverName, since: 60_000, limit: 10 },
  });
  assert.equal(recentResult.isError, undefined);

  const payload = JSON.parse(recentResult.content[0].text);
  const found = payload.messages.find((message) => (
    message.from === senderName &&
    message.to === receiverName &&
    message.content === content &&
    message.topic === 'dogfood-live'
  ));
  assert.ok(found, `sent message not found in recent backlog: ${JSON.stringify(payload)}`);

  console.log(JSON.stringify({
    ok: true,
    tempRoot,
    package: '@xihe-forge/jianmu-ipc',
    port,
    senderName,
    receiverName,
    sentContent: content,
    recentCount: payload.count,
    drainedMessageId: found.id,
  }, null, 2));
} finally {
  await stopProcess(mcp);
  await stopProcess(hub);
  rmSync(tempRoot, { recursive: true, force: true });
}
