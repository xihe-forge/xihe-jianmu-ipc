# 建木 (Jianmu) — Real-time IPC for AI Coding Sessions

WebSocket message hub for routing messages between independent AI coding sessions.
Designed for multi-agent workflows where Claude Code, Codex, and other AI tools
need to coordinate in real time.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                        Hub (hub.mjs)                    │
│         WebSocket server + HTTP API on :3179            │
│  - Session registry (name → ws connection)              │
│  - Offline inbox with TTL-based cleanup                 │
│  - Topic pub/sub fanout                                 │
│  - Heartbeat / auto-reconnect                           │
└────────────┬──────────────────────┬────────────────────┘
             │ ws://localhost:3179  │ http://localhost:3179
             │                      │
   ┌─────────▼──────────┐  ┌────────▼────────────────────┐
   │  MCP Server        │  │  HTTP API                   │
   │  (mcp-server.mjs)  │  │  POST /send                 │
   │                    │  │  GET  /health               │
   │  Claude Code       │  │  GET  /sessions             │
   │  integration via   │  │                             │
   │  stdio MCP proto   │  │  Any HTTP client: Codex,    │
   │                    │  │  curl, scripts, etc.        │
   └─────────┬──────────┘  └─────────────────────────────┘
             │
   ┌─────────▼──────────────────────────────────────────┐
   │  Channel (claude/channel capability)                │
   │  Push incoming messages to Claude Code as          │
   │  <channel> notifications — wakes idle sessions     │
   └────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Install

```bash
npm install -g xihe-jianmu-ipc
# or run directly from the repo:
git clone https://github.com/xihe-forge/xihe-jianmu-ipc
cd xihe-jianmu-ipc
npm install
```

### 2. Start the Hub

```bash
node hub.mjs
# or via the CLI:
jianmu hub
```

The hub starts on `localhost:3179` and auto-shuts-down when all sessions disconnect.

### 3. Connect Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "ipc": {
      "command": "node",
      "args": ["/path/to/xihe-jianmu-ipc/mcp-server.mjs"],
      "env": {
        "IPC_NAME": "main"
      }
    }
  }
}
```

Start a second Claude Code session with a different `IPC_NAME`:

```json
{
  "mcpServers": {
    "ipc": {
      "command": "node",
      "args": ["/path/to/xihe-jianmu-ipc/mcp-server.mjs"],
      "env": {
        "IPC_NAME": "worker"
      }
    }
  }
}
```

### 4. Send Messages Between Sessions

In the `main` session, use the `ipc_send` tool:

```
ipc_send(to="worker", content="Start processing task A")
```

In the `worker` session, incoming messages arrive as `<channel>` notifications.

### 5. Windows PowerShell Shortcut (optional)

```powershell
# Run once to install the `ipc` function into your PowerShell profile:
.\bin\install.ps1

# Then open Claude Code sessions with:
ipc main
ipc worker
```

## IPC Tools (MCP)

These tools are available inside any Claude Code session connected to the hub.

### `ipc_send`

Send a message to a named session or broadcast to all.

| Param | Type | Required | Description |
|---|---|---|---|
| `to` | string | yes | Target session name, or `*` for broadcast |
| `content` | string | yes | Message content |
| `topic` | string | no | Optional topic tag for pub/sub fanout |

```
ipc_send(to="worker", content="your task is done")
ipc_send(to="*", content="shutdown signal", topic="control")
```

### `ipc_sessions`

List all currently connected sessions.

```
ipc_sessions()
// → [{ name: "main", connectedAt: 1234567890, topics: [] }, ...]
```

### `ipc_whoami`

Show the current session's name and connection status.

```
ipc_whoami()
// → { name: "main", hub_connected: true, hub: "127.0.0.1:3179", pending_outgoing: 0 }
```

### `ipc_subscribe`

Subscribe or unsubscribe to a topic channel. All messages tagged with that topic
are delivered to every subscriber.

| Param | Type | Required | Description |
|---|---|---|---|
| `topic` | string | yes | Topic name |
| `action` | string | yes | `"subscribe"` or `"unsubscribe"` |

```
ipc_subscribe(topic="build-events", action="subscribe")
ipc_send(to="worker", content="build started", topic="build-events")
```

### `ipc_spawn`

Spawn a new Claude Code session (background or interactive).

| Param | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Session name for the new session |
| `task` | string | yes | Task description / initial prompt |
| `interactive` | boolean | no | `true` opens a new terminal window; `false` (default) runs headless |
| `model` | string | no | Model override, e.g. `claude-sonnet-4-6` |

```
ipc_spawn(name="reviewer", task="Review the PR diff and report back via ipc_send")
ipc_spawn(name="ui-dev", task="Build the dashboard component", interactive=true)
```

Spawned sessions automatically know their IPC name and are instructed to report
back to the spawning session when done.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `IPC_NAME` | `session-<pid>` | Session display name (recommended to set explicitly) |
| `IPC_PORT` | `3179` | Hub WebSocket + HTTP port |
| `IPC_HUB_HOST` | auto-detect | Hub host; auto-detects WSL2 Windows host from `/etc/resolv.conf` |
| `IPC_HUB_AUTOSTART` | `true` | Auto-start hub if not running when MCP server connects |
| `IPC_CHANNEL_URL` | — | HTTP endpoint for the Channel Server to POST incoming messages to |

## HTTP API

The hub exposes a minimal HTTP API on the same port as WebSocket. This lets any
tool — Codex, shell scripts, CI pipelines — send messages without a WebSocket
connection.

### `POST /send`

Send a message from any HTTP client.

**Request body:**

```json
{
  "from": "codex-agent",
  "to": "main",
  "content": "PR review complete — 3 issues found",
  "topic": "reviews"
}
```

**Response:**

```json
{ "ok": true, "id": "msg-abc123" }
```

**Example with curl:**

```bash
curl -s -X POST http://localhost:3179/send \
  -H "Content-Type: application/json" \
  -d '{"from":"ci","to":"main","content":"tests passed"}'
```

### `GET /health`

Returns hub status and all connected sessions.

```json
{
  "ok": true,
  "uptime": 42.3,
  "sessions": [
    { "name": "main", "connectedAt": 1711400000000, "topics": [] },
    { "name": "worker", "connectedAt": 1711400005000, "topics": ["build-events"] }
  ]
}
```

### `GET /sessions`

Returns the sessions array only (alias for `/health`).

```json
[
  { "name": "main", "connectedAt": 1711400000000, "topics": [] }
]
```

## Skill Commands

If you have the `jianmu` CLI installed (`npm install -g` or `node bin/jianmu.mjs`):

| Command | Description |
|---|---|
| `jianmu hub` | Start the hub server |
| `jianmu status` | Show connected sessions and hub uptime |

Inside a Claude Code session, you can also use the MCP tools directly as slash commands
if you configure them as skills in your `.claude/skills/` directory.

## Cross-AI Support

建木 is not Claude-specific. Any tool that can send HTTP requests or open a WebSocket
can participate:

| AI Tool | Integration Method |
|---|---|
| Claude Code | MCP Server (`mcp-server.mjs`) via `.mcp.json` |
| OpenAI Codex | HTTP API (`POST /send`) |
| Custom scripts | HTTP API or raw WebSocket |
| Channel Server | `channel-server.mjs` — standalone receiver that POSTs to a webhook |

## WSL2 Support

When running inside WSL2, the MCP server and channel server automatically detect
the Windows host IP from `/etc/resolv.conf` and connect to the hub running on
the Windows side. No manual configuration needed.

To override: `export IPC_HUB_HOST=172.x.x.x`

## Project Structure

```
xihe-jianmu-ipc/
├── hub.mjs              # WebSocket hub server
├── mcp-server.mjs       # MCP server (Claude Code adapter)
├── channel-server.mjs   # Standalone channel receiver
├── lib/
│   ├── constants.mjs    # Shared constants (ports, timeouts, etc.)
│   ├── protocol.mjs     # Message schema and validation
│   └── rpc.mjs          # RPC helpers
├── bin/
│   ├── jianmu.mjs       # CLI entry point
│   ├── install.ps1      # PowerShell profile installer
│   └── patch-channels.mjs  # Claude Code channel patch helper
└── package.json
```

## License

MIT — see [LICENSE](./LICENSE)

Copyright (c) 2026 LumiDriveTech
