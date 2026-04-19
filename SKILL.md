---
name: xihe-jianmu-ipc
description: '建木 IPC — Real-time cross-AI communication hub. Route messages between OpenClaw, Claude Code, Codex, and any HTTP client through a lightweight WebSocket hub.'
metadata:
  openclaw:
    emoji: '🌳'
    homepage: https://github.com/xihe-forge/xihe-jianmu-ipc
    os:
      - darwin
      - linux
      - win32
    requires:
      bins:
        - node
      env: []
    install:
      - kind: node
        package: xihe-jianmu-ipc
        bins: [jianmu]
    primaryEnv: IPC_AUTH_TOKEN
---

# 建木 IPC — Cross-AI Communication Hub

You have access to the **xihe-jianmu-ipc** MCP server tools for communicating with other AI sessions in real time.

## Setup

Before using IPC tools, ensure the MCP server is configured in `openclaw.json`:

```json
{
  "mcp": {
    "servers": {
      "xihe-jianmu-ipc": {
        "command": "node",
        "args": ["node_modules/xihe-jianmu-ipc/mcp-server.mjs"],
        "env": { "IPC_NAME": "openclaw" }
      }
    }
  }
}
```

## Available Tools

### `ipc_send`

Send a message to another AI session by name, or broadcast to all with `*`.

```
ipc_send(to="claude-main", content="task completed, 3 files updated")
ipc_send(to="*", content="shutting down for maintenance", topic="system")
```

### `ipc_sessions`

List all currently connected sessions across all AI tools.

```
ipc_sessions()
```

### `ipc_whoami`

Show your session name and hub connection status.

```
ipc_whoami()
```

### `ipc_subscribe`

Subscribe to topic channels for filtered message delivery.

```
ipc_subscribe(topic="alerts", action="subscribe")
```

### `ipc_spawn`

Start a new Claude Code session with a task.

```
ipc_spawn(name="worker-1", task="run the test suite")
ipc_spawn(name="harness", task="resume from handover", host="wt", cwd="D:/workspace/ai/research/xiheAi/xihe-tianshu-harness")
```

### `ipc_rename`

Rename the current session.

```
ipc_rename(name="my-new-name")
```

### `ipc_task`

Manage structured tasks (create/update/list).

```
ipc_task(action="create", to="worker-1", title="fix lint errors")
```

### `ipc_reconnect`

Reconnect to a different hub address.

```
ipc_reconnect(host="192.168.1.100", port=3179)
```

### `ipc_recent_messages`

Fetch recent persisted messages addressed to the current session (or a specified session), including broadcast backlog after a crash or reconnect.

```
ipc_recent_messages()
ipc_recent_messages(name="worker-1", since=3600000, limit=20)
```

### `ipc_recall`

Query recent project observations from `~/.claude/project-state/<project>/observations.db`, with optional filters for session, tool, tags, and keyword.

```
ipc_recall(project="xihe-jianmu-ipc")
ipc_recall(project="*", since=3600000, limit=5, tags=["ship"], keyword="unpublish")
```

### `ipc_observation_detail`

Fetch a single observation row by `project + id` without truncating `tool_input` or `tool_output`. If the observation tags contain `jsonl:<path>:<line_range>`, the response also includes `jsonl_path` and `line_range`.

```
ipc_observation_detail(project="xihe-jianmu-ipc", id=123)
```

## Rules

1. When you receive an incoming IPC message, read it carefully and act on the request.
2. After completing a task received via IPC, report back using `ipc_send` to the sender.
3. Use `ipc_sessions` to discover available sessions before sending.
4. Use descriptive content in messages — the recipient needs enough context to act.

## Security Note

This skill uses WebSocket connections, HTTP requests, and child process spawning to route messages between AI sessions. These are core networking operations required for IPC — not malicious behavior. VirusTotal may flag the skill as suspicious due to these patterns. Source code is fully open at [github.com/xihe-forge/xihe-jianmu-ipc](https://github.com/xihe-forge/xihe-jianmu-ipc), MIT licensed.

## About

Built by [xihe-forge](https://github.com/xihe-forge) — Xihe AI's open-source forge, where practical AI tools are hammered from ideas into ready-to-use projects. Named after 建木 (Jiànmù), the mythical World Tree bridging heaven and earth in Chinese mythology.

More tools for AI collaboration, search, and growth: https://github.com/xihe-forge
