[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[English](README.md) | [中文](README.zh-CN.md)

# xihe-jianmu-ipc

## Codex Plugin

Install with `codex plugin install xihe-forge/jianmu-ipc`, then start the hub with `npx @xihe-forge/jianmu-ipc start`.
Inside Codex, call `ipc_whoami()` to verify the session name.

> **命名由来 / Etymology** — 遵循曦和项目三段式命名规范 `xihe-{隐喻}-{功能}`：
>
> - **xihe（曦和）** — 品牌。源自中国神话中的太阳女神曦和 / Brand. Xihe, the sun goddess in Chinese mythology
> - **jianmu（建木）** — 隐喻。建木是上古神话中天地之间的通天神树，诸神借之往来天地、沟通上下。多个 AI 会话之间的通信如建木般无声连通 / Metaphor. Jiànmù is the mythical World Tree bridging heaven and earth in ancient Chinese mythology — gods traveled between realms through it in silence. IPC messages flow between AI sessions like spirits through the World Tree
> - **ipc** — 功能。进程间实时通信 / Function. Real-time inter-process communication

多 AI 会话实时通信中枢——WebSocket 消息路由 + MCP 集成 + Channel 推送唤醒 + 飞书 AI 控制台 + SQLite 持久化 + 结构化任务协议。

Real-time communication hub for AI coding sessions — WebSocket message routing + MCP integration + Channel push notifications + Feishu AI console + SQLite persistence + structured task protocol.

为需要多个 AI agent 协作而非各自为战的开发者而建。

Built for developers who need multiple AI agents to collaborate, not work in isolation.

由 [Xihe AI](https://github.com/xihe-forge) 锻造，面向所有需要跨 AI 会话协同的开发者。
Forged by [Xihe AI](https://github.com/xihe-forge), for developers who need real coordination across AI sessions.

---

## Quickstart for users

Start the Jianmu IPC hub with one command:

```bash
npx @xihe-forge/jianmu-ipc start
```

Then register the MCP server in your agent config. Use a stable lowercase session name per agent so messages can be routed and resumed.

Codex `~/.codex/config.toml`:

```toml
[mcp_servers.jianmu-ipc]
command = "npx"
args = ["-y", "@xihe-forge/jianmu-ipc", "mcp"]
env = { IPC_NAME = "codex-main", IPC_RUNTIME = "codex" }
```

Claude Code `.mcp.json`:

```json
{
  "mcpServers": {
    "jianmu-ipc": {
      "command": "npx",
      "args": ["-y", "@xihe-forge/jianmu-ipc", "mcp"],
      "env": {
        "IPC_NAME": "claude-main",
        "IPC_RUNTIME": "claude"
      }
    }
  }
}
```

Once connected, use `ipc_send` to send messages and `ipc_recent_messages` to drain durable backlog after reconnects.

## 特性 / Features

- WebSocket real-time push: messages are pushed to connected sessions immediately instead of relying on polling loops.
- Topic subscription model: direct, broadcast, and pub/sub routing share the same hub and durable message log.
- Session resume and persistent inbox: reconnecting sessions can drain missed messages with `ipc_recent_messages`; explicit handoff paths preserve lineage.
- Portfolio-proven: built and hardened through real multi-session project work, not only a demo workflow.

## 竞品对比 / Comparison

| 项目 | 定位 | 跟 Jianmu IPC 的差异 |
|---|---|---|
| `claude-ipc-mcp` | AI-to-AI messages for Claude/Gemini/CLI agents | Natural-language commands and session auth; no topic subscription; no persistent inbox for cross-session resume. |
| `mcp_agent_mail` | Async coordination with identity, inbox, threaded messages, Git/SQLite, and file lease | Strong mail semantics and file lease; no WebSocket real-time push, mainly polling. |
| `claude-mpm` | Multi-agent PM orchestration with channels and plugin system | PM workflow layer, not a small IPC hub. |
| `Network-AI` | Multi-framework orchestration with shared state, guardrails, and budgets | Enterprise orchestration layer; heavier than a focused MCP IPC server. |

---

## 为什么存在：Token 成本问题 / Why This Exists: The Token Cost Problem

多 agent 协作的标准路径——让 LLM 充当路由器，通过 Gateway 中转上下文——代价极高。每次跨 session 通信都会触发完整的 agent run，重新加载整个 JSONL 对话记录。随着对话变长，token 消耗是 O(N²) 累积的。

The standard path for multi-agent coordination — routing messages through the LLM, rebuilding context at every hop — is expensive by design. Every inter-session message triggers a full agent run that reloads the entire JSONL transcript. As conversations grow, token costs scale O(N²) cumulatively.

已有记录的真实代价 / Documented real-world costs:

- Claude Code issue #4911: sub-agent consumed **160K tokens** for a task that took 2–3K when done directly
- Claude Code issue #27645: _"Subagents don't share context — they re-read and re-analyze everything. 5–10x more token-efficient to do direct edits."_
- Claude Code issue #18240: **296K/200K tokens** (148% context overflow) after a subagent returned
- ICLR 2026 research: ~30% of tokens in multi-agent operations are consumed unnecessarily by context reconstruction
- Anthropic's own research: multi-agent uses **15× more tokens** than equivalent single-agent work

**建木的思路 / The Jianmu approach**: 不让 LLM 做路由，让哑管道做路由。消息通过 WebSocket 直接送达目标 session，LLM 只看到最终消息，看不到路由历史。每条消息的 token 开销约 50 tokens，与对话深度无关。

**The Jianmu approach**: route through a dumb pipe, not through the LLM. Messages travel over WebSocket directly to the target session. The LLM sees only the final message — not the routing history. Token cost per message: ~50 tokens, regardless of conversation depth.

---

## 架构 / Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        Hub (hub.mjs)                             │
│            WebSocket server + HTTP API on :3179                  │
│  - Session registry (name → ws connection)                       │
│  - Offline inbox with TTL-based cleanup                          │
│  - Topic pub/sub fanout                                          │
│  - Heartbeat / auto-reconnect                                    │
│  - Per-session token authentication                              │
│  - Structured task protocol (create/update/track)                │
└──────┬──────────────────┬──────────────────┬─────────────────────┘
       │ ws://:3179       │ http://:3179     │
       │                  │                  │
┌──────▼───────┐  ┌───────▼──────────┐  ┌───▼──────────────────┐
│  MCP Server  │  │  HTTP API        │  │  Dashboard           │
│  (mcp-       │  │  /send /health   │  │  GET /dashboard/*    │
│  server.mjs) │  │  /suspend        │  │  实时监控面板         │
│              │  │  /messages       │  │  Real-time monitor   │
│  Claude Code │  │  /wake-suspended │  └──────────────────────┘
│  & OpenClaw  │  │  /internal/*     │
│  via stdio   │  │                  │
└──────┬───────┘  └──────────────────┘
       │
┌──────▼──────────────────────────────────────────────────────┐
│  Channel (claude/channel capability)                         │
│  Push incoming messages to Claude Code as <channel>          │
│  notifications — wakes idle sessions                         │
└─────────────────────────────────────────────────────────────┘
       │
┌──────▼──────────────────────────────────────────────────────┐
│  SQLite Persistence (lib/db.mjs)                             │
│  WAL mode · 7-day TTL · message history · task tracking      │
│  GET /messages · GET /stats · GET /tasks                     │
└─────────────────────────────────────────────────────────────┘
       │
┌──────▼──────────────────────────────────────────────────────┐
│  OpenClaw Adapter                                            │
│  Outbound: Hub calls /hooks/wake on the Gateway              │
│  when a message targets an openclaw-* session                │
│  (ALWAYS via HTTP, even if WS is connected)                  │
│  Inbound:  OpenClaw loads mcp-server.mjs via                 │
│  openclaw.json — ipc_send reaches any connected tool         │
└─────────────────────────────────────────────────────────────┘
       │
┌──────▼──────────────────────────────────────────────────────┐
│  Feishu Sending (Hub 内 / inside Hub)                        │
│  Outbound: Hub sends messages via Feishu Bot API             │
│  Endpoint: POST /feishu-reply                                │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  feishu-bridge (独立进程 / standalone process)               │
│  Reads feishu-apps.json, connects via Lark SDK WSClient     │
│  — no public IP needed                                       │
│  Forwards messages to Hub via HTTP POST /send                │
│  AI控制台: 8种命令 · Agent状态追踪 · 卡片交互 · 日报推送    │
│  AI Console: 8 commands · agent tracking · cards · reports   │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  network-watchdog (bin/network-watchdog.mjs)                │
│  7 probes every 30s: cliProxy / hub / anthropic / dns / committed_pct / available_ram_mb / harness       │
│  POST /internal/network-event -> Hub                        │
│  GET 127.0.0.1:3180/status for daemon health checks         │
└─────────────────────────────────────────────────────────────┘
```

---

## 快速开始 / Quick Start

### Claude Code 用户 / For Claude Code Users

**1. 安装 / Install**

```bash
npm install -g xihe-jianmu-ipc
# 或直接从仓库运行 / or run directly from the repo:
git clone https://github.com/xihe-forge/xihe-jianmu-ipc
cd xihe-jianmu-ipc
npm install
```

安装好 `jianmu-ipc` 后，npm `postinstall` 会自动 detect + 双写 Windows PowerShell 5 和 pwsh 7 的 `$PROFILE`。开新 PowerShell 窗口后可用 `ipc <name>` 起 Claude，或用 `ipcx <name>` 起 Codex。未来如果新装另一个 PowerShell 版本，重跑 `bin/install.ps1` 即可。

After `jianmu-ipc` is installed, npm `postinstall` automatically detects and writes both Windows PowerShell 5 and pwsh 7 `$PROFILE` files. Open a new PowerShell window, then run `ipc <name>` for Claude or `ipcx <name>` for Codex. If you install another PowerShell version later, rerun `bin/install.ps1`.

`ipc <name>` 函数自动处理三件事，保证 Claude Code 干净启动：

1. **跳过两个 startup prompt**：通过 `bin/claude-stdin-auto-accept.mjs` 用 `node-pty` 真 PTY spawn Claude，detect 并自动 confirm `workspace trust`（cwd 未信任时）和 `dev-channels server:ipc warning`，user 不再手动按 1 / Enter。
2. **VSCode terminal 兼容**：sanitize Claude inquirer UI 在 xterm.js 渲染的大量 cursor positioning + padding 空白行（ConPTY 不显但 xterm.js 会刷一片空白），并 rewrite OSC 0 title sequence 为 `IPC_NAME`。
3. **MCP server lookup 修复**：`ipc` function 自动 `Push-Location` 到 `D:\workspace\ai\research\xiheAi`（默认 hardcoded，TODO: dynamic detect），让 Claude 启动时找到 project-local `.mcp.json` 注册的 jianmu-ipc，避免 `server:ipc · no MCP server configured with that name` warning。

`install.ps1` 还会自动 patch VSCode user `settings.json`，加 `terminal.integrated.tabs.title = ${sequence}` 让 VSCode tab title 跟随 child OSC（VSCode 1.110.x 默认 `${process}` 不 honor child OSC）。idempotent：已 set 不覆盖，路径不存在 skip。

The `ipc <name>` function automatically handles three things to keep Claude Code launches clean:

1. **Skips two startup prompts** — `bin/claude-stdin-auto-accept.mjs` spawns Claude through real `node-pty` PTY, detects and auto-confirms `workspace trust` (untrusted cwd) and `dev-channels server:ipc warning`, so users no longer have to press 1 / Enter manually.
2. **VSCode terminal compatibility** — sanitizes the large cursor-positioning + padding blank-fill that Claude inquirer UI emits (invisible in ConPTY, blanks half the screen in xterm.js), and rewrites OSC 0 title sequences to `IPC_NAME`.
3. **MCP server lookup fix** — `ipc` automatically `Push-Location` to the project root (`D:\workspace\ai\research\xiheAi`, hardcoded for now — TODO: dynamic detect) so Claude can find the project-local `.mcp.json` jianmu-ipc registration and avoid the `server:ipc · no MCP server configured with that name` warning.

`install.ps1` also patches VSCode user `settings.json` to set `terminal.integrated.tabs.title = ${sequence}`, making VSCode honor child OSC for tab titles (default `${process}` ignores it). Idempotent: already-set values are not overwritten, and missing settings.json paths are skipped.

**2. 在项目 `.mcp.json` 中添加配置 / Add to `.mcp.json` in your project**

Session 1 (main):

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

Session 2 (worker):

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

> **需要 OpenClaw 集成？/ Need OpenClaw integration?** 项目提供了 `.env.example` 文件，复制为 `.env` 并填入 `OPENCLAW_TOKEN` 即可。详见下方 OpenClaw 用户章节。/ A `.env.example` file is provided. Copy it to `.env` and fill in your `OPENCLAW_TOKEN`. See the OpenClaw Users section below for details.

**3. Hub 自动启动 / The hub starts automatically**

第一个 MCP 会话连接时 Hub 自动启动（`IPC_HUB_AUTOSTART=true` 为默认值）。也可手动启动：

The hub starts automatically when the first MCP session connects (`IPC_HUB_AUTOSTART=true` by default). When auto-starting, the MCP server passes `OPENCLAW_URL` and `OPENCLAW_TOKEN` from its own environment to the hub process. This means if these variables are configured in `.mcp.json` or `openclaw.json`, the hub will automatically have access to them. The `.env` file serves as a fallback for manually started hubs.

当 MCP server 自动启动 Hub 时，会将 `OPENCLAW_URL` 和 `OPENCLAW_TOKEN` 环境变量透传给 Hub 进程。如果这些变量在 `.mcp.json` 或 `openclaw.json` 中配置了，Hub 会自动获取。`.env` 文件作为手动启动 Hub 时的兜底配置。

Or start it manually:

```bash
node hub.mjs

# Linux / WSL2: 使用 setsid 防止父 shell 退出时 Hub 被 SIGTERM 杀死
# Linux / WSL2: use setsid to prevent SIGTERM from killing Hub when the parent shell exits
setsid node hub.mjs &
```

**4. 启动 network-watchdog（推荐无人值守时启用，自动探测 `cliProxy / hub / anthropic / dns / committed_pct / available_ram_mb / harness`） / Start the network-watchdog (recommended for unattended runs, probes `cliProxy / hub / anthropic / dns / committed_pct / available_ram_mb / harness`)**

```bash
npm run watchdog
# 或 / or
node bin/network-watchdog.mjs

# 健康检查 / health check
curl http://127.0.0.1:3180/status
```

Windows 上也可以注册 watchdog 守护任务：

On Windows, you can also register the watchdog daemon:

```powershell
npm run daemon:watchdog:install
npm run daemon:watchdog:uninstall
```

**5. 发送消息 / Send messages**

From the `main` session:

```
ipc_send(to="worker", content="Start processing task A")
```

Incoming messages arrive in the `worker` session as `<channel>` notifications that wake idle sessions.

**6. Windows PowerShell 快捷方式（可选）/ Windows PowerShell shortcut (optional)**

```powershell
# 安装 ipc/ipcx 函数到 PS5 + pwsh 7 profile / Install `ipc`/`ipcx` into PS5 + pwsh 7 profiles:
.\bin\install.ps1

# 用 ipc 命令打开 Claude Code 会话 / Open Claude Code sessions with:
ipc main
ipc worker

# 用 ipcx 命令打开 Codex 会话 / Open Codex sessions with:
ipcx codex-worker
```

**7. Windows Hub 守护进程（推荐）/ Windows Hub daemon (recommended)**

让 Hub 开机自启 + 挂了自动恢复，无需手动拉起。守护机制：Windows 任务计划 `AtLogOn` + 每 10 分钟重复触发 + VBS 内部每 5 分钟健康探测（curl `/health`），假活时精确 kill 该 PID 并拉起新进程。

Make the Hub start automatically on login and self-heal when crashed. Mechanism: Windows Task Scheduler (`AtLogOn` + repeat every 10 min) triggers a VBS daemon that probes `/health` every 5 min and restarts the hub process on failure.

```powershell
# 注册守护任务（不需要管理员权限 / No admin required）
powershell -ExecutionPolicy Bypass -File bin\install-daemon.ps1

# 卸载 / Uninstall
powershell -ExecutionPolicy Bypass -File bin\uninstall-daemon.ps1

# 验证自愈能力（会 kill Hub PID 测试恢复 / will kill Hub PID to test recovery）
powershell -ExecutionPolicy Bypass -File bin\verify-daemons.ps1 -Service Hub
```

---

### OpenClaw 用户 / For OpenClaw Users

**1. 安装包 / Install the package**

```bash
npm install xihe-jianmu-ipc
```

**2. 配置 `.env` 文件（仅手动启动 Hub 时需要）/ Configure `.env` (only needed when starting Hub manually)**

```bash
cp .env.example .env
# 填入你的 OPENCLAW_TOKEN（从 OpenClaw 配置 hooks.token 获取）
# Fill in your OPENCLAW_TOKEN (get it from your OpenClaw config: hooks.token)
```

如果 OpenClaw 通过 `openclaw.json` 加载 MCP server 并在 `env` 字段中配置了环境变量，MCP server 自动启动 Hub 时会将这些变量透传给 Hub——此时不需要 `.env` 文件。`.env` 仅在手动运行 `node hub.mjs` 时作为兜底配置。

If OpenClaw loads the MCP server via `openclaw.json` with env vars configured in the `env` field, the MCP server will pass them to the Hub automatically on autostart — no `.env` needed. The `.env` file is only needed when starting Hub manually via `node hub.mjs`.

**3. 添加到 `openclaw.json` / Add to `openclaw.json`**

```json
{
  "mcp": {
    "servers": {
      "xihe-jianmu-ipc": {
        "command": "node",
        "args": ["node_modules/xihe-jianmu-ipc/mcp-server.mjs"],
        "env": {
          "IPC_NAME": "openclaw",
          "IPC_AUTH_TOKEN": "your-shared-secret",
          "OPENCLAW_URL": "http://localhost:3000",
          "OPENCLAW_TOKEN": "your-openclaw-token"
        }
      }
    }
  }
}
```

**4. 在 OpenClaw 中使用 IPC 工具 / Use IPC tools from within OpenClaw**

OpenClaw can now reach any connected session:

```
ipc_send(to="claude-main", content="Login failure detected, need attention")
ipc_sessions()  // see what tools are connected
```

**5. ClawHub 可用性 / ClawHub availability**

`xihe-jianmu-ipc` skill 已在 ClawHub 上线。在 OpenClaw 内搜索 `xihe-jianmu-ipc` 即可安装。由于包含网络通信代码，安装时可能需要确认安全提示。

The `xihe-jianmu-ipc` skill is available in ClawHub. Search for `jianmu` to install it directly from within OpenClaw.

### claude-hud patch auto-apply

`claude-hud` may be reinstalled under a new `~/.claude/plugins/cache/claude-hud/claude-hud/0.0.X/` directory. To keep statusline usage checks routed through Jianmu Hub `/usage` first, install the hourly patch task:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\workspace\ai\research\xiheAi\xihe-jianmu-ipc\bin\install-hud-patch.ps1 -RegisterTask
```

The script scans every installed `claude-hud` version, applies `patches/claude-hud-jianmu-priority.patch` when missing, runs `npm ci`, rebuilds with `npm run build`, and registers `JianmuClaudeHudPatch` in Windows Task Scheduler for hourly re-application.

双向通信已验证 / Bidirectional OpenClaw ↔ Claude Code communication has been tested and verified:

- OpenClaw → Hub → Claude Code: delivered via WebSocket, wakes Claude Code via Channel notification
- Claude Code → Hub → OpenClaw: Hub calls `POST /hooks/wake` on the Gateway to push the message into OpenClaw's main session in real-time (always via HTTP, even if the openclaw MCP session is connected via WebSocket)

---

## IPC 工具（MCP）/ IPC Tools (MCP)

以下工具在任意连接到 Hub 的会话中均可使用——Claude Code、OpenClaw 或任意支持 MCP 的工具。

These tools are available inside any session connected to the hub — Claude Code, OpenClaw, or any MCP-capable tool.

### `ipc_send`

向指定 session 或广播给所有 session 发送消息。
Send a message to a named session or broadcast to all.

| Param     | Type   | Required | Description                               |
| --------- | ------ | -------- | ----------------------------------------- |
| `to`      | string | yes      | Target session name, or `*` for broadcast |
| `content` | string | yes      | Message content                           |
| `topic`   | string | no       | Optional topic tag for pub/sub fanout     |

```
ipc_send(to="worker", content="your task is done")
ipc_send(to="*", content="shutdown signal", topic="control")
```

目标 session 离线时，消息会被缓冲（基于 TTL），在其重连时投递。
If the target session is offline, the message is buffered (TTL-based) and delivered when it reconnects.

### `ipc_sessions`

列出所有当前连接的 session。
List all currently connected sessions.

```
ipc_sessions()
// → [{ name: "main", connectedAt: 1234567890, topics: [] }, ...]
```

### `ipc_whoami`

显示当前 session 的名称和连接状态。
Show the current session's name and connection status.

```
ipc_whoami()
// → { name: "main", hub_connected: true, hub: "127.0.0.1:3179", pending_outgoing: 0 }
```

### `ipc_subscribe`

订阅或取消订阅一个 topic channel。所有打上该 topic 标签的消息都会投递给所有订阅者。
Subscribe or unsubscribe to a topic channel. All messages tagged with that topic are delivered to every subscriber.

| Param    | Type   | Required | Description                      |
| -------- | ------ | -------- | -------------------------------- |
| `topic`  | string | yes      | Topic name                       |
| `action` | string | yes      | `"subscribe"` or `"unsubscribe"` |

```
ipc_subscribe(topic="build-events", action="subscribe")
ipc_send(to="worker", content="build started", topic="build-events")
```

### `ipc_spawn`

生成一个新的 Claude Code 或 Codex 会话（后台或交互式）。
Spawn a new Claude Code or Codex session (background or interactive).

| Param         | Type    | Required | Description                                                                   |
| ------------- | ------- | -------- | ----------------------------------------------------------------------------- |
| `name`        | string  | yes      | Session name for the new session                                              |
| `task`        | string  | yes      | Task description / initial prompt                                             |
| `interactive` | boolean | no       | `true` opens a new terminal window; `false` (default) runs headless           |
| `model`       | string  | no       | Model override, e.g. `claude-sonnet-4-6`                                      |
| `runtime`     | string  | no       | Runtime: `claude` (default) or `codex`                                        |
| `host`        | string  | no       | Spawn host: `wt`, `vscode-terminal`, or `external` (default)                  |
| `cwd`         | string  | no       | Working directory for the spawned session; defaults to caller `process.cwd()` |

```
ipc_spawn(name="reviewer", task="Review the PR diff and report back via ipc_send")
ipc_spawn(name="ui-dev", task="Build the dashboard component", interactive=true)
ipc_spawn(name="harness", task="Resume from HANDOVER-HARNESS-20260419-2330.md", host="wt", model="opus")
ipc_spawn(name="codex-1", task="Run TDD and report back", runtime="codex", host="wt", interactive=true)
```

生成的 session 会自动获知自己的 IPC 名称，并被指示在完成后向生成方 session 汇报。
Spawned sessions automatically know their IPC name and are instructed to report back to the spawning session when done.

`host="external"` 保持兼容旧行为，只返回 `command_hint` / fallback 信息而不真正起进程；`host="wt"` 在 Win32 上通过 Windows Terminal 新 tab 起进程；`host="vscode-terminal"` 当前返回 not implemented 提示。

`runtime="claude"` + `host="wt"` / `spawn-fallback` 的 canonical 启动命令为 `"C:\Users\jolen\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe" --dangerously-skip-permissions --dangerously-load-development-channels server:ipc`。session 名通过 `IPC_NAME` 环境变量传入，不使用 `--session-name` / `--resume`；若启用了 IPC auth，完整 `IPC_AUTH_TOKEN` 应从目标 cwd 的 `.mcp.json` 读取。

`runtime="codex"` + `interactive=true` 使用 `wt.exe ... -- cmd /k "cd /d <cwd> && codex --dangerously-bypass-approvals-and-sandbox -c 'mcp_servers.jianmu-ipc.env.IPC_NAME=\"<name>\"'"` 起长存 Codex；`runtime="codex"` + `interactive=false` 使用 `codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -c 'mcp_servers.jianmu-ipc.env.IPC_NAME="<name>"' '<task prompt>'` 一次性派单并退出。

`cwd` 是 spawn 契约的一部分。调用方若显式传入，则新 session 从该目录启动；未传时保持兼容，回退到调用方 `process.cwd()`。

### `ipc_rename`

重命名当前 session。
Rename the current session.

| Param  | Type   | Required | Description      |
| ------ | ------ | -------- | ---------------- |
| `name` | string | yes      | New session name |

```
ipc_rename(name="code-reviewer")
```

### `ipc_reclaim_my_name`

回收自己的目标 session 名称，当旧 holder 疑似 zombie 时先让 Hub 主动 ping 探测并在 5 秒无 pong 时踢掉旧连接。
Reclaim your intended session name when the current holder looks stale. The hub actively pings the holder and evicts it only if no pong arrives within 5 seconds.

| Param  | Type   | Required | Description                                                       |
| ------ | ------ | -------- | ----------------------------------------------------------------- |
| `name` | string | yes      | Session name to reclaim, typically the same as `process.env.IPC_NAME` |

```
ipc_reclaim_my_name(name="harness")
```

### `ipc_task`

结构化任务管理——创建、更新、查询任务。
Structured task management — create, update, and list tasks.

| Param         | Type   | Required | Description                                                        |
| ------------- | ------ | -------- | ------------------------------------------------------------------ |
| `action`      | string | yes      | `"create"`, `"update"`, or `"list"`                                |
| `to`          | string | create   | Target agent for the task                                          |
| `title`       | string | create   | Task title                                                         |
| `description` | string | no       | Task description                                                   |
| `priority`    | string | no       | `"low"`, `"normal"`, `"high"`, `"urgent"`                          |
| `deadline`    | string | no       | ISO 8601 deadline                                                  |
| `taskId`      | string | update   | Task ID to update                                                  |
| `status`      | string | update   | `"pending"`, `"started"`, `"in_progress"`, `"completed"`, `"failed"`, `"cancelled"` |

```
ipc_task(action="create", to="worker", title="Fix login bug", priority=4)
ipc_task(action="update", taskId="task-abc123", status="completed")
ipc_task(action="list")
```

### `ipc_recent_messages`

拉取发给当前 session（或指定 session）的近期持久化消息，用于冷启动或崩溃重连后补回 backlog。
Retrieve recent persisted messages addressed to the current session (or a specified session). Useful on cold-start or after reconnecting from a crash.
`flushInbox` 只会推离线 inbox 缓冲，不会自动推这段历史；历史访问必须显式 pull 这个工具。

| Param   | Type   | Required | Description                                                                    |
| ------- | ------ | -------- | ------------------------------------------------------------------------------ |
| `name`  | string | no       | Session name to query; defaults to current session                             |
| `since` | number | no       | Lookback window in milliseconds; default `21600000` (6h), max `604800000` (7d) |
| `limit` | number | no       | Max results; default `50`, max `500`                                           |

```
ipc_recent_messages()
ipc_recent_messages(name="worker", since=3600000, limit=20)
```

### `ipc_recall`

查询 `~/.claude/project-state/<project>/observations.db` 的近期 observation，支持 `project="*"` 跨项目合并检索，并可按 `ipc_name` / `tool_name` / `tags` / `keyword` 过滤。
Query recent project observations from `~/.claude/project-state/<project>/observations.db`, including cross-project merge via `project="*"` and optional filters for `ipc_name`, `tool_name`, `tags`, and `keyword`.

```
ipc_recall(project="xihe-jianmu-ipc")
ipc_recall(project="*", since=3600000, limit=5, tags=["ship"], keyword="unpublish")
```

### `ipc_observation_detail`

按 `project + id` 读取单条 observation 的完整记录，不截断 `tool_input` / `tool_output`。若 observation 的 tags 含 `jsonl:<path>:<line_range>`，返回结果会附带 `jsonl_path` 和 `line_range`。
Fetch a single observation row by `project + id` without truncating `tool_input` / `tool_output`. If the observation tags include `jsonl:<path>:<line_range>`, the result also carries `jsonl_path` and `line_range`.

```
ipc_observation_detail(project="xihe-jianmu-ipc", id=123)
```

### `ipc_register_session`

通过 Hub maintainer 创建或更新 `~/.claude/sessions-registry.json` 里的 session entry；已存在 name 时按 merge 语义覆盖传入字段，并刷新 `_last_updated` / `_last_updated_by`。
Create or update a session entry in `~/.claude/sessions-registry.json` through the Hub maintainer. Existing names are merged, with supplied fields overriding prior values while `_last_updated` / `_last_updated_by` are refreshed.

```
ipc_register_session(name="yuheng_builder", role="brand-director", projects=["xihe-yuheng-brandbook"])
```

### `ipc_update_session`

通过 Hub maintainer 仅更新某个已登记 session 的 `projects` 列表，其他字段保持不变。
Update only the `projects` list for an existing registered session through the Hub maintainer, leaving other fields untouched.

```
ipc_update_session(name="tech-worker", projects=["xihe-jianmu-ipc", "_portfolio"])
```

### `ipc_cost_summary`

查询 ADR-013 ccusage 成本聚合，覆盖今日、7 天、30 天或全部历史，可按 IPC/project 名或模型分组；`granularity="hour"` 返回小时桶矩阵。
Query ADR-013 ccusage cost totals for today, 7 days, 30 days, or all history, optionally grouped by IPC/project name or model. `granularity="hour"` returns hourly bucket matrices.

| Param         | Type   | Required | Description                                      |
| ------------- | ------ | -------- | ------------------------------------------------ |
| `window`      | string | no       | `today`, `7d`, `30d`, or `all`                   |
| `group_by`    | string | no       | `none`, `ipc_name`, or `model`                   |
| `granularity` | string | no       | `hour` or `day`; defaults to `hour` for `today` |

```
ipc_cost_summary(window="today", group_by="ipc_name", granularity="hour")
ipc_cost_summary(window="30d", group_by="model")
```

### `ipc_token_status`

查询 ccusage 当前 5h block 配额状态，返回 `remaining_pct`、`used_pct`、`resets_at` 和 `total_tokens`。
Return current ccusage 5h block quota status with `remaining_pct`, `used_pct`, `resets_at`, and `total_tokens`.

```
ipc_token_status()
```

---

## HTTP API

Hub 在与 WebSocket 相同的端口上暴露 HTTP API，任意工具——Codex、Shell 脚本、CI 流水线——都可以在无 WebSocket 连接的情况下使用。

The hub exposes an HTTP API on the same port as WebSocket. Any tool — Codex, shell scripts, CI pipelines — can use it without a WebSocket connection.

### 消息 / Messages

#### `POST /send`

从任意 HTTP 客户端发送消息。
Send a message from any HTTP client.

若 target 不存在，sender 会立即收到一条 `unknown-target` 警告。
If the target name does not exist, the sender immediately receives an `unknown-target` warning.

```json
// Request
{ "from": "codex-agent", "to": "main", "content": "PR review complete", "topic": "reviews" }

// Response (online)
{ "accepted": true, "id": "msg-abc123", "online": true, "buffered": false }

// Response (offline, buffered)
{ "accepted": true, "id": "msg-abc123", "online": false, "buffered": true }
```

```bash
curl -s -X POST http://localhost:3179/send \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token" \
  -d '{"from":"ci","to":"main","content":"tests passed"}'
```

#### `POST /suspend`

session 主动上报自己已挂起，供 `network-up` 恢复广播时携带挂起名单。重复上报同名 session 会覆盖 `reason` / `task_description` / `suspended_at` / `suspended_by`。

Session self-report endpoint for network suspension. Repeated suspend requests with the same session name are idempotent and overwrite the stored reason, task description, timestamp, and source.

`suspended_by` allowed values: `self` / `watchdog` / `harness`

```json
// Request
{
  "from": "xihe-builder",
  "reason": "Anthropic timeout",
  "task_description": "resume AC-AUTH-08 implementation",
  "suspended_by": "self"
}

// Response
{
  "ok": true,
  "name": "xihe-builder",
  "suspended_at": 1776516090000,
  "suspended_by": "self"
}
```

#### `POST /prepare-rebind`

显式会话接力入口。在线 session 在主动下线前先调用它，Hub 会写入 `pending_rebind`，保留当前订阅 topics，并在宽限期内把新的点对点消息写入 `buffered_messages`，等待同名继任者接管。

Explicit handoff endpoint. A live session calls it before going offline. The hub writes a `pending_rebind` row, preserves the current topic subscriptions, and buffers new direct messages during the grace window for the successor with the same session name.

默认 `ttl_seconds=5`，最大 `60`。调用方必须是当前在线 session；若启用了 `IPC_AUTH_TOKEN` 或 `auth-tokens.json`，此 endpoint 还要求 `Authorization: Bearer ...`。

Default `ttl_seconds` is `5` and the maximum is `60`. The caller must be the currently connected session. When `IPC_AUTH_TOKEN` or `auth-tokens.json` is enabled, this endpoint also requires `Authorization: Bearer ...`.

```json
// Request
{
  "name": "worker",
  "ttl_seconds": 5,
  "topics": ["network-up", "custom-xyz"],
  "next_session_hint": "worker-next"
}

// Response
{
  "ok": true,
  "will_release_at": 1776579000000,
  "ttl_seconds": 5
}
```

#### `POST /reclaim-name`

自助回收同名 zombie 占位入口。仅接受 loopback 调用，不走 `IPC_AUTH_TOKEN` / `auth-tokens.json` 全局网关；Hub 会对当前 holder 主动发送 ping，5 秒内若未收到 pong，则 terminate 旧连接，让后续同名 WS 连入复用现有 zombie/force-rebind 路径。

Self-service zombie reclaim endpoint for a session name. It only accepts loopback callers and intentionally bypasses the global `IPC_AUTH_TOKEN` / `auth-tokens.json` gateway. The hub actively pings the current holder; if no pong arrives within 5 seconds, it terminates the old socket so the next same-name WS connect can reuse the existing zombie/force-rebind path.

```json
// Request
{ "name": "harness" }

// Response (evicted)
{ "ok": true, "evicted": true, "previousConnectedAt": 1776579000000 }

// Response (holder alive)
{ "ok": false, "reason": "holder-alive", "lastAliveAt": 1776579005000 }
```

#### `POST /wake-suspended`

临时运维 endpoint。调用结构化 `network-up` helper，向所有订阅 `network-up` topic 的 session 广播恢复事件，并**消费/清空** `suspended_sessions` 表。

Temporary ops endpoint. Calls the structured `network-up` helper, broadcasts a recovery event to every session subscribed to the `network-up` topic, and **consumes/clears** the `suspended_sessions` table.

```json
// Request (optional body accepted for backward compatibility; fields are ignored)
{ "reason": "network restored", "from": "harness" }

// Response
{
  "ok": true,
  "broadcastTo": 3,
  "subscribers": ["agent-a", "agent-b", "agent-c"],
  "clearedSessions": ["houtu_builder", "taiwei_builder"]
}
```

#### `POST /internal/network-event`

内部桥接 endpoint，仅接受 `127.0.0.1` / `::1` 调用，并要求 `X-Internal-Token`。`network-watchdog` 使用它把 `network-down` / `network-up` 事件桥接到 Hub 内部广播 helper。

Internal bridge endpoint. It only accepts loopback callers (`127.0.0.1` / `::1`) and requires `X-Internal-Token`. `network-watchdog` uses it to bridge `network-down` / `network-up` events into the hub's broadcast helpers.

#### `POST /feishu-reply`

直接回复飞书，跳过 IPC 路由。
Reply to Feishu directly, bypassing IPC routing.

```json
// Request
{ "app": "bot-name", "content": "Task completed", "from": "worker" }

// Response
{ "ok": true, "app": "bot-name" }
```

#### `GET /messages?peer=&from=&to=&limit=`

查询持久化消息历史。
Query persisted message history.

| Param   | Type   | Description                   |
| ------- | ------ | ----------------------------- |
| `peer`  | string | Filter by sender or recipient |
| `from`  | string | Start time (ISO 8601)         |
| `to`    | string | End time (ISO 8601)           |
| `limit` | number | Max results (default 50)      |

#### `GET /recent-messages?name=&since=&limit=`

查询发给指定 session（含广播 `*`）的近期持久化消息，适合崩溃重连或冷启动补回 backlog。
Query recent persisted messages addressed to a specific session (including broadcast `*`). Useful for cold-start or reconnect recovery.
This history is pull-only: reconnecting sessions do not receive it automatically via `flushInbox`.

| Param   | Type   | Description                                                                    |
| ------- | ------ | ------------------------------------------------------------------------------ |
| `name`  | string | Target session name (required)                                                 |
| `since` | number | Lookback window in milliseconds; default `21600000` (6h), max `604800000` (7d) |
| `limit` | number | Max results; default `50`, max `500`                                           |

```json
{
  "ok": true,
  "name": "worker",
  "since": 21600000,
  "limit": 50,
  "messages": []
}
```

### Session Registry

#### `POST /registry/register`

创建或更新 `~/.claude/sessions-registry.json` 中的 session 条目。现有 name 走 merge 语义，新传入字段覆盖旧值，同时刷新 `_last_updated` / `_last_updated_by`。
Create or update a session entry in `~/.claude/sessions-registry.json`. Existing names are merged, with supplied fields overriding prior values while `_last_updated` / `_last_updated_by` are refreshed.

```json
{
  "name": "yuheng_builder",
  "role": "brand-director",
  "projects": ["xihe-yuheng-brandbook"],
  "access_scope": "primary",
  "requested_by": "jianmu-pm"
}
```

#### `POST /registry/update`

仅更新已登记 session 的 `projects` 列表；若 name 不存在则返回 `404`。
Update only the `projects` list for an existing registered session. Returns `404` if the name does not exist.

```json
{
  "name": "tech-worker",
  "projects": ["xihe-jianmu-ipc", "_portfolio"],
  "requested_by": "jianmu-pm"
}
```

### Harness Self-Handover

- `network-watchdog` 已扩成 7 路探测：`cliProxy / hub / anthropic / dns / committed_pct / available_ram_mb / harness`
- watchdog 会订阅 topic `harness-heartbeat`，解析 `【harness <ISO-ts> · context-pct】<N>% | state=... | next_action=...`
- harness liveness now comes from `GET /session-alive?name=harness`: only `{ alive: true }` counts as WS still being `OPEN`
- the watchdog only refreshes in-memory `lastSeenOnlineAt` when probe returns `{ ok: true, connected: true }`; otherwise the baseline stays unchanged
- when `/session-alive` reports `alive=false`, the probe falls back through `lastSeenOnlineAt -> connectedAt -> null`; once `wsDisconnectGraceMs` (default 60s) expires it raises `ws-disconnected-grace-exceeded`
- `committed_pct` monitors system commit ratio: 90% broadcasts a `critique` WARN, 95% runs `session-guard.ps1 -Action tree-kill` to clean the largest vitest subtree with identity safeguards.
- `available_ram_mb` monitors system available physical RAM (MB): < 10GB broadcasts a `critique` WARN for sessions to reduce load, < 5GB broadcasts a CRIT suggesting immediate heavy-task kills. It does **not** call tree-kill; hard vitest cleanup stays owned by `committed_pct` 95%.
- `GET http://127.0.0.1:3180/status` 现在额外返回 `harness` 字段，包含 `state / contextWarnPct / lastTransition / lastReason / lastProbe`
- 只有当 harness 进入 `down`，watchdog 才会调用 `triggerHarnessSelfHandover()`；`degraded` 只是风险态，不会直接触发 handover
- the existing 2-minute cold-start grace still applies: before the first fresh `heartbeat` / `pong` / `probe-ok`, even `ws-down-grace-exceeded` is suppressed to `held-by-grace`
- watchdog 会过滤历史 / 非法 heartbeat `ts`：若 `ts < watchdog startedAt - 60s` 或时间戳解析失败，该 heartbeat 会被忽略，不驱动 transition / handover
- `lib/lineage.mjs` 用 SQLite `lineage` 表限制递归 handover 深度和滑动窗口频次，避免 watchdog 无限自拉起

### 会话接力 / Session Handover

Hub 同时支持两条同名接力路径：

- `release-rebind`（显式交接）: 旧 session 先 `POST /prepare-rebind`，随后主动断开。5 秒宽限期内到达的点对点消息会写入 `pending_rebind.buffered_messages`，继任者以同名连入后会静默继承 `topics`，并一次性收到 `SQLite inbox + buffered_messages`。
- `force/zombie rebind`（隐式接管）: 旧 session 崩溃、卡死或未提前宣告时，新连接可用 `?force=1` 或等待 `isAlive=false` 僵尸检测接管。该路径只回放现有 `inbox`，不会恢复旧 `topics`；若要补历史，session 应主动调用 `ipc_recent_messages` 或 `GET /recent-messages`。

The hub supports two same-name takeover paths:

- `release-rebind` (explicit handoff): the old session calls `POST /prepare-rebind` and then disconnects intentionally. Direct messages that arrive during the 5-second grace window are stored in `pending_rebind.buffered_messages`. The successor reconnects with the same name, silently inherits `topics`, and receives `SQLite inbox + buffered_messages` in one replay batch.
- `force/zombie rebind` (implicit takeover): when the old session crashes, stalls, or never announced a handoff, a new connection can use `?force=1` or wait for zombie detection (`isAlive=false`). This path replays only `inbox` and does not restore old `topics`; sessions should pull history explicitly via `ipc_recent_messages` or `GET /recent-messages`.

### 状态 / Status

#### `GET /health`

返回 Hub 状态、session 列表、消息计数。
Returns hub status, session list, and message count.

```json
{
  "ok": true,
  "uptime": 42.3,
  "sessions": [{ "name": "main", "connectedAt": 1711400000000, "topics": [] }],
  "messageCount": 1234
}
```

#### `GET /sessions`

仅返回 sessions 数组。
Returns the sessions array only.

#### `GET /session-alive?name=`

按最窄职责返回某个 session 的 WS 存活状态。`alive=true` 仅表示 `session.ws.readyState === OPEN`；stub session（`ws=null`）和不存在的 session 都会返回 `alive=false`。
Returns the narrow WS liveness view for one session. `alive=true` means only that `session.ws.readyState === OPEN`; stub sessions (`ws=null`) and missing sessions both return `alive=false`.

若启用了 `IPC_AUTH_TOKEN` 或 `auth-tokens.json`，此 endpoint 复用现有全局 HTTP auth 网关，需要 `Authorization: Bearer ...` 或 `X-IPC-Token`。
When `IPC_AUTH_TOKEN` or `auth-tokens.json` is enabled, this endpoint reuses the existing global HTTP auth gateway and requires `Authorization: Bearer ...` or `X-IPC-Token`.

```json
{
  "ok": true,
  "name": "harness",
  "alive": true,
  "connectedAt": 1776516090000,
  "lastAliveProbe": 1776516123456
}
```

#### `GET /stats?hours=N`

Per-agent 消息统计（默认 24 小时）。
Per-agent message statistics (default 24 hours).

### 结构化任务 / Structured Tasks

#### `POST /task`

创建结构化任务。
Create a structured task.

```json
// Request
{
  "from": "pm",
  "to": "worker",
  "title": "Fix login bug",
  "description": "Users report 500 on /login",
  "priority": "high",
  "deadline": "2026-04-08T00:00:00Z",
  "payload": {}
}

// Response
{ "ok": true, "taskId": "task-abc123", "online": true, "buffered": false }
```

#### `GET /tasks?agent=&status=&limit=`

任务列表和统计。
Task list with statistics.

| Param    | Type   | Description                                                                 |
| -------- | ------ | --------------------------------------------------------------------------- |
| `agent`  | string | Filter by agent name                                                        |
| `status` | string | Filter by status (`pending`, `started`, `in_progress`, `completed`, `failed`, `cancelled`) |
| `limit`  | number | Max results                                                                 |

#### `GET /tasks/:id`

单个任务详情。
Single task details.

#### `PATCH /tasks/:id`

更新任务状态。
Update task status.

```json
// Request
{ "status": "completed" }
```

### 监控 / Monitoring

#### `GET /` 或 `GET /dashboard/*`

监控 Dashboard，显示 session 列表、消息流、任务状态。
Monitoring dashboard showing sessions, message flow, task status.

---

## 飞书集成 / Feishu Integration

飞书集成分为两个独立部分：**feishu-bridge**（接收 + AI 控制台）和 **Hub**（发送）。bridge 是独立进程，避免了 Lark SDK WSClient 在同进程多实例时的全局状态冲突。

Feishu integration is split into two independent parts: **feishu-bridge** (receiving + AI console) and **Hub** (sending). The bridge runs as a standalone process, avoiding Lark SDK WSClient global state conflicts when multiple instances run in the same process.

多应用通过 `feishu-apps.json` 配置（已 gitignore，含密钥）。项目提供 `feishu-apps.example.json` 作为模板。

Multi-app support via `feishu-apps.json` (gitignored, contains secrets). `feishu-apps.example.json` is provided as a template.

**每个应用配置包含 / Each app entry contains:**

| 字段 / Field   | 说明 / Description                                          |
| -------------- | ----------------------------------------------------------- |
| `name`         | 应用显示名称 / App display name                             |
| `appId`        | 飞书应用 ID / Feishu App ID                                 |
| `appSecret`    | 飞书应用密钥 / Feishu App Secret                            |
| `targetOpenId` | 默认消息接收人 / Default message recipient                  |
| `receive`      | 接收方式：Lark SDK WSClient / Receive via Lark SDK WSClient |
| `send`         | 发送方式：Feishu Bot API / Send via Feishu Bot API          |
| `routeTo`      | 目标 IPC session 名称 / Target IPC session name             |

### 消息收发 / Message Flow

**入站 / Inbound（feishu-bridge 独立进程）:**

feishu-bridge 读取 `feishu-apps.json`，为每个应用启动 Lark SDK WSClient 长连接。收到飞书消息后通过 HTTP `POST /send` 转发给 Hub，全程 0 LLM tokens。bridge 在独立进程中运行，彻底解决了 WSClient 全局状态冲突问题。支持回复/引用消息（自动获取 parent_id 原文）。支持图片/文件下载和富文本 post 解析。

The feishu-bridge reads `feishu-apps.json` and starts a Lark SDK WSClient for each app. Incoming Feishu messages are forwarded to Hub via HTTP `POST /send` — 0 LLM tokens. Running in a separate process eliminates WSClient global state conflicts entirely. Supports reply/quote messages (fetches parent_id content automatically). Supports image/file download and rich text post parsing.

**内置 ping / Built-in ping:** 飞书发 "ping" 给机器人，bridge 直接回复 "pong"，不经过 Hub 或 LLM，用于快速验证链路。

Send "ping" to the bot in Feishu, bridge replies "pong" directly without Hub or LLM — useful for quick link testing.

**出站 / Outbound（Hub 内）:** 通过 `POST /feishu-reply` 端点回复飞书，或在 IPC 中使用 `ipc_send(to="feishu:app-name")`。Hub 通过 Bot API 发送。

Outbound (inside Hub): Reply to Feishu via `POST /feishu-reply` endpoint, or use `ipc_send(to="feishu:app-name")` from any IPC session. Hub sends via Bot API.

**自动回复 / Auto-reply:** Stop hook（`bin/feishu-auto-reply.cjs`）在 Claude Code 响应结束时捕获 `last_assistant_message`，自动 POST 到 Hub 的 `/feishu-reply`，实现飞书消息的全自动回复，无需 tool call。

Auto-reply: The Stop hook (`bin/feishu-auto-reply.cjs`) captures `last_assistant_message` when Claude Code finishes responding, and automatically POSTs it to Hub's `/feishu-reply`. Fully automatic Feishu replies with no tool call needed.

### 飞书 AI 控制台 / Feishu AI Console

P2P 对话及群聊 @机器人时支持以下命令（bridge 拦截处理，不转发 Hub）：

Commands available in P2P chat and group @mention (intercepted by bridge, not forwarded to Hub):

| 命令 / Command            | 说明 / Description                                                   |
| ------------------------- | -------------------------------------------------------------------- |
| `状态` / `status`         | 查看所有 Agent 在线状态（卡片）/ View all agent online status (card) |
| `帮助` / `help`           | 显示命令列表 / Show command list                                     |
| `让{agent}去{task}`       | 派发结构化任务给指定 Agent / Dispatch structured task to agent       |
| `广播:{content}`          | 向所有在线 Agent 广播 / Broadcast to all online agents               |
| `重启 {target}`           | 重启 bridge/worker / Restart bridge/worker                           |
| `消息记录` / `history`    | 查看最近消息 / View recent messages                                  |
| `日报` / `report`         | 生成工作报告 / Generate work report                                  |
| `新增机器人` / `/add-bot` | 交互表单添加新飞书应用 / Add new Feishu app via form                 |

**Agent 状态追踪 / Agent Status Tracking:** 15 秒轮询 Hub `/sessions`，检测上下线变更并自动推送飞书通知。状态卡片支持刷新按钮。

15-second polling of Hub `/sessions`, detects online/offline changes and pushes Feishu notifications. Status cards support refresh button.

**审批流 / Approval Flow:** Agent 可发送审批卡片（确认/拒绝按钮），按钮回调通过 IPC 回传审批结果。

Agents can send approval cards (confirm/reject buttons), button callbacks return approval results via IPC.

**日报定时推送 / Scheduled Daily Report:** 每日定时推送工作报告（默认 9:00，通过 `IPC_REPORT_HOUR` 配置），汇总 per-agent 消息统计。

Daily work report pushed on schedule (default 9:00, configurable via `IPC_REPORT_HOUR`), summarizing per-agent message statistics.

---

## Claude Code 集成细节 / Claude Code Integration

Claude Code 通过 `.mcp.json` 加载 MCP server。接收到的消息以 `<channel>` 通知推送，无需轮询即可唤醒空闲的 Claude Code 会话。流程：

Claude Code loads the MCP server via `.mcp.json`. Incoming messages are pushed as `<channel>` notifications, which wake idle Claude Code sessions without requiring a poll loop. The flow:

1. 发送方调用 `ipc_send(to="target-session", content="...")` / Sender calls `ipc_send(to="target-session", content="...")`
2. Hub 若目标在线则走 WebSocket 路由，离线则缓冲；OpenClaw session 始终走 `POST /hooks/wake` / Hub routes over WebSocket if target is online; buffers if offline; OpenClaw sessions always receive via `POST /hooks/wake`
3. Claude Code 接收 `<channel>` 通知并处理 / Claude Code receives a `<channel>` notification and processes it

---

## OpenClaw 集成细节 / OpenClaw Integration

OpenClaw 通过 `openclaw.json` 将 `mcp-server.mjs` 作为标准 MCP server 加载，无需修改 OpenClaw 代码。OpenClaw adapter 处理反向通道：

OpenClaw loads `mcp-server.mjs` as a standard MCP server via `openclaw.json`. No code changes to OpenClaw required. The OpenClaw adapter handles the reverse direction:

- 当 Hub 收到发给 `openclaw-*` session 的消息时，Hub **始终**通过 HTTP 调用 Gateway URL（`OPENCLAW_URL`）的 `POST /hooks/wake`，将消息注入 OpenClaw 主会话。即使 openclaw MCP session 通过 WebSocket 连接到了 Hub，消息仍走 `/hooks/wake`，因为 WebSocket 连接只是 MCP 客户端，不是 OpenClaw 的主 agent 会话 / When a message arrives at the hub addressed to an `openclaw-*` session, the hub **always** calls `POST /hooks/wake` on the Gateway URL (`OPENCLAW_URL`) to inject the message into OpenClaw's main session. Even if the openclaw MCP session is connected via WebSocket, messages still go through `/hooks/wake` — the WebSocket connection is just the MCP client, not OpenClaw's main agent session
- Gateway 将消息作为系统事件推入主会话 / The Gateway pushes the message into the main session as a system event
- wake 请求体为 `{ text, mode: "now" }`，text 中包含 IPC 来源和消息内容 / The wake request body is `{ text, mode: "now" }`, where text includes the IPC source and message content

这意味着 Claude Code 可以向 OpenClaw 实时推送消息——全部通过同一套 `ipc_send` / `ipc_sessions` 接口。OpenClaw 收到 wake 后可在主会话中处理并通过 `ipc_send` 回复。

This means Claude Code can push messages to OpenClaw in real-time — all through the same `ipc_send` / `ipc_sessions` interface. OpenClaw receives the wake event in its main session and can reply back via `ipc_send`.

---

## 环境变量 / Environment Variables

| Variable                   | Default                  | Description                                                                                      |
| -------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------ |
| `IPC_NAME`                 | `session-<pid>`          | Session 显示名称 / Session display name                                                          |
| `IPC_DEFAULT_NAME`         | —                        | `.mcp.json` 中的默认名，`IPC_NAME` 优先 / Default name in `.mcp.json`, `IPC_NAME` takes priority |
| `IPC_PORT`                 | `3179`                   | Hub WebSocket + HTTP 端口 / Hub port                                                             |
| `IPC_WATCHDOG_PORT`        | `3180`                   | network-watchdog `/status` 端口 / network-watchdog status port                                   |
| `IPC_WATCHDOG_INTERVAL_MS` | `30000`                  | network-watchdog probe interval in milliseconds                                                  |
| `IPC_HUB_HOST`             | auto-detect              | Hub 主机；WSL2 自动从 `/etc/resolv.conf` 读取 / Hub host; auto-detects WSL2 Windows host         |
| `IPC_HUB_AUTOSTART`        | `true`                   | MCP server 连接时自动启动 Hub / Auto-start hub when MCP server connects                          |
| `IPC_AUTH_TOKEN`           | (empty)                  | 认证 token / Auth token. If set, all connections must provide it                                 |
| `IPC_INTERNAL_TOKEN`       | file fallback            | Shared loopback token for hub/watchdog internal endpoints                                        |
| `IPC_DB_PATH`              | `data/messages.db`       | SQLite 数据库路径 / SQLite database path                                                         |
| `IPC_REPORT_HOUR`          | `9`                      | 日报定时推送小时（0-23）/ Daily report push hour (0-23)                                          |
| `IPC_CHANNEL_URL`          | —                        | Channel Server HTTP 端点 / Channel Server HTTP endpoint                                          |
| `OPENCLAW_URL`             | `http://127.0.0.1:18789` | OpenClaw Gateway 地址 / OpenClaw Gateway URL                                                     |
| `OPENCLAW_TOKEN`           | —                        | OpenClaw API token（`Authorization: Bearer`）                                                    |

飞书配置已从环境变量迁移到 `feishu-apps.json`，支持多应用。见 `feishu-apps.example.json`。

Feishu config has migrated from env vars to `feishu-apps.json` for multi-app support. See `feishu-apps.example.json`.

---

## 跨 AI 支持 / Cross-AI Support

建木并非 Claude 专属。任何能发 HTTP 请求或打开 WebSocket 的工具都可以接入：

Jianmu is not Claude-specific. Any tool that can send HTTP requests or open a WebSocket can participate:

| AI Tool        | Integration Method                                         |
| -------------- | ---------------------------------------------------------- |
| Claude Code    | MCP Server (`mcp-server.mjs`) via `.mcp.json`              |
| OpenClaw       | MCP Server via `openclaw.json` + OpenClaw adapter          |
| OpenAI Codex   | HTTP API (`POST /send`)                                    |
| Custom scripts | HTTP API or raw WebSocket                                  |
| Feishu Bots    | feishu-bridge (WSClient receiving) + Hub Bot API (sending) |

---

## WSL2 支持 / WSL2 Support

在 WSL2 内运行时，MCP server 会自动从 `/etc/resolv.conf` 读取 `nameserver` 行检测 Windows 宿主 IP，并连接到 Windows 侧运行的 Hub，无需手动配置。

When running inside WSL2, the MCP server automatically reads the `nameserver` line from `/etc/resolv.conf` to detect the Windows host IP and connect to the hub running on the Windows side. No manual configuration needed.

覆盖方式 / To override: `export IPC_HUB_HOST=172.x.x.x`

**`ipc_spawn` 交互模式在 WSL2 中的行为 / `ipc_spawn` interactive mode on WSL2:**

- 优先使用 `wt.exe`（Windows Terminal）打开新标签页，回退到 `powershell.exe` / Prefers `wt.exe` (Windows Terminal) to open a new tab; falls back to `powershell.exe`
- 生成临时 `.ps1` 脚本文件并写入 UTF-8 BOM（`\uFEFF`），避免 PowerShell 乱码 / Writes a temp `.ps1` script file with UTF-8 BOM (`\uFEFF`) to prevent PowerShell encoding issues
- WSL 路径自动转换为 Windows 路径（`/mnt/c/` → `C:\`）/ WSL paths are automatically converted to Windows paths (`/mnt/c/` → `C:\`)

---

## 已知限制 / Known Limitations

- **单 Hub / Single hub**: 不支持多 Hub 联邦。所有 session 必须连接到同一 Hub 实例。跨机器部署需要反向代理或隧道。/ No multi-hub federation. All sessions must connect to the same hub instance. Cross-machine setups require a reverse proxy or tunnel.
- **飞书自动回复仅限 Claude Code / Feishu auto-reply is Claude Code only**: Stop hook（`bin/feishu-auto-reply.cjs`）依赖 Claude Code 的 hook 机制，不适用于 OpenClaw 或其他工具。/ The Stop hook (`bin/feishu-auto-reply.cjs`) relies on Claude Code's hook mechanism and does not work with OpenClaw or other tools.
- **OpenClaw `.env` 配置 / OpenClaw `.env` configuration**: OpenClaw adapter 需要 `OPENCLAW_URL` 和 `OPENCLAW_TOKEN` 才能工作。可以在 `hub.mjs` 同目录放置 `.env` 文件，也可以设置环境变量。/ The OpenClaw adapter requires `OPENCLAW_URL` and `OPENCLAW_TOKEN` to function. Place a `.env` file in the same directory as `hub.mjs`, or set them as environment variables.

---

## 项目结构 / Project Structure

```
xihe-jianmu-ipc/
├── hub.mjs                    # WebSocket hub server (+ Feishu sending)
├── mcp-server.mjs             # MCP server (Claude Code + OpenClaw adapter)
├── feishu-bridge.mjs          # Standalone Feishu receiving + AI console
├── feishu-apps.example.json   # Feishu multi-app config template
├── ecosystem.config.cjs       # PM2 process config
├── SKILL.md                   # OpenClaw ClawHub skill manifest
├── lib/
│   ├── constants.mjs          # Shared constants (ports, timeouts)
│   ├── protocol.mjs           # Message schema and validation
│   ├── db.mjs                 # SQLite persistence (WAL mode, 7-day TTL)
│   ├── audit.mjs              # Audit logging
│   ├── redact.mjs             # Sensitive info redaction
│   ├── command-parser.mjs     # Feishu command parser (8 commands)
│   ├── agent-status.mjs       # Agent online status tracking (15s poll)
│   ├── console-cards.mjs      # Feishu card templates (status/help/dispatch/broadcast/approval/report/error)
│   └── feishu-worker-thread.mjs  # Per-app WSClient worker thread
├── bin/
│   ├── jianmu.mjs             # CLI entry point (jianmu hub / jianmu status)
│   ├── feishu-auto-reply.cjs  # Stop hook: auto-reply to Feishu
│   ├── feishu-reply.sh        # Shell shortcut for Feishu reply
│   ├── install.ps1            # PowerShell profile installer
│   ├── patch-channels.mjs     # Claude Code channel patch helper
│   ├── start.sh               # Start hub + bridge
│   ├── stop.sh                # Stop all processes
│   ├── restart.sh             # Restart all
│   ├── status.sh              # Show process status
│   ├── update.sh              # Pull + restart
│   └── run-forever.sh         # Auto-restart wrapper
├── dashboard/
│   └── index.html             # Monitoring dashboard (sessions, messages, tasks)
├── data/
│   ├── messages.db            # SQLite database (gitignored)
│   ├── audit.log              # Audit log (gitignored)
│   └── feishu-files/          # Downloaded Feishu attachments
├── docs/
│   ├── feishu-events.md       # Feishu event subscription guide
│   └── feishu-permissions.json  # Feishu app permission template
└── package.json
```

---

## 关于曦和 AI / About Xihe AI

曦和（Xihe）得名于中国神话中驾驭太阳的女神。[xihe-forge](https://github.com/xihe-forge) 是曦和 AI 的开源锻造炉——我们在这里把实用的 AI 工具从想法锤炼成可以直接上手的开源项目。`xihe-jianmu-ipc` 是锻造炉中的第三个开源作品，也是我们多 AI 协作基础设施方向的重要一环。

Xihe is named after the sun goddess who drives the solar chariot in Chinese mythology. [xihe-forge](https://github.com/xihe-forge) is Xihe AI's open-source forge — where we hammer practical AI tools from ideas into ready-to-use open-source projects. `xihe-jianmu-ipc` is the third open-source piece out of the forge and a key part of our multi-AI collaboration infrastructure.

### 项目矩阵 / Project Lineup

| Project               | Description                                            |
| --------------------- | ------------------------------------------------------ |
| `xihe-jizhu-scaffold` | AI 项目脚手架 / AI project scaffold                    |
| `xihe-jianmu-ipc`     | 多 AI 通信 Hub（本项目）/ Multi-AI communication hub   |
| `xihe-core`           | 核心库 / Core library                                  |
| `lumidrive-site`      | 光影随行官网 / Lumidrive official site                 |
| `xihe-rinian-seo`     | SEO 工具 / SEO toolkit                                 |
| `heartreadAI`         | AI 心理健康产品 / AI mental wellness product           |
| `xihe-jinwu-epet`     | 桌面宠物 / Desktop pet                                 |
| `xihe-taiwei-bridge`  | 多 Agent 协作平台 / Multi-agent collaboration platform |

### 网站链接 / Links

- 组织主页 / Org: https://github.com/xihe-forge
- 光影随行官网 / Lumidrive: https://lumidrivetech.com
- HeartRead 官网 / HeartRead: https://heartread.ai

更多面向 AI 协作、搜索、增长与数字体验的产品仍在持续锻造中，欢迎关注组织、试用产品或参与贡献。

More products for AI collaboration, search, growth, and digital experiences are actively being forged — follow the org, try the products, or contribute.

---

## 发布 SOP / Publishing SOP

This repository is prepared for npm and MCP Registry publishing, but publishing requires maintainer credentials and must be run manually.

1. Verify the package:

```bash
npm test
npm pack --dry-run
npm pack
node tests/dogfood-npm-pack-live.mjs .\xihe-forge-jianmu-ipc-0.5.0.tgz
```

2. Publish to npm:

```bash
npm login
npm publish --access public
```

3. Publish to the MCP Registry:

```bash
npm install -g mcp-publisher
mcp-publisher login github
mcp-publisher publish
```

4. Confirm registry metadata:

```bash
npm view @xihe-forge/jianmu-ipc name version mcpName bin
```

The MCP Registry package name is `io.github.xihe-forge/jianmu-ipc`; it must stay identical in `package.json#mcpName` and `mcp-registry/server.json#name`.

---

## Claude HUD Jianmu Usage Patch

For current and future `claude-hud` plugin versions, use the auto-apply installer:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\workspace\ai\research\xiheAi\xihe-jianmu-ipc\bin\install-hud-patch.ps1 -RegisterTask
```

The patch suppresses direct Anthropic usage fallback when Jianmu Hub is unavailable, so concurrent HUD renders do not recreate a direct `/api/oauth/usage` storm.

---

## License

MIT — by [xihe-forge](https://github.com/xihe-forge)







