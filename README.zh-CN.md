[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[English](README.md) | [中文](README.zh-CN.md)

# xihe-jianmu-ipc

多 AI 会话实时通信中枢，集成 WebSocket 消息路由、MCP、Channel 推送唤醒、飞书 AI 控制台、SQLite 持久化与结构化任务协议。

由 [Xihe AI](https://github.com/xihe-forge) 锻造，面向所有需要跨 AI 会话协同的开发者。

---

## 项目简介

`xihe-jianmu-ipc` 是一个面向多 Agent 协作场景的通信 Hub。它把跨会话消息传递从 LLM 上下文中剥离出来，让消息通过 WebSocket / HTTP 直接送达目标 session，避免每次转发都重建整段对话上下文。

适用场景包括：

- Claude Code 与 Claude Code 多会话协作
- Claude Code 与 OpenClaw 双向通信
- AI Agent 与脚本、CI、飞书机器人之间的联动
- 需要结构化任务分发、消息留存和在线状态监控的团队

---

## 命名由来

项目遵循曦和三段式命名规范 `xihe-{隐喻}-{功能}`：

- `xihe`：品牌，源自中国神话中的太阳女神曦和
- `jianmu`：隐喻，建木是神话中沟通天地的通天神树，象征多个 AI 会话之间的无声连通
- `ipc`：功能，即进程间实时通信

---

## 为什么存在

多 Agent 协作如果依赖 LLM 充当路由器，每次跨 session 通信都会触发一次完整 agent run，并重复加载上下文，随着对话增长会造成显著的 token 浪费。

建木的核心思路是：让“哑管道”负责路由，而不是让 LLM 负责路由。消息经由 Hub 直接转发给目标 session，LLM 只看到最终收到的消息，看不到整段中转历史，因此单条消息的 token 成本与对话长度解耦。

---

## 快速开始

### Claude Code

1. 安装：

```bash
npm install -g xihe-jianmu-ipc
```

或从仓库运行：

```bash
git clone https://github.com/xihe-forge/xihe-jianmu-ipc
cd xihe-jianmu-ipc
npm install
```

2. 在项目 `.mcp.json` 中添加：

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

3. 第一个 MCP 会话连接时，Hub 默认自动启动；也可以手动运行：

```bash
node hub.mjs
```

4. 建议同时启动 `network-watchdog`，自动探测 CliProxy / Hub / Anthropic / DNS：

```bash
npm run watchdog
# 或 node bin/network-watchdog.mjs

# 健康检查
curl http://127.0.0.1:3180/status
```

Windows 上也可以注册 watchdog 守护任务：

```powershell
npm run daemon:watchdog:install
npm run daemon:watchdog:uninstall
```

5. 在任意连接的 session 中发送消息：

```text
ipc_send(to="worker", content="Start processing task A")
```

### OpenClaw

1. 安装包：

```bash
npm install xihe-jianmu-ipc
```

2. 若手动启动 Hub，则复制 `.env.example` 为 `.env` 并填写 `OPENCLAW_TOKEN`。

3. 在 `openclaw.json` 中注册 `mcp-server.mjs`，并配置 `IPC_NAME`、`OPENCLAW_URL`、`OPENCLAW_TOKEN` 等环境变量。

### Windows Hub 守护进程（推荐）

让 Hub 开机自启 + 挂了自动恢复，无需手动拉起。守护机制：Windows 任务计划 `AtLogOn` + 每 10 分钟重复触发 + VBS 内部每 5 分钟健康探测（curl `/health`），假活时精确 kill 该 PID 并拉起新进程。

```powershell
# 注册守护任务（不需要管理员权限）
powershell -ExecutionPolicy Bypass -File bin\install-daemon.ps1

# 卸载
powershell -ExecutionPolicy Bypass -File bin\uninstall-daemon.ps1

# 验证自愈能力（会 kill Hub PID 测试恢复）
powershell -ExecutionPolicy Bypass -File bin\verify-daemons.ps1 -Service Hub
```

---

## 架构

核心组件如下：

- `hub.mjs`：Hub 主进程，提供 WebSocket 服务与 HTTP API
- `bin/network-watchdog.mjs`：独立 watchdog 进程，负责 4 路探测、`POST /internal/network-event` 和 `GET /status`
- `mcp-server.mjs`：MCP 接入层，供 Claude Code、OpenClaw 等工具使用
- `lib/db.mjs`：SQLite 持久化，保存消息历史、任务状态与统计数据
- `dashboard/`：监控面板，查看 session、消息流和任务状态
- `feishu-bridge.mjs`：飞书接收桥接进程，负责 AI 控制台与消息转发

简化后的通信路径：

```text
AI Session -> MCP Server -> Hub
network-watchdog -> POST /internal/network-event -> Hub
Daemon -> GET http://127.0.0.1:3180/status -> network-watchdog
Hub -> WebSocket / HTTP -> Target Session
Hub -> SQLite -> Message / Task History
Hub <-> Feishu Bridge / Dashboard / OpenClaw Adapter
```

---

## HTTP API

- `POST /send`：`{from, to, content}` 发送消息，返回 `{accepted, id, online, buffered}`；若 target 不存在，sender 会收到 `unknown-target` 警告
- `POST /prepare-rebind`：`{name, ttl_seconds?, topics?, next_session_hint?}` 显式会话接力。在线 session 下线前先调用，Hub 会预写 `pending_rebind`，默认宽限期 5 秒，继任者同名连入后继承 topics 并收到 `inbox + buffered_messages`
- `POST /suspend`：`{from, reason?, task_description?, suspended_by?}` 记录挂起 session，返回 `{ok, name, suspended_at, suspended_by}`
- `POST /wake-suspended`：`{reason?, from?}` 临时运维 endpoint，通过 topic fanout 向所有订阅 `network-up` 的 session 广播手动唤醒消息，返回 `{ok, broadcastTo, subscribers, clearedSessions}`
- `POST /internal/network-event`：内部端点，仅 `127.0.0.1` + `X-Internal-Token` 可访问，接收 `network-down` / `network-up`
- `POST /task`：`{from, to, title, ...}` 创建结构化任务，返回 `{ok, taskId, online, buffered}`
- `GET /recent-messages?name=&since=&limit=`：查询发给某个 session（含广播）的近期持久化消息，默认 6h / 50 条，适合崩溃重连补回 backlog
- `GET /health`：返回 Hub 状态、session 列表与消息计数

## 会话接力（release-rebind）

建木现在有两种同名接力机制：

- 显式交接（`release-rebind`）：旧 session 在主动下线前先 `POST /prepare-rebind`，Hub 写入 `pending_rebind`。5 秒宽限期内发给该 name 的点对点消息会进入 `buffered_messages`。新 session 以同名连入后会静默继承 topics，并一次性收到 `SQLite inbox + buffered_messages`。
- 隐式接管（`?force=1` / zombie rebind）：旧 session 崩溃、卡死或没来得及宣告时，新连接可强制接管或等待僵尸检测。这个路径只回放现有 `inbox + recent persisted messages`，**不会恢复旧 topics**。

## MCP 工具

- `ipc_send(to, content, topic?)`：向指定 session 或 `*` 广播发送消息
- `ipc_sessions()`：查看当前在线 session
- `ipc_whoami()`：查看当前 session 名称、Hub 地址和连接状态
- `ipc_subscribe(topic, action)`：订阅 / 退订 topic
- `ipc_spawn(name, task, interactive?, model?)`：拉起新的 Claude Code session
- `ipc_rename(name)`：重命名当前 session
- `ipc_reconnect(host?, port?)`：切换 Hub 地址并重连
- `ipc_task(action, ...)`：结构化任务 create / update / list
- `ipc_recent_messages(name?, since?, limit?)`：拉取当前或指定 session 的近期持久化 backlog（默认 6h / 50 条）

---

## 关于曦和 AI

曦和（Xihe）得名于中国神话中驾驭太阳的女神。[xihe-forge](https://github.com/xihe-forge) 是曦和 AI 的开源锻造炉——我们在这里把实用的 AI 工具从想法锤炼成可以直接上手的开源项目。`xihe-jianmu-ipc` 是锻造炉中的第三个开源作品，也是我们多 AI 协作基础设施方向的重要一环。

### 项目矩阵

| 项目 | 简介 |
|---|---|
| `xihe-jizhu-scaffold` | AI 项目脚手架 |
| `xihe-jianmu-ipc` | 多 AI 通信 Hub（本项目） |
| `xihe-core` | 核心库 |
| `lumidrive-site` | 光影随行官网 |
| `xihe-rinian-seo` | SEO 工具 |
| `heartreadAI` | AI 心理健康产品 |
| `xihe-jinwu-epet` | 桌面宠物 |
| `xihe-taiwei-bridge` | 多 Agent 协作平台 |

### 网站链接

- 组织主页：https://github.com/xihe-forge
- 光影随行官网：https://lumidrivetech.com
- HeartRead 官网：https://heartread.ai

更多面向 AI 协作、搜索、增长与数字体验的产品仍在持续锻造中，欢迎关注组织、试用产品或参与贡献。

---

## License

MIT — by [xihe-forge](https://github.com/xihe-forge)
