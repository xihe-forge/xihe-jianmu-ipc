# xihe-jianmu-ipc

多AI会话实时通信Hub。WebSocket消息路由 + MCP集成 + Channel推送。

## 项目结构

```
hub.mjs              — WebSocket hub (localhost:3179)
mcp-server.mjs       — MCP server (Claude Code / OpenClaw 通过stdio加载)
lib/constants.mjs    — 端口、超时常量
lib/protocol.mjs     — 消息格式、校验
lib/db.mjs           — SQLite消息持久化（better-sqlite3）
lib/feishu-worker-thread.mjs — 飞书WSClient worker_thread（每app独立线程，避免Lark SDK全局状态冲突）
lib/command-parser.mjs — 飞书命令解析器（7种指令：状态/帮助/派发/广播/重启/历史/日报）
lib/agent-status.mjs — Agent在线状态追踪（15秒轮询Hub，上下线变更通知）
lib/console-cards.mjs — 飞书控制台卡片模板（7种：状态看板/帮助/派发/广播/审批/日报/错误）
bin/jianmu.mjs       — CLI (jianmu hub / jianmu status)
bin/install.ps1      — PowerShell alias安装
bin/patch-channels.mjs — Claude Code Channel弹窗补丁
bin/feishu-reply.sh  — 飞书快捷回复脚本（读stdin或参数，POST到Hub）
feishu-bridge.mjs    — 飞书多app编排器（worker_thread管理 + 热重载 + Hub转发）
feishu-apps.json     — 飞书多应用配置（含密钥，已gitignore，修改后自动热重载）
feishu-apps.example.json — 飞书配置模板
docs/feishu-permissions.json — 飞书应用权限模板（开发者后台批量导入）
docs/feishu-events.md   — 飞书事件订阅配置说明
SKILL.md             — OpenClaw ClawHub skill清单
```

## MCP Tools

- `ipc_send(to, content, topic?)` — 发消息/广播
- `ipc_sessions()` — 在线session列表
- `ipc_whoami()` — 当前session身份
- `ipc_subscribe(topic, action)` — 订阅/退订topic
- `ipc_spawn(name, task, interactive?, model?)` — 启动新session
- `ipc_rename(name)` — 重命名当前session
- `ipc_task(action, ...)` — 结构化任务管理（create/update/list）

## HTTP API

- `POST /send` — `{from, to, content}` 发消息，返回 `{ok, id, online, buffered}`
- `POST /feishu-reply` — `{app, content, from?}` 直接回复飞书，跳过IPC路由，返回 `{ok, app}`
- `GET /health` — Hub状态 + session列表 + messageCount
- `GET /sessions` — 仅session列表
- `GET /messages?peer=&from=&to=&limit=` — 查询持久化消息历史
- `GET /stats?hours=N` — per-agent消息统计（默认24小时）
- `POST /task` — `{from, to, title, description?, priority?, deadline?, payload?}` 创建结构化任务，返回 `{ok, taskId, online, buffered}`
- `GET /tasks?agent=&status=&limit=` — 任务列表+统计
- `GET /tasks/:id` — 单个任务详情
- `PATCH /tasks/:id` — `{status}` 更新任务状态（pending/started/completed/failed/cancelled）

## 飞书AI控制台

P2P对话及群聊@机器人时支持以下命令（bridge拦截处理，不转发Hub）：

| 命令 | 说明 |
|------|------|
| `状态` / `status` | 查看所有Agent在线状态（卡片） |
| `帮助` / `help` | 显示命令列表 |
| `让{agent}去{task}` | 派发结构化任务给指定Agent（创建 `/task`，非普通消息） |
| `广播:{content}` | 向所有在线Agent广播 |
| `重启 {target}` | 重启bridge/worker |
| `消息记录` / `history` | 查看最近消息 |
| `日报` / `report` | 生成工作报告 |
| `新增机器人` / `/add-bot` | 交互表单添加新飞书应用 |

Agent上下线自动推送飞书通知。状态卡片支持刷新按钮。审批卡片支持确认/拒绝按钮。

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `IPC_NAME` | `session-<pid>` | session名称 |
| `IPC_DEFAULT_NAME` | — | .mcp.json里的默认名，IPC_NAME优先 |
| `IPC_PORT` | `3179` | Hub端口 |
| `IPC_HUB_HOST` | 自动检测 | WSL2自动读/etc/resolv.conf |
| `IPC_HUB_AUTOSTART` | `true` | Hub不在时自动启动 |
| `IPC_AUTH_TOKEN` | — | 认证token，不设则不认证 |
| `OPENCLAW_URL` | `http://127.0.0.1:18789` | OpenClaw Gateway地址 |
| `OPENCLAW_TOKEN` | — | OpenClaw API token |
| `IPC_DB_PATH` | `data/messages.db` | SQLite数据库路径 |

飞书配置已从环境变量迁移到 `feishu-apps.json`，支持多应用。见 `feishu-apps.example.json`。

## 开发规范

- Git身份: `Xihe <xihe-ai@lumidrivetech.com>`
- 提交不加AI署名
- 推送到 xihe-forge org
- 纯JS (.mjs)，不用TypeScript
- 依赖: `ws` + `@modelcontextprotocol/sdk` + `better-sqlite3` + `@larksuiteoapi/node-sdk`
