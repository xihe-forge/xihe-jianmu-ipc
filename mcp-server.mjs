#!/usr/bin/env node
/**
 * mcp-server.mjs — IPC MCP Server
 *
 * Launched by Claude Code via stdio.
 * Connects to the IPC Hub via WebSocket and exposes ipc_send /
 * ipc_sessions tools through the MCP protocol via the official SDK.
 *
 * stdout: MCP SDK transport (Content-Length framed JSON-RPC)
 * stderr: all logging
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createMessage } from './lib/protocol.mjs';
import {
  DEFAULT_PORT,
  HUB_AUTOSTART_TIMEOUT,
  HUB_AUTOSTART_RETRY_INTERVAL,
} from './lib/constants.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import http from 'http';

// ---------------------------------------------------------------------------
// Project directory (needed for hub autostart)
// ---------------------------------------------------------------------------
const PROJECT_DIR = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
// Priority: IPC_NAME (explicit) > IPC_DEFAULT_NAME (.mcp.json) > auto-generated
let IPC_NAME = process.env.IPC_NAME || process.env.IPC_DEFAULT_NAME || `session-${process.pid}`;
if (!process.env.IPC_NAME && !process.env.IPC_DEFAULT_NAME) {
  process.stderr.write(`[ipc] IPC_NAME not set, using auto-generated: ${IPC_NAME}\n`);
}

let IPC_PORT = parseInt(process.env.IPC_PORT ?? String(DEFAULT_PORT), 10);
const AUTH_TOKEN = process.env.IPC_AUTH_TOKEN || '';

// ---------------------------------------------------------------------------
// Host auto-detection (WSL2 support)
// ---------------------------------------------------------------------------
function detectHost() {
  if (process.env.IPC_HUB_HOST) return process.env.IPC_HUB_HOST;

  if (process.platform === 'linux' && existsSync('/etc/resolv.conf')) {
    try {
      const content = readFileSync('/etc/resolv.conf', 'utf8');
      for (const line of content.split('\n')) {
        const match = line.match(/^nameserver\s+([\d.]+)/);
        if (match) {
          process.stderr.write(`[ipc] WSL2 detected, using Windows host: ${match[1]}\n`);
          return match[1];
        }
      }
    } catch {
      // fall through to default
    }
  }

  return '127.0.0.1';
}

let HOST = detectHost();

// ---------------------------------------------------------------------------
// WebSocket state
// ---------------------------------------------------------------------------
let ws = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = Infinity; // never give up
const RECONNECT_BASE_DELAY = 3000;
const RECONNECT_MAX_DELAY = 60000;

const outgoingQueue = [];     // queued while disconnected

// ---------------------------------------------------------------------------
// Create MCP Server with Channel capability
// ---------------------------------------------------------------------------
const server = new Server(
  { name: 'ipc', version: '0.1.0' },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
      },
    },
    instructions:
      'IPC messages from other sessions arrive as <channel> tags. When you receive one, read the content and act on it. If the sender expects a reply, use ipc_send to respond.',
  },
);

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'ipc_send',
      description: "Send a message to another Claude Code session by name, or broadcast to all with '*'",
      inputSchema: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: "Target session name, or '*' for broadcast",
          },
          content: {
            type: 'string',
            description: 'Message content',
          },
          topic: {
            type: 'string',
            description: 'Optional topic tag for pub/sub',
          },
        },
        required: ['to', 'content'],
      },
    },
    {
      name: 'ipc_sessions',
      description: 'List all currently connected Claude Code sessions',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'ipc_whoami',
      description: 'Show the current session name and connection status',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'ipc_subscribe',
      description: 'Subscribe or unsubscribe to a topic channel. Messages sent with this topic will be delivered to all subscribers.',
      inputSchema: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Topic name to subscribe/unsubscribe' },
          action: { type: 'string', enum: ['subscribe', 'unsubscribe'], description: 'subscribe or unsubscribe' },
        },
        required: ['topic', 'action'],
      },
    },
    {
      name: 'ipc_spawn',
      description: 'Spawn a new Claude Code session. Background mode runs a one-shot task and reports back via IPC. Interactive mode opens a new terminal window.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Session name for the new session' },
          task: { type: 'string', description: 'Task description or initial prompt for the session' },
          interactive: { type: 'boolean', description: 'If true, opens a new terminal window. If false (default), runs in background.' },
          model: { type: 'string', description: 'Optional model override (e.g. claude-sonnet-4-6)' },
        },
        required: ['name', 'task'],
      },
    },
    {
      name: 'ipc_rename',
      description: 'Change this session\'s IPC name. Disconnects and reconnects to Hub with the new name.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'New session name' },
        },
        required: ['name'],
      },
    },
    {
      name: 'ipc_reconnect',
      description: 'Change the Hub address and/or port at runtime, then reconnect. Useful when the Hub moves to a different host or port without restarting the MCP server.',
      inputSchema: {
        type: 'object',
        properties: {
          host: { type: 'string', description: 'New Hub host address (e.g. "192.168.1.10" or "127.0.0.1"). Omit to keep current.' },
          port: { type: 'number', description: 'New Hub port number. Omit to keep current.' },
        },
      },
    },
    {
      name: 'ipc_task',
      description: 'Create, update, or list structured tasks. Actions: create (assign task to agent), update (change task status), list (query tasks)',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'update', 'list'], description: 'Action to perform' },
          to: { type: 'string', description: 'Target agent name (required for create)' },
          title: { type: 'string', description: 'Task title (required for create)' },
          description: { type: 'string', description: 'Task description' },
          priority: { type: 'number', description: 'Priority 1-5, default 3' },
          taskId: { type: 'string', description: 'Task ID (required for update)' },
          status: { type: 'string', enum: ['started', 'completed', 'failed', 'cancelled'], description: 'New status (required for update)' },
          agent: { type: 'string', description: 'Filter by assigned agent' },
          filterStatus: { type: 'string', description: 'Filter by status' },
          limit: { type: 'number', description: 'Max results, default 20' },
        },
        required: ['action'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // -------------------------------------------------------------------------
  // ipc_send
  // -------------------------------------------------------------------------
  if (name === 'ipc_send') {
    const { to, content, topic } = args ?? {};
    if (!to || content === undefined || content === null) {
      return {
        content: [{ type: 'text', text: 'ipc_send requires "to" and "content"' }],
        isError: true,
      };
    }

    const message = createMessage({
      from: IPC_NAME,
      to,
      content: String(content),
      topic: topic ?? null,
    });

    // Try WebSocket first; if disconnected, fallback to HTTP POST /send
    if (ws?.readyState === 1 /* OPEN */) {
      ws.send(JSON.stringify(message));
      return { content: [{ type: 'text', text: JSON.stringify({ sent: true, id: message.id, via: 'ws' }) }] };
    }

    // WS not connected — use HTTP fallback
    try {
      const result = await httpPost(`http://${HOST}:${IPC_PORT}/send`, {
        from: IPC_NAME,
        to,
        content: String(content),
      });
      return { content: [{ type: 'text', text: JSON.stringify({ accepted: result?.accepted ?? false, id: result?.id ?? message.id, via: 'http', online: result?.online, buffered: result?.buffered }) }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ delivered: false, error: err?.message ?? String(err), via: 'http_failed' }) }],
        isError: true,
      };
    }
  }

  // -------------------------------------------------------------------------
  // ipc_sessions
  // -------------------------------------------------------------------------
  if (name === 'ipc_sessions') {
    try {
      const healthUrl = `http://${HOST}:${IPC_PORT}/health`;
      const response = await httpGet(healthUrl);
      return { content: [{ type: 'text', text: JSON.stringify(response.sessions ?? []) }] };
    } catch (err) {
      process.stderr.write(`[ipc] ipc_sessions error: ${err?.message ?? err}\n`);
      return {
        content: [{ type: 'text', text: `Failed to fetch sessions: ${err?.message ?? err}` }],
        isError: true,
      };
    }
  }

  // -------------------------------------------------------------------------
  // ipc_subscribe
  // -------------------------------------------------------------------------
  if (name === 'ipc_subscribe') {
    const { topic, action } = args ?? {};
    if (!topic || !action) {
      return { content: [{ type: 'text', text: 'ipc_subscribe requires "topic" and "action"' }], isError: true };
    }
    if (action !== 'subscribe' && action !== 'unsubscribe') {
      return { content: [{ type: 'text', text: 'action must be "subscribe" or "unsubscribe"' }], isError: true };
    }
    // Send subscribe/unsubscribe to hub via WebSocket
    if (ws?.readyState !== 1) {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'hub not connected' }) }], isError: true };
    }
    wsSend({ type: action, topic });
    return { content: [{ type: 'text', text: JSON.stringify({ action, topic, ok: true }) }] };
  }

  if (name === 'ipc_whoami') {
    return { content: [{ type: 'text', text: JSON.stringify({
      name: IPC_NAME,
      hub_connected: ws?.readyState === 1,
      hub: `${HOST}:${IPC_PORT}`,
      pending_outgoing: outgoingQueue.length,
    }) }] };
  }

  // -------------------------------------------------------------------------
  // ipc_spawn
  // -------------------------------------------------------------------------
  if (name === 'ipc_spawn') {
    const { name: sessionName, task, interactive, model } = args ?? {};
    if (!sessionName || !task) {
      return { content: [{ type: 'text', text: 'ipc_spawn requires "name" and "task"' }], isError: true };
    }

    // Check if session name is already taken
    try {
      const sessions = await httpGet(`http://${HOST}:${IPC_PORT}/sessions`);
      const existing = Array.isArray(sessions) && sessions.find(s => s.name === sessionName);
      if (existing) {
        return { content: [{ type: 'text', text: `Session "${sessionName}" is already online. Use a different name or wait for it to disconnect.` }], isError: true };
      }
    } catch {
      // Hub unreachable — proceed anyway, Hub will reject duplicate on connect
    }

    try {
      const result = await spawnSession({ name: sessionName, task, interactive: !!interactive, model });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Failed to spawn session: ${err?.message ?? err}` }], isError: true };
    }
  }

  // -------------------------------------------------------------------------
  // ipc_rename
  // -------------------------------------------------------------------------
  if (name === 'ipc_rename') {
    const { name: newName } = args ?? {};
    if (!newName) {
      return { content: [{ type: 'text', text: 'ipc_rename requires "name"' }], isError: true };
    }

    const oldName = IPC_NAME;
    IPC_NAME = newName;

    // Disconnect current WebSocket
    if (ws) {
      try { ws.close(); } catch {}
      ws = null;
    }

    // Reconnect with new name
    reconnectAttempts = 0;
    connect();

    process.stderr.write(`[ipc] renamed: ${oldName} → ${newName}\n`);
    return { content: [{ type: 'text', text: JSON.stringify({ renamed: true, from: oldName, to: newName }) }] };
  }

  // -------------------------------------------------------------------------
  // ipc_reconnect
  // -------------------------------------------------------------------------
  if (name === 'ipc_reconnect') {
    const { host, port } = args ?? {};

    if (host === undefined && port === undefined) {
      return { content: [{ type: 'text', text: 'ipc_reconnect requires at least one of "host" or "port"' }], isError: true };
    }

    const oldHub = `${HOST}:${IPC_PORT}`;

    if (host !== undefined) HOST = host;
    if (port !== undefined) IPC_PORT = Number(port);

    const newHub = `${HOST}:${IPC_PORT}`;

    // Disconnect existing connection
    if (ws) {
      try { ws.close(); } catch {}
      ws = null;
    }

    // Reconnect to new address
    reconnectAttempts = 0;
    connect();

    process.stderr.write(`[ipc] reconnecting: ${oldHub} → ${newHub}\n`);
    return { content: [{ type: 'text', text: JSON.stringify({ reconnecting: true, from: oldHub, to: newHub, session: IPC_NAME }) }] };
  }

  // -------------------------------------------------------------------------
  // ipc_task
  // -------------------------------------------------------------------------
  if (name === 'ipc_task') {
    const { action, to, title, description, priority, taskId, status, agent, filterStatus, limit } = args ?? {};
    if (!action) {
      return { content: [{ type: 'text', text: 'ipc_task requires "action"' }], isError: true };
    }

    if (action === 'create') {
      if (!to || !title) {
        return { content: [{ type: 'text', text: 'ipc_task create requires "to" and "title"' }], isError: true };
      }
      try {
        const result = await httpPost(`http://${HOST}:${IPC_PORT}/task`, {
          from: IPC_NAME,
          to,
          title,
          description: description ?? '',
          priority: priority ?? 3,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Failed to create task: ${err?.message ?? err}` }], isError: true };
      }
    }

    if (action === 'update') {
      if (!taskId || !status) {
        return { content: [{ type: 'text', text: 'ipc_task update requires "taskId" and "status"' }], isError: true };
      }
      try {
        const result = await httpPatch(`http://${HOST}:${IPC_PORT}/tasks/${encodeURIComponent(taskId)}`, { status });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Failed to update task: ${err?.message ?? err}` }], isError: true };
      }
    }

    if (action === 'list') {
      try {
        const params = new URLSearchParams();
        if (agent) params.set('agent', agent);
        if (filterStatus) params.set('status', filterStatus);
        params.set('limit', String(limit ?? 20));
        const result = await httpGet(`http://${HOST}:${IPC_PORT}/tasks?${params.toString()}`);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Failed to list tasks: ${err?.message ?? err}` }], isError: true };
      }
    }

    return { content: [{ type: 'text', text: `Unknown action: ${action}` }], isError: true };
  }

  return {
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

// ---------------------------------------------------------------------------
// spawnSession — launch a new Claude Code session (background or interactive)
// ---------------------------------------------------------------------------
async function spawnSession({ name: sessionName, task, interactive, model }) {
  const ipcEnv = {
    ...process.env,
    IPC_NAME: sessionName,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };

  // Build the system instruction that tells the spawned session about IPC
  const ipcInstruction = `Your IPC session name is "${sessionName}". You are connected to the IPC hub. When you complete your task, report back using ipc_send(to="${IPC_NAME}", content="your result"). You can also receive messages from other sessions.`;

  const fullPrompt = `${ipcInstruction}\n\nTask: ${task}`;

  if (interactive) {
    // Interactive mode: open a new terminal window with Claude Code
    // Patch Claude Code to skip dev channels warning, then launch
    const patchScript = join(PROJECT_DIR, 'bin', 'patch-channels.mjs').replace(/\\/g, '\\\\');
    const extraArgs = model ? ` --model ${model}` : '';
    const psCommand = `$env:IPC_NAME='${sessionName}'; node '${patchScript}'; claude --dangerously-skip-permissions --dangerously-load-development-channels server:ipc${extraArgs}`;

    if (process.platform === 'win32') {
      // Windows: use cmd /c start to open new PowerShell window
      spawn('cmd', ['/c', 'start', 'powershell', '-NoExit', '-Command', psCommand], {
        detached: true,
        stdio: 'ignore',
        env: ipcEnv,
      }).unref();
    } else {
      // Linux/WSL2: prefer calling powershell.exe via WSL interop to open a Windows terminal
      const patchScript = join(PROJECT_DIR, 'bin', 'patch-channels.mjs').replace(/\\/g, '\\\\');
      const extraArgs = model ? ` --model ${model}` : '';

      // Detect WSL2: check if powershell.exe is reachable (sync)
      let isWSL2 = false;
      try {
        const { execSync: _execSync } = await import('node:child_process');
        _execSync('which powershell.exe', { stdio: 'ignore' });
        isWSL2 = true;
      } catch { /* not WSL2 or no powershell.exe */ }

      if (isWSL2) {
        // WSL2: write a temp .ps1 script and execute it via wt.exe / powershell.exe
        // Avoids all quoting issues with inline -Command strings
        const { writeFileSync: _wfs } = await import('node:fs');
        const wslToWin = (p) => p.replace(/^\/mnt\/([a-z])\//, (_, d) => `${d.toUpperCase()}:\\`).replace(/\//g, '\\');
        const patchScriptWin = wslToWin(join(PROJECT_DIR, 'bin', 'patch-channels.mjs'));
        const mcpServerWin = wslToWin(join(PROJECT_DIR, 'mcp-server.mjs'));
        const winHome = process.env.USERPROFILE || `C:\\Users\\${process.env.USERNAME || 'user'}`;
        const claudeCmd = `${winHome}\\AppData\\Roaming\\npm\\claude.ps1`;
        // Write to Windows Temp dir so PowerShell can access it without UNC path issues
        const winUser = process.env.USERNAME || process.env.USER || 'user';
        const winTempDir = `/mnt/c/Users/${winUser}/AppData/Local/Temp`;
        const ts = Date.now();
        const tmpPs1Wsl = join(winTempDir, `ipc-spawn-${sessionName}-${ts}.ps1`);
        const tmpMcpWsl = join(winTempDir, `ipc-mcp-${sessionName}-${ts}.json`);
        const tmpPs1Win = wslToWin(tmpPs1Wsl);
        const tmpMcpWin = wslToWin(tmpMcpWsl);
        // Write .mcp.json to CC working dir (~/) so it's auto-loaded by CC
        // This is more reliable than --mcp-config which may be processed after channel validation
        const mcpConfig = {
          mcpServers: {
            ipc: {
              command: 'node',
              args: [mcpServerWin],
              env: { IPC_NAME: sessionName, IPC_HUB_AUTOSTART: 'true' },
            },
          },
        };
        const mcpConfigJson = JSON.stringify(mcpConfig, null, 2);
        _wfs(tmpMcpWsl, mcpConfigJson, 'utf8');
        // Also write to CC's working dir (.mcp.json in home) for auto-load
        const homeMcpWsl = `/mnt/c/Users/${winUser}/.mcp.json`;
        _wfs(homeMcpWsl, mcpConfigJson, 'utf8');
        const ps1Content = [
          '\uFEFF', // UTF-8 BOM — prevents PowerShell from garbling non-ASCII
          `$env:IPC_NAME = '${sessionName}'`,
          `node '${patchScriptWin}'`,
          `& '${claudeCmd}' --dangerously-skip-permissions --dangerously-load-development-channels server:ipc${extraArgs}`,
        ].join('\r\n');
        _wfs(tmpPs1Wsl, ps1Content, 'utf8');

        // Try wt.exe (Windows Terminal) first — cleaner UX
        let wtAvailable = false;
        try {
          const { execSync: _es2 } = await import('node:child_process');
          _es2('which wt.exe', { stdio: 'ignore' });
          wtAvailable = true;
        } catch { /* no wt.exe */ }

        if (wtAvailable) {
          spawn('wt.exe', ['new-tab', '--title', sessionName, 'powershell.exe', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', tmpPs1Win], {
            detached: true,
            stdio: 'ignore',
            env: ipcEnv,
          }).unref();
        } else {
          spawn('powershell.exe', ['-NoExit', '-ExecutionPolicy', 'Bypass', '-File', tmpPs1Win], {
            detached: true,
            stdio: 'ignore',
            env: ipcEnv,
          }).unref();
        }
      } else {
        // Native Linux: try common terminal emulators
        const terminals = ['gnome-terminal', 'xterm', 'konsole'];
        let spawned = false;
        for (const term of terminals) {
          try {
            spawn(term, ['--', 'bash', '-c', `IPC_NAME='${sessionName}' claude --dangerously-skip-permissions --dangerously-load-development-channels server:ipc`], {
              detached: true,
              stdio: 'ignore',
              env: ipcEnv,
            }).unref();
            spawned = true;
            break;
          } catch { continue; }
        }
        if (!spawned) {
          spawn('bash', ['-c', `IPC_NAME='${sessionName}' claude --dangerously-skip-permissions --dangerously-load-development-channels server:ipc`], {
            detached: true,
            stdio: 'ignore',
            env: ipcEnv,
          }).unref();
        }
      }
    }

    process.stderr.write(`[ipc] spawned interactive session "${sessionName}" in new terminal\n`);
    return { name: sessionName, mode: 'interactive', status: 'spawned' };

  } else {
    // Background mode: run claude -p (one-shot, non-interactive)
    const claudeArgs = ['-p', '--dangerously-skip-permissions'];
    if (model) claudeArgs.push('--model', model);
    claudeArgs.push(fullPrompt);

    const child = spawn('claude', claudeArgs, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: ipcEnv,
      shell: true,
    });
    child.unref();

    // Log stdout/stderr for debugging
    let output = '';
    child.stdout?.on('data', d => { output += d.toString(); });
    child.stderr?.on('data', d => {
      process.stderr.write(`[ipc:${sessionName}] ${d.toString()}`);
    });
    child.on('exit', (code) => {
      process.stderr.write(`[ipc] background session "${sessionName}" exited (code=${code})\n`);
    });

    process.stderr.write(`[ipc] spawned background session "${sessionName}" (pid=${child.pid})\n`);
    return { name: sessionName, mode: 'background', status: 'spawned', pid: child.pid };
  }
}

// ---------------------------------------------------------------------------
// Channel notification push
// ---------------------------------------------------------------------------
function pushChannelNotification(msg) {
  const from = msg.from || 'unknown';
  const topic = msg.topic ? ` [${msg.topic}]` : '';
  const body = msg.content || JSON.stringify(msg);
  const content = `[from: ${from}${topic}]\n${body}`;
  server.notification({
    method: 'notifications/claude/channel',
    params: {
      content,
      meta: {
        from: msg.from || 'unknown',
        message_id: msg.id || '',
        topic: msg.topic || '',
      },
    },
  }).catch((err) => {
    process.stderr.write(`[ipc] failed to push channel notification: ${err?.message ?? err}\n`);
  });
}

// ---------------------------------------------------------------------------
// Hub autostart
// ---------------------------------------------------------------------------
function autostartHub() {
  process.stderr.write('[ipc] attempting to autostart hub...\n');
  try {
    // Forward OpenClaw config to Hub so /hooks/wake works out of the box
    const hubEnv = { ...process.env };
    if (process.env.OPENCLAW_URL) hubEnv.OPENCLAW_URL = process.env.OPENCLAW_URL;
    if (process.env.OPENCLAW_TOKEN) hubEnv.OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN;
    const child = spawn(process.execPath, [join(PROJECT_DIR, 'hub.mjs')], {
      cwd: PROJECT_DIR,
      detached: true,
      stdio: 'ignore',
      env: hubEnv,
    });
    child.unref();
    process.stderr.write(`[ipc] hub spawned (pid ${child.pid})\n`);
  } catch (err) {
    process.stderr.write(`[ipc] failed to spawn hub: ${err?.message ?? err}\n`);
  }
}

// ---------------------------------------------------------------------------
// WebSocket connection helpers
// ---------------------------------------------------------------------------
function buildWsUrl() {
  let url = `ws://${HOST}:${IPC_PORT}/ws?name=${encodeURIComponent(IPC_NAME)}`;
  if (AUTH_TOKEN) url += `&token=${encodeURIComponent(AUTH_TOKEN)}`;
  return url;
}

function flushOutgoingQueue() {
  while (outgoingQueue.length > 0 && ws?.readyState === 1 /* OPEN */) {
    const msg = outgoingQueue.shift();
    try {
      ws.send(msg);
    } catch (err) {
      process.stderr.write(`[ipc] failed to flush queued message: ${err?.message ?? err}\n`);
      outgoingQueue.unshift(msg); // put it back
      break;
    }
  }
}

function scheduleReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    process.stderr.write('[ipc] max reconnect attempts reached, giving up\n');
    return;
  }

  const delay = Math.min(
    RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts),
    RECONNECT_MAX_DELAY,
  );
  reconnectAttempts++;
  process.stderr.write(`[ipc] reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})\n`);
  setTimeout(connect, delay);
}

// ---------------------------------------------------------------------------
// Shared WebSocket message handler
// ---------------------------------------------------------------------------
function handleWsMessage(event) {
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch {
    process.stderr.write('[ipc] received non-JSON message from hub\n');
    return;
  }

  if (msg.type === 'message') {
    // Intercept feishu ping: reply directly without pushing to LLM (0 token)
    const isFeishuPing = msg.from?.startsWith('feishu') &&
      typeof msg.content === 'string' &&
      (msg.content.trim().toLowerCase() === 'ping' || msg.content.trim().toLowerCase() === '/ping');

    if (isFeishuPing) {
      const replyTo = msg.from; // "feishu:jianmu-pm" or "feishu-group:oc_xxx"
      const pong = `pong (full chain: feishu → bridge → hub → ${IPC_NAME} → hub → feishu)`;
      const body = JSON.stringify(
        replyTo.startsWith('feishu-group:')
          ? { from: IPC_NAME, to: replyTo, content: pong }
          : { app: replyTo.split(':')[1], content: pong }
      );
      const path = replyTo.startsWith('feishu-group:') ? '/send' : '/feishu-reply';
      const req = http.request({
        hostname: HOST, port: IPC_PORT, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, () => {});
      req.on('error', () => {});
      req.write(body);
      req.end();
      process.stderr.write(`[ipc] feishu ping intercepted from ${msg.from}, pong sent (0 token)\n`);
      return; // Don't push to LLM
    }

    pushChannelNotification(msg);
    // Send ack back to Hub so the sender knows delivery succeeded
    if (msg.id) {
      wsSend({ type: 'ack', messageId: msg.id, from: IPC_NAME });

      // Update pending-cards.json so feishu-bridge can advance task to stage 2
      try {
        const pcPath = join(PROJECT_DIR, 'data', 'pending-cards.json');
        if (existsSync(pcPath)) {
          const pc = JSON.parse(readFileSync(pcPath, 'utf8'));
          let changed = false;
          for (const [, info] of Object.entries(pc)) {
            if (!info.tasks || !Array.isArray(info.tasks)) continue;
            for (const task of info.tasks) {
              // Match by hubMessageId if available, otherwise advance oldest stage-1 task
              if (task.stage < 2 && (task.hubMessageId === msg.id || task.id === msg.id || !task.hubMessageId)) {
                task.stage = 2;
                changed = true;
                break; // Only advance one task per ACK
              }
            }
          }
          if (changed) {
            writeFileSync(pcPath, JSON.stringify(pc));
            process.stderr.write(`[ipc] updated pending-cards.json: ACK from ${IPC_NAME} for ${msg.id}\n`);
          }
        }
      } catch {}
    }
    process.stderr.write(`[ipc] pushed channel notification from ${msg.from ?? '(unknown)'}\n`);
  } else if (msg.type === 'ack') {
    process.stderr.write(`[ipc] delivery confirmed: ${msg.messageId} by ${msg.confirmedBy}\n`);
  } else if (msg.type === 'inbox') {
    const messages = Array.isArray(msg.messages) ? msg.messages : [];
    for (const m of messages) {
      if (m.type === 'message') pushChannelNotification(m);
    }
    process.stderr.write(`[ipc] pushed ${messages.length} buffered messages\n`);
  }

  process.stderr.write(`[ipc] received message from ${msg.from ?? '(unknown)'}\n`);
}

// ---------------------------------------------------------------------------
// Persistent reconnect loop (used after initial connection is established)
// ---------------------------------------------------------------------------
function connect() {
  const url = buildWsUrl();
  process.stderr.write(`[ipc] connecting to hub at ${url}\n`);

  let socket;
  try {
    socket = new WebSocket(url);
  } catch (err) {
    process.stderr.write(`[ipc] failed to create WebSocket: ${err?.message ?? err}\n`);
    scheduleReconnect();
    return;
  }

  socket.addEventListener('open', () => {
    process.stderr.write('[ipc] connected to hub\n');
    reconnectAttempts = 0;
    ws = socket;
    socket.send(JSON.stringify({ type: 'register', name: IPC_NAME }));
    flushOutgoingQueue();
  });

  socket.addEventListener('message', handleWsMessage);

  socket.addEventListener('close', (event) => {
    process.stderr.write(`[ipc] disconnected from hub (code=${event.code})\n`);
    ws = null;
    scheduleReconnect();
  });

  socket.addEventListener('error', (event) => {
    process.stderr.write(`[ipc] WebSocket error: ${event.message ?? 'unknown'}\n`);
    // 'close' fires after 'error', reconnect will be scheduled there
  });
}

// ---------------------------------------------------------------------------
// Initial connection with optional hub autostart
// ---------------------------------------------------------------------------
async function initialConnect() {
  return new Promise((resolve) => {
    let elapsed = 0;
    let autostartDone = false;

    function tryOnce() {
      let socket;
      try {
        socket = new WebSocket(buildWsUrl());
      } catch {
        handleFailure();
        return;
      }

      const cleanup = () => {
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
      };

      const onOpen = () => {
        cleanup();
        process.stderr.write('[ipc] initial connection to hub succeeded\n');
        reconnectAttempts = 0;
        ws = socket;

        socket.send(JSON.stringify({ type: 'register', name: IPC_NAME }));
        flushOutgoingQueue();

        socket.addEventListener('message', handleWsMessage);

        socket.addEventListener('close', (ev) => {
          process.stderr.write(`[ipc] disconnected from hub (code=${ev.code})\n`);
          ws = null;
          scheduleReconnect();
        });

        socket.addEventListener('error', (ev) => {
          process.stderr.write(`[ipc] WebSocket error: ${ev.message ?? 'unknown'}\n`);
        });

        resolve();
      };

      const onError = () => {
        cleanup();
        try { socket.close(); } catch { /* ignore */ }
        handleFailure();
      };

      socket.addEventListener('open', onOpen);
      socket.addEventListener('error', onError);
    }

    function handleFailure() {
      if (process.env.IPC_HUB_AUTOSTART !== 'false' && !autostartDone) {
        autostartDone = true;
        autostartHub();
      }

      elapsed += HUB_AUTOSTART_RETRY_INTERVAL;
      if (elapsed >= HUB_AUTOSTART_TIMEOUT) {
        process.stderr.write('[ipc] could not connect to hub within timeout, will retry in background\n');
        scheduleReconnect();
        resolve(); // continue starting the MCP server anyway
        return;
      }

      setTimeout(tryOnce, HUB_AUTOSTART_RETRY_INTERVAL);
    }

    tryOnce();
  });
}

// ---------------------------------------------------------------------------
// HTTP helper for /health endpoint
// ---------------------------------------------------------------------------
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (AUTH_TOKEN) headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;
    const req = http.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error(`invalid JSON from ${url}: ${body}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('timeout')); });
  });
}

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (AUTH_TOKEN) headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;
    const parsed = new URL(url);
    const req = http.request({ hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, method: 'POST', headers }, (res) => {
      let buf = '';
      res.on('data', (chunk) => { buf += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch { reject(new Error(`invalid JSON from ${url}: ${buf}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

function httpPatch(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (AUTH_TOKEN) headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;
    const parsed = new URL(url);
    const req = http.request({ hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, method: 'PATCH', headers }, (res) => {
      let buf = '';
      res.on('data', (chunk) => { buf += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); }
        catch { reject(new Error(`invalid JSON from ${url}: ${buf}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// WebSocket send (with queueing on disconnect)
// ---------------------------------------------------------------------------
function wsSend(payload) {
  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
  if (ws?.readyState === 1 /* OPEN */) {
    ws.send(serialized);
    return true;
  }
  // WS not connected — try HTTP fallback
  const msg = typeof payload === 'object' ? payload : null;
  if (msg?.type === 'message' && msg.from && msg.to && msg.content) {
    httpPost(`http://${HOST}:${IPC_PORT}/send`, {
      from: msg.from, to: msg.to, content: msg.content, topic: msg.topic ?? null,
    }).then(res => {
      process.stderr.write(`[ipc] HTTP fallback: ${res?.ok ? 'sent' : 'failed'} (${msg.from} → ${msg.to})\n`);
    }).catch(err => {
      process.stderr.write(`[ipc] HTTP fallback failed: ${err?.message ?? err}\n`);
    });
    return false; // delivered via HTTP async, not guaranteed
  }
  // Non-message payloads (subscribe, etc) — queue for later
  outgoingQueue.push(serialized);
  if (outgoingQueue.length > 100) {
    outgoingQueue.shift();
    process.stderr.write('[ipc] outgoing queue full, dropped oldest message\n');
  }
  process.stderr.write('[ipc] hub not connected, message queued\n');
  return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  process.stderr.write(`[ipc] starting MCP server as "${IPC_NAME}"\n`);

  // Start MCP transport FIRST so Claude Code handshake doesn't timeout
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write('[ipc] MCP server ready, connecting to hub in background...\n');

  // Connect to hub in background (non-blocking)
  initialConnect().then(() => {
    process.stderr.write(`[ipc] hub connection established (session="${IPC_NAME}", hub=${HOST}:${IPC_PORT})\n`);
  }).catch((err) => {
    process.stderr.write(`[ipc] hub connection failed: ${err?.message ?? err}\n`);
  });
}

main().catch((err) => {
  process.stderr.write(`[ipc] fatal: ${err?.message ?? err}\n`);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Source file change detection: poll own mtime, reconnect on change
// (NOT exit — Claude Code may not auto-restart MCP servers)
// ---------------------------------------------------------------------------
const __mcp_file = fileURLToPath(import.meta.url);
let __mcp_mtime = 0;
try { __mcp_mtime = statSync(__mcp_file).mtimeMs; } catch {}

setInterval(() => {
  try {
    const mtime = statSync(__mcp_file).mtimeMs;
    if (__mcp_mtime && mtime !== __mcp_mtime) {
      __mcp_mtime = mtime;
      process.stderr.write('[ipc] source file changed, re-detecting host and reconnecting...\n');
      HOST = detectHost();
      if (ws) { try { ws.close(); } catch {} ws = null; }
      reconnectAttempts = 0;
      connect();
    }
  } catch {}
}, 10000).unref();
