# 建木IPC 技术架构

## 架构概览

多AI会话实时通信中枢——用哑管道（WebSocket）替代LLM做路由，每条跨session消息的token开销固定约50 tokens，与对话深度无关。

```
┌──────────────────────────────────────────────────────────────────┐
│                        Hub (hub.mjs)                             │
│            WebSocket server + HTTP API on :3179                  │
│  - Session registry (name → ws connection)                       │
│  - Offline inbox + TTL清理                                       │
│  - Topic pub/sub fanout                                          │
│  - Per-session token认证                                         │
│  - 结构化任务协议 (create/update/track)                          │
└──────┬──────────────────┬──────────────────┬─────────────────────┘
       │ ws://:3179       │ http://:3179     │
       │                  │                  │
┌──────▼───────┐  ┌───────▼──────────┐  ┌───▼──────────────────┐
│  MCP Server  │  │  HTTP API        │  │  Dashboard           │
│ (mcp-server  │  │  /send /health   │  │  GET /dashboard/*    │
│  .mjs)       │  │  /sessions       │  │  实时监控面板         │
│              │  │  /messages       │  └──────────────────────┘
│  Claude Code │  │  /stats /task    │
│  & OpenClaw  │  │  /tasks          │
│  via stdio   │  └──────────────────┘
└──────┬───────┘
       │
┌──────▼──────────────────────────────────────────────────────┐
│  Channel推送 (claude/channel capability)                     │
│  将入站消息以 <channel> 通知推送给 Claude Code               │
│  唤醒空闲session，无需轮询                                   │
└─────────────────────────────────────────────────────────────┘
       │
┌──────▼──────────────────────────────────────────────────────┐
│  SQLite持久化 (lib/db.mjs)                                   │
│  WAL模式 · 7天TTL · messages表 + tasks表                     │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  OpenClaw适配器                                              │
│  出站：Hub调用 /hooks/wake（始终HTTP，即使WS已连接）         │
│  入站：OpenClaw通过 openclaw.json 加载 mcp-server.mjs        │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  feishu-bridge（独立进程）                                   │
│  worker_threads隔离多个Lark WSClient                         │
│  AI控制台：8种命令 · Agent状态追踪 · 卡片交互 · 日报        │
│  通过 HTTP POST /send 转发消息到Hub                          │
└─────────────────────────────────────────────────────────────┘
```

---

## 核心组件

### hub.mjs — 启动入口（约300行）

职责纯粹：加载配置、组装 `ctx` 依赖上下文、启动 HTTP/WS server。核心业务逻辑已拆到 `lib/` 下各模块。

### lib/router.mjs — 消息路由核心

导出 `createRouter(ctx)` 工厂函数。纯函数通过闭包+依赖注入，可直接 import 单元测试。

- `routeMessage(msg, sender)` — 点对点/广播/topic fanout，消息去重（msg.id），saveMessage 持久化，ackPending 追踪
- `pushInbox` / `flushInbox` — 离线消息写 SQLite + 重连时合并 SQLite inbox+内存按 ts 升序投递；历史访问走 `ipc_recent_messages` / `/recent-messages` pull
- `scheduleInboxCleanup` — 离线 session TTL 过期清理
- 四条路由路径：直接寻址 / 广播 / topic fanout / 特殊目标（feishu / openclaw）

### lib/http-handlers.mjs — HTTP 端点处理

导出 `createHttpHandler(ctx)`。10 个端点：
- 消息：`POST /send`、`POST /feishu-reply`、`GET /messages`
- 状态：`GET /health`、`GET /sessions`、`GET /stats`
- 任务：`POST /task`、`GET /tasks`、`GET /tasks/:id`、`PATCH /tasks/:id`

### lib/feishu-adapter.mjs — 飞书适配器

`feishu-apps.json` 配置加载 + `statSync` 轮询热重载 + tenant_access_token 缓存。

### lib/openclaw-adapter.mjs — OpenClaw 适配器

`/hooks/wake` HTTP 投递 + 重试队列（5min TTL，15s 扫描）。

### lib/ci-relay.mjs — CI 通知中继

飞书邮箱 API 轮询 GitHub CI 失败通知邮件，解析后通过 `ctx.routeMessage` 转发到对应 AI session（按 `ci-routes.json` 映射）。

### lib/mcp-tools.mjs — MCP 工具实现

导出 `createMcpTools(ctx)` 工厂函数，实现 8 个 IPC 工具的业务逻辑：`ipc_send` / `ipc_sessions` / `ipc_whoami` / `ipc_subscribe` / `ipc_spawn` / `ipc_rename` / `ipc_task` / `ipc_reconnect`。

### mcp-server.mjs — MCP stdio 入口

由 Claude Code 或 OpenClaw 通过 stdio 加载。负责 MCP JSON-RPC 协议 + WS 连接 Hub + 注入 Channel `<channel>` 通知。业务逻辑委托 `lib/mcp-tools.mjs`。

### feishu-bridge.mjs — 飞书消息入站进程

独立进程。为每个启用接收的飞书应用启动 `worker_thread`，运行 `lib/feishu-worker-thread.mjs` 持有独立 Lark SDK WSClient。命令由 `lib/command-parser.mjs` 识别后 bridge 直接处理，普通消息 `POST /send` 转发到 Hub。

### mcp-wrapper.mjs — MCP 自动重启包装

监视 `.mjs` 文件 mtime 变化，检测到改动后重启 `mcp-server.mjs`。使用 `statSync` 轮询规避 WSL2 NTFS `fs.watch` 不可靠问题。

> Hub 本身的文件监控默认关闭（见 ADR-002），改用外部 daemon 守护（见 ADR-004）。

### feishu-bridge.mjs — 飞书编排器

独立进程，不依附于Hub运行。

- 读取 `feishu-apps.json`，为每个启用接收的飞书应用启动一个 `worker_thread`
- 每个worker运行 `lib/feishu-worker-thread.mjs`，独立持有一个 Lark SDK WSClient 长连接
- 监听 `feishu-apps.json` 变更（statSync轮询），热重载：新增/删除/修改app时精确处理，不全量重启
- 收到飞书消息后，先经 `lib/command-parser.mjs` 判断是否为控制台命令，命令由bridge直接处理，普通消息转发至Hub `POST /send`
- 通过 `lib/agent-status.mjs` 每15秒轮询Hub，Agent上下线变更时主动推送飞书通知

### mcp-wrapper.mjs — 自动重启包装器

监视项目目录下 `.mjs` 文件的 `mtime` 变化，检测到改动后重启 `mcp-server.mjs`。
使用 statSync 轮询而非 `fs.watch`——规避 WSL2 在 NTFS 挂载卷上 inotify 不可靠的问题。

---

## 数据流

### MCP工具调用 → 目标session收到消息

```
Claude Code (session A)
  └─ 调用 ipc_send(to="session-B", content="hello")
       └─ mcp-server.mjs 发送 WebSocket 消息到 Hub
            └─ Hub 查找 session-B 的 ws 连接
                 ├─ 在线 → 直接推送 WebSocket 消息
                 │         └─ session-B 的 mcp-server.mjs 收到
                 │               └─ 通过 Channel capability 注入 <channel> 到 Claude Code
                 └─ 离线 → 存入 SQLite offline inbox
                           └─ session-B 上线时批量投递
```

### 飞书消息 → Hub → AI session

```
飞书用户发消息
  └─ Lark SDK WSClient (feishu-worker-thread)
       └─ 上报给 feishu-bridge 主进程
            ├─ 是控制台命令 → bridge直接处理（状态/派发/广播等），回复飞书卡片
            └─ 普通消息 → HTTP POST /send 到 Hub
                          └─ Hub路由到目标session（同上述MCP路径）
```

### OpenClaw唤醒路径

```
Hub收到消息，目标为 openclaw-* session
  ├─ 正常投递到 WebSocket（如果在线）
  └─ 额外发送 HTTP POST /hooks/wake 到 OpenClaw Gateway
     （始终执行，不判断WS是否在线——确保OpenClaw一定被激活）
```

---

## 存储

**SQLite** (`data/messages.db`)，WAL模式开启，提升并发读写性能。

| 表 | 用途 |
|----|------|
| `messages` | 所有已路由消息的归档记录（路由成功或失败都留档） |
| `tasks` | 结构化任务，含 status/priority/deadline/payload |
| `inbox` | offline session 的缓冲消息，重连时 flush 后清空（ADR-003） |

- 7 天 TTL：每小时定期 cleanup，清理 messages/tasks 过期记录 + 5 分钟 TTL 的 inbox 过期项
- **offline inbox 持久化**（ADR-003）：消息目标离线时写 `inbox` 表，session 重连时合并内存+SQLite，按 ts 升序投递并清空两处
- 查询接口：`GET /messages`（消息历史）、`GET /stats`（per-agent 统计）、`GET /tasks`（任务列表）

---

## 安全架构

| 机制 | 实现位置 | 说明 |
|------|----------|------|
| Per-session token认证 | hub.mjs WebSocket握手 + HTTP中间件 | `IPC_AUTH_TOKEN` 环境变量，不设则跳过 |
| WebSocket Origin校验 | hub.mjs `verifyClient` | 拒绝非预期来源的WS连接 |
| sessionName白名单 | lib/protocol.mjs | 名称格式校验，防注入 |
| 敏感信息脱敏 | lib/redact.mjs | 日志输出前过滤token/key等字段 |
| 审计日志 | lib/audit.mjs | 记录关键操作，与业务日志分离 |

---

## 技术决策

**纯JS (.mjs)，不引入TypeScript**
构建零步骤，`node hub.mjs` 直接启动。依赖只有4个：`ws` + `@modelcontextprotocol/sdk` + `better-sqlite3` + `@larksuiteoapi/node-sdk`。

**worker_threads隔离飞书WSClient**
Lark SDK在进程级别维护全局状态，多个 WSClient 实例在同一进程内会互相干扰。每个飞书app跑独立worker_thread，状态完全隔离，崩溃不传染。

**statSync轮询替代fs.watch**
WSL2挂载NTFS时，inotify事件不可靠，`fs.watch` 经常无响应。改用定时 statSync 检查 `mtime`，牺牲少量CPU换取跨平台稳定性。

**OpenClaw唤醒始终走HTTP**
OpenClaw Gateway的 `/hooks/wake` 是激活空闲session的标准路径。即使WS连接已建立，也额外发一次HTTP唤醒——避免Gateway因session静默而提前回收的边界情况。

**setsid脱离终端启动Hub**
Hub autostart时用 `setsid` 创建新进程组，避免父终端关闭时SIGHUP传播杀死Hub。同时处理了stdout/stderr的EPIPE静默，防止detach后写入broken pipe崩溃。

**代码分层 + ctx 依赖注入**（ADR-005）
`hub.mjs` 从 1174 行瘦身到 300 行，核心逻辑拆到 `lib/router.mjs` 和 `lib/http-handlers.mjs` 等工厂函数。依赖通过 `ctx` 对象注入，路由函数可直接 import 单元测试（支撑 Stryker 突变测试）。

**文件监控默认关闭**（ADR-002）
Hub 源文件 mtime 轮询的 auto-restart 仅 `IPC_DEV_WATCH=1` 时启用。生产环境不会因代码提交触发 Hub 自杀。进程级守护由外部 daemon 负责（见 ADR-004）。

**本地服务 daemon 守护**（ADR-004）
Hub 和 CLIProxyAPI 都配独立的 `*-daemon.vbs` + Windows 任务计划。每 5 分钟 `curl` 功能端点验活，假活时精确 kill PID 拉起新进程。拉起失败 5 次 IPC 告警。
