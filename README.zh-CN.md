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

4. 在任意连接的 session 中发送消息：

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

---

## 架构

核心组件如下：

- `hub.mjs`：Hub 主进程，提供 WebSocket 服务与 HTTP API
- `mcp-server.mjs`：MCP 接入层，供 Claude Code、OpenClaw 等工具使用
- `lib/db.mjs`：SQLite 持久化，保存消息历史、任务状态与统计数据
- `dashboard/`：监控面板，查看 session、消息流和任务状态
- `feishu-bridge.mjs`：飞书接收桥接进程，负责 AI 控制台与消息转发

简化后的通信路径：

```text
AI Session -> MCP Server -> Hub
Hub -> WebSocket / HTTP -> Target Session
Hub -> SQLite -> Message / Task History
Hub <-> Feishu Bridge / Dashboard / OpenClaw Adapter
```

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
| `xihe-tiangang-mesh` | 多 Agent 协作平台 |

### 网站链接

- 组织主页：https://github.com/xihe-forge
- 光影随行官网：https://lumidrivetech.com
- HeartRead 官网：https://heartread.ai

更多面向 AI 协作、搜索、增长与数字体验的产品仍在持续锻造中，欢迎关注组织、试用产品或参与贡献。

---

## License

MIT — by [xihe-forge](https://github.com/xihe-forge)
