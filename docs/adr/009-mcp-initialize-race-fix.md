# ADR-009: MCP initialize race 修复

**日期**：2026-04-24
**状态**：DONE（notification queue + `oninitialized` flush 已落地）

## 背景

2026-04-24 taiwei / pc-pet 对比暴露出新 session 冷启窗口内的 push channel notification 丢失问题：

- taiwei 启动时 Hub inbox 已有 17:09、17:19 两条积压消息，17:53 又收到新消息；这些消息在 MCP client 完成 initialize 前被 Hub flush 到 `mcp-server.mjs`。
- pc-pet 启动时 Hub inbox 为空，初次收到消息时 MCP initialize 已完成，因此没有复现。
- `ipc_whoami` / `ipc_sessions` 等 tool call 正常，因为它们是 client 主动发起的 request-response，不依赖 client 侧预先注册 notification handler。
- `ipc_recent_messages` pull 正常，因为它走 Hub HTTP / SQLite 历史路径，不走 MCP notification push。

## 根因

`mcp-server.mjs` 原启动顺序是：

1. `new StdioServerTransport()`
2. `await server.connect(transport)`
3. 后台连接 Hub WebSocket
4. Hub register 后 flush inbox
5. `pushChannelNotification()` 调 `server.notification()`
6. Claude Code 之后才可能发送 `initialize` 和 `notifications/initialized`

MCP SDK `@modelcontextprotocol/sdk/dist/esm/shared/protocol.js` 中 `connect()` 在 L215-L247 只完成 transport 挂载和 `transport.start()`，不等待 client initialize。客户端 notification 分发在 L273-L277 对未订阅/未注册 handler 的 notification 执行 ignore，因此 initialize 前发出的 `notifications/claude/channel` 会被静默丢弃。

MCP SDK `@modelcontextprotocol/sdk/dist/esm/server/index.js` L53 暴露 `server.oninitialized`，由 `notifications/initialized` 触发，可作为 client initialize handshake 已完成的信号。

## 决策

在 MCP server 侧引入 channel notification queue：

- initialize 完成前，`pushChannelNotification()` 只构造 payload 并追加到内存队列。
- `server.oninitialized` 触发后，标记 `mcpInitialized=true` 并按 FIFO 顺序 flush 队列。
- initialize 完成后，后续 channel notification 立即调用 `server.notification()`。
- Hub 侧 delivered / inbox 语义本次不改，避免混入另一条改造线。

## 设计

核心逻辑抽到 `lib/channel-notification.mjs`，通过工厂隔离 MCP SDK 顶层副作用：

```js
createChannelNotifier({ serverNotify, stderr, now })
```

工厂返回：

- `pushChannelNotification(msg)`：构造 `{ method: 'notifications/claude/channel', params: { content, meta } }`，按状态决定 queue 或 send。
- `markInitialized()`：状态机从 pre-init 进入 initialized，并 flush `pendingChannelPayloads`。
- `_state`：仅用于测试观察 `mcpInitialized` 和 `pendingChannelPayloads`。

状态机：

| 状态 | 事件 | 行为 | 下个状态 |
|------|------|------|----------|
| pre-init | channel message | append queue，不调用 `server.notification()` | pre-init |
| pre-init | `markInitialized()` | FIFO flush queue | initialized |
| initialized | channel message | 立即 `server.notification()` | initialized |

`mcp-server.mjs` 只负责注入依赖：

- `serverNotify: (payload) => server.notification(payload)`
- `stderr: (message) => process.stderr.write(message)`
- `now: () => new Date()`
- `server.oninitialized = () => channelNotifier.markInitialized()`

## 威胁模型

队列暂不设置硬上限，理由：

- 风险窗口只覆盖 MCP transport ready 到 client `notifications/initialized` 的短时间，实际生产高负载预计积压少于 10 条。
- payload 只包含文本 content 与少量 meta，短窗口内内存压力可接受。
- 若未来出现异常 client 永不 initialized，队列可能增长；可在后续 ADR 中增加上限、超时丢弃或落盘。
- 当前修复优先保证不丢冷启 push，避免过早引入复杂策略改变 delivery 语义。

本修复不改变 Hub 鉴权、不新增 HTTP/WS 攻击面，也不改变 delivered 标记策略。

## 后果

**正面**：

- 新 session 冷启时 Hub inbox flush 不再因 MCP initialize race 静默丢失。
- `server.notification()` 调用点集中到 notifier factory 注入处，后续审计更清晰。
- 核心逻辑脱离 `mcp-server.mjs` 顶层启动副作用，可用 `node:test` 直接覆盖。

**负面**：

- 增加一份内存队列状态，冷启日志会多出 queued / flushing 记录。
- pre-init 队列为 unbounded，极端异常 client 可能积压内存。

**风险**：

- 如果 client 从不发送 `notifications/initialized`，push 会持续停留在队列中；这是比静默丢弃更可观测的失败模式。
- 如果 MCP SDK 未来改变 initialized 信号，需要重新校验 `server.oninitialized` 触发时机。

## 相关

- `feedback_ipc_push_vs_hub_delivered.md`：push notification 与 Hub delivered 语义对比反馈。
- `docs/adr/008-ipc-reclaim-my-name.md`：同属 session cold-start 自愈链路。
- `session-cold-start.md` v1.5：冷启规范中关于新 session 接收积压消息的预期。
- `mcp-server.mjs`：MCP transport 启动、Hub WS 连接、channel notification 委托。
- `tests/channel-init-race.test.mjs`：pre-init queue、initialized flush、post-init send、payload shape 回归测试。
