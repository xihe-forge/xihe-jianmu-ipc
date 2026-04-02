# xihe-jianmu-ipc

> **命名由来 / Etymology** — 遵循曦和项目三段式命名规范 `xihe-{隐喻}-{功能}`：
>
> - **xihe（曦和）** — 品牌。源自中国神话中的太阳女神曦和 / Brand. Xihe, the sun goddess in Chinese mythology
> - **jianmu（建木）** — 隐喻。建木是上古神话中天地之间的通天神树，诸神借之往来天地、沟通上下。多个 AI 会话之间的通信如建木般无声连通 / Metaphor. Jiànmù is the mythical World Tree bridging heaven and earth in ancient Chinese mythology — gods traveled between realms through it in silence. IPC messages flow between AI sessions like spirits through the World Tree
> - **ipc** — 功能。进程间实时通信 / Function. Real-time inter-process communication

多 AI 会话实时通信中枢——WebSocket 消息路由 + MCP 集成 + Channel 推送唤醒。

Real-time communication hub for AI coding sessions — WebSocket message routing + MCP integration + Channel push notifications.

为需要多个 AI agent 协作而非各自为战的开发者而建。

Built for developers who need multiple AI agents to collaborate, not work in isolation.

由 [Xihe AI](https://github.com/xihe-forge) 锻造，面向所有需要跨 AI 会话协同的开发者。
Forged by [Xihe AI](https://github.com/xihe-forge), for developers who need real coordination across AI sessions.

---

## 为什么存在：Token 成本问题 / Why This Exists: The Token Cost Problem

多 agent 协作的标准路径——让 LLM 充当路由器，通过 Gateway 中转上下文——代价极高。每次跨 session 通信都会触发完整的 agent run，重新加载整个 JSONL 对话记录。随着对话变长，token 消耗是 O(N²) 累积的。

The standard path for multi-agent coordination — routing messages through the LLM, rebuilding context at every hop — is expensive by design. Every inter-session message triggers a full agent run that reloads the entire JSONL transcript. As conversations grow, token costs scale O(N²) cumulatively.

已有记录的真实代价 / Documented real-world costs:

- Claude Code issue #4911: sub-agent consumed **160K tokens** for a task that took 2–3K when done directly
- Claude Code issue #27645: *"Subagents don't share context — they re-read and re-analyze everything. 5–10x more token-efficient to do direct edits."*
- Claude Code issue #18240: **296K/200K tokens** (148% context overflow) after a subagent returned
- ICLR 2026 research: ~30% of tokens in multi-agent operations are consumed unnecessarily by context reconstruction
- Anthropic's own research: multi-agent uses **15× more tokens** than equivalent single-agent work

**建木的思路 / The Jianmu approach**: 不让 LLM 做路由，让哑管道做路由。消息通过 WebSocket 直接送达目标 session，LLM 只看到最终消息，看不到路由历史。每条消息的 token 开销约 50 tokens，与对话深度无关。

**The Jianmu approach**: route through a dumb pipe, not through the LLM. Messages travel over WebSocket directly to the target session. The LLM sees only the final message — not the routing history. Token cost per message: ~50 tokens, regardless of conversation depth.

---

### 飞书集成 / Feishu Integration

飞书接收由独立的 feishu-bridge 进程处理（不在 Hub 内），避免 Lark SDK WSClient 全局状态冲突。bridge 读取 feishu-apps.json，通过 WSClient 接收消息后 HTTP POST /send 转发给 Hub（0 LLM tokens）。Hub 仅负责飞书发送（Bot API）。

Feishu receiving runs as a standalone feishu-bridge process (not inside Hub), avoiding Lark SDK WSClient global state conflicts. The bridge reads feishu-apps.json, receives messages via WSClient, and forwards them to Hub via HTTP POST /send (0 LLM tokens). Hub only handles Feishu sending (Bot API).

- 接收：feishu-bridge 独立进程，WSClient 长连接，无需公网 IP / Receive: standalone feishu-bridge process, WSClient, no public IP needed
- 发送：Hub 通过 Bot API 直推或 POST /feishu-reply / Send: Hub via Bot API or POST /feishu-reply
- 回复/引用：bridge 自动获取 parent_id 原文 / Reply/quote: bridge fetches parent_id content
- 内置 ping：飞书发 "ping" 给机器人，直接回复 "pong"，不经过 Hub/LLM / Built-in ping: send "ping" to bot, gets "pong" without Hub/LLM
- 自动回复：Claude Code Stop hook 捕获响应自动发回飞书 / Auto-reply: Stop hook captures response
- 多应用：feishu-apps.json 配置任意数量飞书机器人 / Multi-app: any number of bots

---

## 架构 / Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Hub (hub.mjs)                        │
│           WebSocket server + HTTP API on :3179              │
│  - Session registry (name → ws connection)                  │
│  - Offline inbox with TTL-based cleanup                     │
│  - Topic pub/sub fanout                                     │
│  - Heartbeat / auto-reconnect                               │
└──────────┬───────────────────────┬──────────────────────────┘
           │ ws://localhost:3179   │ http://localhost:3179
           │                       │
 ┌─────────▼──────────┐  ┌────────▼────────────────────────┐
 │  MCP Server        │  │  HTTP API                       │
 │  (mcp-server.mjs)  │  │  POST /send  (online/buffered)  │
 │                    │  │  GET  /health                   │
 │  Claude Code &     │  │  GET  /sessions                 │
 │  OpenClaw load     │  │                                 │
 │  via stdio MCP     │  │  Any HTTP client: Codex,        │
 │  protocol          │  │  curl, scripts, CI pipelines    │
 └─────────┬──────────┘  └─────────────────────────────────┘
           │
 ┌─────────▼──────────────────────────────────────────────┐
 │  Channel (claude/channel capability)                    │
 │  Push incoming messages to Claude Code as              │
 │  <channel> notifications — wakes idle sessions         │
 └────────────────────────────────────────────────────────┘
           │
 ┌─────────▼──────────────────────────────────────────────┐
 │  OpenClaw Adapter                                       │
 │  Outbound: Hub calls /hooks/wake on the Gateway         │
 │  when a message targets an openclaw-* session           │
 │  (ALWAYS via HTTP, even if WS is connected)             │
 │  Inbound:  OpenClaw loads mcp-server.mjs via            │
 │  openclaw.json — ipc_send reaches any connected tool    │
 └────────────────────────────────────────────────────────┘
           │
 ┌─────────▼──────────────────────────────────────────────┐
 │  Feishu Sending (Hub 内 / inside Hub)                   │
 │  Outbound: Hub sends messages via Feishu Bot API       │
 │  Endpoint: POST /feishu-reply                          │
 └────────────────────────────────────────────────────────┘

 ┌────────────────────────────────────────────────────────┐
 │  feishu-bridge (独立进程 / standalone process)          │
 │  Reads feishu-apps.json, connects via Lark SDK         │
 │  WSClient — no public IP needed                        │
 │  Forwards messages to Hub via HTTP POST /send          │
 │  Built-in ping: "ping" → "pong" (0 LLM tokens)        │
 │  Supports reply/quote (fetches parent_id content)      │
 └────────────────────────────────────────────────────────┘
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

**4. 发送消息 / Send messages**

From the `main` session:
```
ipc_send(to="worker", content="Start processing task A")
```

Incoming messages arrive in the `worker` session as `<channel>` notifications that wake idle sessions.

**5. Windows PowerShell 快捷方式（可选）/ Windows PowerShell shortcut (optional)**

```powershell
# 安装 ipc 函数到 PowerShell profile / Install the `ipc` function into your PowerShell profile:
.\bin\install.ps1

# 用 ipc 命令打开 Claude Code 会话 / Open Claude Code sessions with:
ipc main
ipc worker
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

| Param | Type | Required | Description |
|---|---|---|---|
| `to` | string | yes | Target session name, or `*` for broadcast |
| `content` | string | yes | Message content |
| `topic` | string | no | Optional topic tag for pub/sub fanout |

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

| Param | Type | Required | Description |
|---|---|---|---|
| `topic` | string | yes | Topic name |
| `action` | string | yes | `"subscribe"` or `"unsubscribe"` |

```
ipc_subscribe(topic="build-events", action="subscribe")
ipc_send(to="worker", content="build started", topic="build-events")
```

### `ipc_spawn`

生成一个新的 Claude Code 会话（后台或交互式）。
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

生成的 session 会自动获知自己的 IPC 名称，并被指示在完成后向生成方 session 汇报。
Spawned sessions automatically know their IPC name and are instructed to report back to the spawning session when done.

---

## 环境变量 / Environment Variables

| Variable | Default | Description |
|---|---|---|
| `IPC_NAME` | `session-<pid>` | Session display name (set this explicitly) |
| `IPC_PORT` | `3179` | Hub WebSocket + HTTP port |
| `IPC_HUB_HOST` | auto-detect | Hub host; auto-detects WSL2 Windows host from `/etc/resolv.conf` |
| `IPC_HUB_AUTOSTART` | `true` | Auto-start hub if not running when MCP server connects |
| `IPC_AUTH_TOKEN` | (empty) | Shared secret. If set, all connections must provide this token. |
| `IPC_CHANNEL_URL` | — | HTTP endpoint for the Channel Server to POST incoming messages to |
| `OPENCLAW_URL` | `http://127.0.0.1:18789` | OpenClaw Gateway base URL. Hub uses this to call `POST /hooks/wake` for real-time message delivery to OpenClaw's main session. |
| `OPENCLAW_TOKEN` | — | Bearer auth token for the OpenClaw Gateway. Sent as `Authorization: Bearer <token>` in `/hooks/wake` requests. |

---

## HTTP API

Hub 在与 WebSocket 相同的端口上暴露了一套极简 HTTP API，任意工具——Codex、Shell 脚本、CI 流水线——都可以在无 WebSocket 连接的情况下发送消息。

The hub exposes a minimal HTTP API on the same port as WebSocket. This lets any tool — Codex, shell scripts, CI pipelines — send messages without a WebSocket connection.

### `POST /send`

从任意 HTTP 客户端发送消息。
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

**Response (recipient online):**

```json
{ "ok": true, "id": "msg-abc123", "delivered": true }
```

**Response (recipient offline — message buffered):**

```json
{ "ok": true, "id": "msg-abc123", "delivered": false, "buffered": true }
```

**curl 示例 / Example with curl:**

```bash
curl -s -X POST http://localhost:3179/send \
  -H "Content-Type: application/json" \
  -d '{"from":"ci","to":"main","content":"tests passed"}'
```

带认证 token / With auth token:

```bash
curl -s -X POST http://localhost:3179/send \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-shared-secret" \
  -d '{"from":"ci","to":"main","content":"tests passed"}'
```

### `GET /health`

返回 Hub 状态和所有连接的 session。
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

仅返回 sessions 数组。
Returns the sessions array only.

```json
[
  { "name": "main", "connectedAt": 1711400000000, "topics": [] }
]
```

---

## Claude Code 集成细节 / Claude Code Integration

Claude Code 通过 `.mcp.json` 加载 MCP server。接收到的消息以 `<channel>` 通知推送，无需轮询即可唤醒空闲的 Claude Code 会话。流程：

Claude Code loads the MCP server via `.mcp.json`. Incoming messages are pushed as `<channel>` notifications, which wake idle Claude Code sessions without requiring a poll loop. The flow:

1. 发送方调用 `ipc_send(to="target-session", content="...")` / Sender calls `ipc_send(to="target-session", content="...")`
2. Hub 若目标在线则走 WebSocket 路由，离线则缓冲 / Hub routes over WebSocket if target is online; buffers if offline
3. `channel-server.mjs`（若运行）将消息 POST 到 Claude Code Channel 端点 / `channel-server.mjs` (if running) POSTs the message to the Claude Code Channel endpoint
4. Claude Code 接收 `<channel>` 通知并处理 / Claude Code receives a `<channel>` notification and processes it

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

## 飞书集成细节 / Feishu Integration

飞书集成分为两个独立部分：**feishu-bridge**（接收）和 **Hub**（发送）。bridge 是独立进程，避免了 Lark SDK WSClient 在同进程多实例时的全局状态冲突。

Feishu integration is split into two independent parts: **feishu-bridge** (receiving) and **Hub** (sending). The bridge runs as a standalone process, avoiding Lark SDK WSClient global state conflicts when multiple instances run in the same process.

多应用通过 `feishu-apps.json` 配置（已 gitignore，含密钥）。项目提供 `feishu-apps.example.json` 作为模板。

Multi-app support via `feishu-apps.json` (gitignored, contains secrets). `feishu-apps.example.json` is provided as a template.

**每个应用配置包含 / Each app entry contains:**

| 字段 / Field | 说明 / Description |
|---|---|
| `name` | 应用显示名称 / App display name |
| `appId` | 飞书应用 ID / Feishu App ID |
| `appSecret` | 飞书应用密钥 / Feishu App Secret |
| `targetOpenId` | 默认消息接收人 / Default message recipient |
| `receive` | 接收方式：Lark SDK WSClient / Receive via Lark SDK WSClient |
| `send` | 发送方式：Feishu Bot API / Send via Feishu Bot API |
| `routeTo` | 目标 IPC session 名称 / Target IPC session name |

**入站 / Inbound（feishu-bridge 独立进程）:**

feishu-bridge 读取 `feishu-apps.json`，为每个应用启动 Lark SDK WSClient 长连接。收到飞书消息后通过 HTTP `POST /send` 转发给 Hub，全程 0 LLM tokens。bridge 在独立进程中运行，彻底解决了 WSClient 全局状态冲突问题。支持回复/引用消息（自动获取 parent_id 原文）。

The feishu-bridge reads `feishu-apps.json` and starts a Lark SDK WSClient for each app. Incoming Feishu messages are forwarded to Hub via HTTP `POST /send` — 0 LLM tokens. Running in a separate process eliminates WSClient global state conflicts entirely. Supports reply/quote messages (fetches parent_id content automatically).

**内置 ping / Built-in ping:** 飞书发 "ping" 给机器人，bridge 直接回复 "pong"，不经过 Hub 或 LLM，用于快速验证链路。

Send "ping" to the bot in Feishu, bridge replies "pong" directly without Hub or LLM — useful for quick link testing.

**出站 / Outbound（Hub 内）:** 通过 `POST /feishu-reply` 端点回复飞书，或在 IPC 中使用 `ipc_send(to="feishu:app-name")`。Hub 通过 Bot API 发送。

Outbound (inside Hub): Reply to Feishu via `POST /feishu-reply` endpoint, or use `ipc_send(to="feishu:app-name")` from any IPC session. Hub sends via Bot API.

**自动回复 / Auto-reply:** Stop hook（`bin/feishu-auto-reply.cjs`）在 Claude Code 响应结束时捕获 `last_assistant_message`，自动 POST 到 Hub 的 `/feishu-reply`，实现飞书消息的全自动回复，无需 tool call。

Auto-reply: The Stop hook (`bin/feishu-auto-reply.cjs`) captures `last_assistant_message` when Claude Code finishes responding, and automatically POSTs it to Hub's `/feishu-reply`. Fully automatic Feishu replies with no tool call needed.

---

## 跨 AI 支持 / Cross-AI Support

建木并非 Claude 专属。任何能发 HTTP 请求或打开 WebSocket 的工具都可以接入：

Jianmu is not Claude-specific. Any tool that can send HTTP requests or open a WebSocket can participate:

| AI Tool | Integration Method |
|---|---|
| Claude Code | MCP Server (`mcp-server.mjs`) via `.mcp.json` |
| OpenClaw | MCP Server via `openclaw.json` + OpenClaw adapter |
| OpenAI Codex | HTTP API (`POST /send`) |
| Custom scripts | HTTP API or raw WebSocket |
| Feishu Bots | feishu-bridge (WSClient receiving) + Hub Bot API (sending) |
| Channel Server | `channel-server.mjs` — standalone receiver that POSTs to a webhook |

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

- **仅内存 / In-memory only**: Hub 不持久化消息到磁盘。Hub 进程重启后，缓冲的离线消息会丢失。/ The hub does not persist messages to disk. If the hub process restarts, buffered offline messages are lost.
- **无结构化 agent 生命周期 / No structured agent lifecycle**: OpenClaw 有更丰富的 agent 编排原语。建木只处理原始消息路由，不管理 agent 状态、重试策略或任务队列。/ OpenClaw has richer agent orchestration primitives. Jianmu handles raw message routing — it does not manage agent state, retry policies, or task queues.
- **基础认证 / Basic auth**: 认证方式为共享 token（`IPC_AUTH_TOKEN`），不提供 per-session 身份验证或 ACL。/ Authentication is a shared token (`IPC_AUTH_TOKEN`). There is no per-session identity verification or ACL.
- **单 Hub / Single hub**: 不支持多 Hub 联邦。所有 session 必须连接到同一 Hub 实例。跨机器部署需要反向代理或隧道。/ No multi-hub federation. All sessions must connect to the same hub instance. Cross-machine setups require a reverse proxy or tunnel.
- **OpenClaw `.env` 配置 / OpenClaw `.env` configuration**: OpenClaw adapter 需要 `OPENCLAW_URL` 和 `OPENCLAW_TOKEN` 才能工作。可以在 `hub.mjs` 同目录放置 `.env` 文件，也可以设置环境变量。/ The OpenClaw adapter requires `OPENCLAW_URL` and `OPENCLAW_TOKEN` to function. Place a `.env` file in the same directory as `hub.mjs`, or set them as environment variables.
- **飞书自动回复仅限 Claude Code / Feishu auto-reply is Claude Code only**: Stop hook（`bin/feishu-auto-reply.cjs`）依赖 Claude Code 的 hook 机制，不适用于 OpenClaw 或其他工具。/ The Stop hook (`bin/feishu-auto-reply.cjs`) relies on Claude Code's hook mechanism and does not work with OpenClaw or other tools.

---

## 项目结构 / Project Structure

```
xihe-jianmu-ipc/
├── hub.mjs              # WebSocket hub server (Feishu sending only)
├── mcp-server.mjs       # MCP server (Claude Code + OpenClaw adapter)
├── feishu-bridge.mjs    # Standalone Feishu receiving process
├── feishu-apps.example.json  # Feishu multi-app config template
├── SKILL.md             # OpenClaw ClawHub skill manifest
├── lib/
│   ├── constants.mjs    # Shared constants (ports, timeouts, etc.)
│   ├── protocol.mjs     # Message schema and validation
│   └── feishu-worker.mjs  # Per-app WSClient worker for feishu-bridge
├── bin/
│   ├── jianmu.mjs       # CLI entry point
│   ├── feishu-auto-reply.cjs  # Stop hook: auto-reply to Feishu
│   ├── feishu-reply.sh  # Shell shortcut for Feishu reply
│   ├── install.ps1      # PowerShell profile installer
│   ├── ipc-claude.ps1   # PowerShell helper for Claude Code sessions
│   └── patch-channels.mjs  # Claude Code channel patch helper
└── package.json
```

---

## 关于曦和 AI / About Xihe AI

曦和（Xihe）得名于中国神话中驾驭太阳的女神。[xihe-forge](https://github.com/xihe-forge) 是曦和 AI 的开源锻造炉——我们在这里把实用的 AI 工具从想法锤炼成可以直接上手的开源项目。xihe-jianmu-ipc 是锻造炉中的第三个开源作品。更多面向 AI 协作、搜索和增长的工具正在锻造中，欢迎关注或参与贡献。

Xihe is named after the sun goddess who drives the solar chariot in Chinese mythology. [xihe-forge](https://github.com/xihe-forge) is Xihe AI's open-source forge — where we hammer practical AI tools from ideas into ready-to-use open-source projects. xihe-jianmu-ipc is the third open-source piece out of the forge. More AI tools for AI collaboration, search, and growth are being forged — follow the org or contribute.

---

## License

MIT — by [xihe-forge](https://github.com/xihe-forge)
