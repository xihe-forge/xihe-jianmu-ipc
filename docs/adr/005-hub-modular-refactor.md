# ADR-005: Hub 代码分层重构（hub.mjs 1174 → 300 行）

**日期**：2026-04-15
**状态**：已生效（commit 8f159cf）

## 背景

`hub.mjs` 原 1174 行，单文件包含：
- HTTP handler（10 个端点，约 400 行）
- WebSocket handler（200 行）
- 核心路由 `routeMessage`（170 行）
- 辅助函数（`send`/`broadcast`/`pushInbox`/`flushInbox`）
- 飞书集成（token 缓存、Bot API 调用）
- OpenClaw 集成（`/hooks/wake` 投递、重试队列）
- 进程管理（idle/heartbeat/cleanup/auto-restart）

耦合严重，`routeMessage` 无法单独 import 测试。

## 决策

拆成 5 个职责模块 + 工厂函数 + ctx 依赖注入：

- `hub.mjs`（300 行）：启动入口
- `lib/router.mjs`（292 行）：`createRouter(ctx)` 返回路由函数
- `lib/http-handlers.mjs`（432 行）：`createHttpHandler(ctx)` 返回请求处理器
- `lib/feishu-adapter.mjs`（81 行）：飞书配置加载、热重载、token 缓存
- `lib/openclaw-adapter.mjs`（88 行）：`/hooks/wake` 投递 + 重试队列

`ctx` 对象在 `hub.mjs` 组装，传给 `createRouter` 和 `createHttpHandler`：

```js
const ctx = {
  sessions, deliveredMessageIds, ackPending,
  feishuApps, getFeishuToken,
  isOpenClawSession, deliverToOpenClaw, enqueueOpenClawRetry,
  stderr, audit, saveMessage,
  saveInboxMessage, getInboxMessages, clearInbox,
};
```

## 后果

**正面**：
- `routeMessage` 可直接 `import` 测试（不需启动 server）
- 39 个 router 单元测试，Stryker mutation score 88-99% 区间
- Feishu/OpenClaw 适配器单独可替换
- 从 D 级代码质量升到 B 级（harness 审）

**负面**：
- 跨模块调用多一层 ctx 解构，轻微开销（可忽略）
- `hub.mjs` 里 WS connection handler 仍保留（耦合 sessions Map 和 ws 对象，拆出去成本高于收益）

## 相关

- ADR-003: Offline inbox SQLite 持久化（pushInbox/flushInbox 通过 ctx 注入 db API）
- 测试文件：
  - `tests/router.test.mjs`（121 个单元）
  - `tests/integration/router-with-db.test.mjs`（30 个集成）
  - `tests/integration/hub-api.test.mjs`（8 个 HTTP）
  - `tests/e2e/websocket.test.mjs`（10 个 E2E）
