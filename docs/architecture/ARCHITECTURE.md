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

### hub.mjs — 中枢进程

WebSocket服务器 + HTTP API，监听 `:3179`。

职责：
- **Session注册表**：维护 `name → WebSocket连接` 的映射，支持重名时踢旧连上新
- **离线收件箱**：目标session离线时缓存消息，连接恢复后批量投递
- **Topic pub/sub**：`ipc_subscribe` 注册主题，Hub做fanout广播
- **心跳管理**：30秒ping/pong，60秒无响应断开
- **OpenClaw唤醒**：目标session名含 `openclaw-` 前缀时，额外发一次HTTP `/hooks/wake`
- **飞书出站**：收到飞书目标消息时调用Feishu Bot API发送

### mcp-server.mjs — MCP服务端

由 Claude Code 或 OpenClaw 通过 stdio 加载，作为MCP工具提供者运行。

- 通过 `@modelcontextprotocol/sdk` 实现 JSON-RPC over stdio
- 启动时连接Hub WebSocket，Hub不存在时自动启动（autostart）
- 收到Hub推送的消息后，通过 Channel capability 以 `<channel>` 通知形式注入Claude Code上下文
- 提供7个MCP工具：`ipc_send` / `ipc_sessions` / `ipc_whoami` / `ipc_subscribe` / `ipc_spawn` / `ipc_rename` / `ipc_task`

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
| `messages` | 所有消息记录，含sender/receiver/topic/content/timestamp |
| `tasks` | 结构化任务，含status/priority/deadline/payload |

- 7天TTL：Hub启动时及每小时定期清理过期记录
- offline inbox：消息投递失败时写入messages表并标记 `buffered=true`，session重连时查询并投递
- 查询接口：`GET /messages`（消息历史）、`GET /stats`（per-agent统计）、`GET /tasks`（任务列表）

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
