# ADR-007: network-watchdog 独立进程 + IPC 广播全局容错

**日期**：2026-04-18
**状态**：设计中（待 v0.4.0 实现）

## 背景

2026-04-18 天枢沉淀 `network-resilience.md` 规范（§4）：外部依赖（Anthropic API / DNS / CPA）异常时，各 AI session 独自重试没意义且烧钱。需要**中心化探测 + 一键挂起/恢复**机制，让所有在线 session 同步行为。

临时过渡（0.3.0 已发）：`POST /wake-suspended` endpoint 手工触发 `network-up` 广播。但缺自动探测，靠 harness 人肉判断网络状态，无法长时间无人值守。

## 决策

v0.4.0 引入独立进程 `network-watchdog`，每 30 秒探测 4 项外部依赖，**状态机驱动** `network-down` / `network-up` IPC 广播。

### 架构选择

**不侵入 hub.mjs**，新建独立 Node 进程 `bin/network-watchdog.mjs`。理由：

1. Hub 职责是消息路由，不是监控。塞进去违反单一职责（参考 ADR-005 分层原则）
2. Hub 自己挂了需要被探测，探测器和被测对象同进程 = 左脚踩右脚
3. 独立进程可以和 `hub-daemon.vbs` / `cliproxy-daemon.vbs` 平级守护，Windows Task Scheduler 复用 ADR-004 模式

### 状态机

```
OK ──任1项异常──> degraded ──任1项连续3次 或 ≥2项异常──> down
↑                                                              │
└──────────────── 所有项恢复（连续3次 OK）────────────────────┘
```

**转移事件**：
- `OK → down`（跳过 degraded，强烈信号）：`network-down` 广播
- `OK → degraded`：不广播，只日志（避免抖动）
- `degraded → down`：`network-down` 广播
- `down → OK`：`network-up` 广播 + 当前挂起 session 列表

### 探测表

| 服务 | 探测 | 超时 | 阈值 |
|------|------|------|------|
| CliProxy | `POST http://127.0.0.1:8317/v1/responses` 极简 body | 5s | 连续 3 次 5xx/timeout/connect-refused |
| Hub | `GET http://127.0.0.1:3179/health` | 2s | 连续 3 次 |
| Anthropic | `GET https://api.anthropic.com/v1/messages`（不需鉴权，返 401 视为 OK） | 10s | 连续 3 次 5xx/timeout |
| DNS | `dns.resolve('github.com')` Node 原生 | 3s | 连续 3 次失败 |

**极简 payload**：CPA 探测用空模型名 / 空 messages，目的是验证 CPA 到上游链路，**不走真实 LLM 调用**（避免烧 token）。

### IPC 广播格式

通过 Hub HTTP `POST /send` 走 topic fanout（复用 0.3.0 的 `broadcastToTopic` helper）：

```json
// network-down
{
  "type": "network-down",
  "triggeredBy": "watchdog",
  "failing": ["cliproxy", "anthropic"],  // 数组
  "since": 1776516000000,  // 首次探测异常时间戳
  "ts": 1776516090000
}

// network-up
{
  "type": "network-up",
  "triggeredBy": "watchdog",
  "recoveredAfter": 600000,  // ms
  "suspendedSessions": ["houtu_builder", "taiwei_builder"],  // 来自 /suspended 表
  "ts": 1776516690000
}
```

### 挂起 session 注册

新增 `POST /suspend`（Hub 端）：session 网络异常时主动上报。存 SQLite `suspended_sessions` 表：

```sql
CREATE TABLE IF NOT EXISTS suspended_sessions (
  name TEXT PRIMARY KEY,
  reason TEXT,
  task_description TEXT,
  suspended_at INTEGER NOT NULL
);
```

`down → OK` 广播时从此表取列表。session 收到 `network-up` 后恢复任务，Hub 清除该条。

### 守护方式

复用 ADR-004 三件套：
- `bin/network-watchdog-daemon.vbs`：5 分钟健康探测（watchdog 自己的 /status 端点）
- `bin/install-network-watchdog-daemon.ps1`：Task Scheduler 注册
- 探测失败 5 次 → Hub IPC 告警给 harness

Watchdog 进程绑定 `localhost:3180`（Hub+1）提供内部状态查询：`GET /status` 返 `{state, failing, lastChecks, uptime}`。

## 关键原则

1. **假阳性容忍**：连续 3 次才算异常（阈值足够大，避免网络抖动误杀）
2. **探测不烧钱**：Anthropic API 探测用无鉴权端点，期望 401；CPA 用空 payload，上游不消耗 token
3. **状态广播幂等**：同一状态不重复广播（`down → down` 不发）
4. **嵌套依赖处理**：watchdog 依赖 Hub 发广播，如果 Hub 自己挂了 → watchdog 直接 IPC stderr 日志 + Windows Event Log，等 hub-daemon 拉起 Hub 再广播
5. **降级：Hub down 单独处理**：探测表中 Hub 挂了走特殊分支——Hub 没起来就没法广播，只能日志记录 + 等 hub-daemon 恢复
6. **探测并行**：4 个探测 Promise.allSettled，不相互阻塞；每轮总耗时 ≤ 最慢一项超时（~10s）

## 后果

**正面**：
- 全 AI 团队（14+ session）同步挂起/恢复，不再各自重试烧钱
- 网络事件全链路可观测：IPC 广播 + Hub audit log + watchdog 本地日志三处留痕
- 与 ADR-004 daemon 模式一致，运维心智无增

**负面**：
- 多一个进程需要守护（现在是 Hub、CPA、Watchdog 三个）
- CPA/Anthropic 探测有网络开销（每 30s 一轮）—— 可接受（流量 < 1 KB/min）
- 挂起 session 上报需要各 session 配合实现（session CLAUDE.md 已有规范，但落地执行看个人）

**风险**：
- Hub 挂了 watchdog 无法广播 → 降级到日志，等人工介入。如果 Hub 长期挂，watchdog 探测结果堆积本地，恢复后应补发广播（v0.4.1 考虑）
- Anthropic API 探测端点选择：`/v1/messages` 无鉴权返 401 算正常；如 Anthropic 改端点行为，探测逻辑需要更新（风险低）

## 实现分解

1. **Phase 1（0.4.0-alpha）**：`network-watchdog.mjs` 框架 + 4 项探测 + 状态机 + 单元测试
2. **Phase 2（0.4.0-beta）**：IPC 广播 + `/suspended` 表 + Hub `POST /suspend` 端点 + 集成测试
3. **Phase 3（0.4.0）**：daemon 三件套 + README / OPERATIONS 文档 + 发版

每 phase 独立 commit，便于回滚。

## 相关

- 规范：`xihe-tianshu-harness/domains/software/knowledge/network-resilience.md`（§4）
- ADR-004: 本地服务 daemon 模式（复用）
- ADR-005: Hub 代码分层（watchdog 独立进程延续分层原则）
- 0.3.0 的 `POST /wake-suspended` 是本 ADR 的临时前置方案（v0.4.0 后可废弃或保留作人工触发入口）
- `lib/router.mjs` `broadcastToTopic(topic, payload)` helper（0.3.0 已实现）
