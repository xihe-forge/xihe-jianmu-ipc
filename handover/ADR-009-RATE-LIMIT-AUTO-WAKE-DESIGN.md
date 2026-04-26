# ADR-009 Design · API rate limit / 周限额自动接续 4 SOP

> 注：xihe-jianmu-ipc 仓 `docs/adr/009-mcp-initialize-race-fix.md` 已占用 ADR-009 编号。本文档走 `handover/` design 路径 · 待 review 后转正式 ADR 时按 portfolio ADR 编号约定（xihe-tianshu-harness 仓 ADR-010 候选 / 或本仓 ADR-010）拍板。

## 状态

**v0.1 Proposed**（2026-04-26T14:18+08:00 · jianmu-pm 起草 · 等老板 review）

## 背景

### 触发事件

2026-04-25T21:34+08:00 老板派 P0："API 限额管理 4 SOP 缺失 · 周限额到 88% 才被发现 · session 卡 idle 时无自动唤醒 · portfolio 无 dashboard 实时显示 token 用量"

2026-04-26T02:02+08:00 老板再 critique：周限额 88% · 明天 token 用尽风险 · session 可能突然 stop · todo 落盘频次必须升级。

### 现有规范的 4 个 gap

| Gap | 现状 | 影响 |
|---|---|---|
| **API health probe** 只看 connection（`anthropic` probe 8 项之一）· 不看 rate limit usage | network-watchdog `bin/network-watchdog.mjs` 8 项 probe 仅 anthropic API 连接性 · 不读 X-RateLimit-* headers | 周限额 80% 阈值无人广播 · 老板手动发现 |
| **Session stuck detection** 不区分 retry stuck / rate-limit stuck / network stuck | ADR-006 v0.1 Plan A/B/C 处理 ECONNRESET retry · 不处理 rate limit 429 | 429 卡住 session 走相同 idle 路径 · 但 wake 后还是 429 重 retry | 
| **Wake 自动 IPC** 仅触发 anthropic-up 事件 · 不区分 rate-limit-reset 时间 | `lib/network-events.mjs` broadcastNetworkUp 在 anthropic API 恢复时触发 · rate limit reset 是按时间窗（1d / 7d）· 当前不读 reset header | rate-limit 卡住 session 被 ECONNRESET 路径误 wake · 立即再 429 |
| **Portfolio level dashboard** 无 token 用量实时视图 | 飞书控制台 7 命令仅状态/派发/广播等 · 无 token 用量 / rate-limit 用量 / 周限额累计 | 老板靠手动 npx 看 / 切账号才发现 |

= **rate limit 治理是 ADR-006 ECONNRESET 自动接续之外的独立 gap** · ADR-006 处理 retry exhausted / network down · ADR-009 处理 rate limit 429 + 周限额预警。

### portfolio 实证

- 2026-04-25T22:00 boss 周限额 ~70% 派 self-handover 准备
- 2026-04-26T00:25 boss 周限额 80% 切账号准备 broadcast
- 2026-04-26T02:02 boss 88% · 明天 token 用尽风险
- = **24h 内 18pp 上涨** · 无自动预警 · 无早期补救

## 决策（4 SOP 综合方案）

### SOP-1 · API health probe 扩 rate limit 字段

**机制**：
- `bin/network-watchdog.mjs` anthropic probe 改 HEAD/GET 验连接性 + 读响应 headers：
  - `X-RateLimit-Limit-Requests` · `X-RateLimit-Remaining-Requests`
  - `X-RateLimit-Limit-Tokens` · `X-RateLimit-Remaining-Tokens`
  - `X-RateLimit-Reset-Requests` · `X-RateLimit-Reset-Tokens`
  - `Anthropic-RateLimit-*` 系列（如有）
- 计算 `usedPct = 1 - (remaining / limit)` · 80% 广播 WARN topic critique · 90% 广播 CRIT topic critique（5min dedup per-level · 与 phys_ram_used_pct 同治理路径）
- 加第 9 probe `anthropic_rate_limit_pct` · CLAUDE.md "Watchdog" 段同步

**Token 成本**：watchdog daemon 跑不消耗 portfolio token · 0 token / 次

### SOP-2 · Session stuck detection 三态分类

**机制**：
- Hub `lib/session-stuck-detector.mjs` 新增（或扩 `lib/network-events.mjs`）
- 监三态：
  - **retry-exhausted**（ADR-006 已处理）：retry counter 满 10 + ECONNRESET / network down
  - **rate-limited**：HTTP 429 / X-RateLimit-Remaining-* = 0
  - **network-down**：watchdog `network-down` topic 广播
- 不同态走不同 wake 路径（防止 rate-limited session 立即重 retry 浪费 token）

**实施位置**：lib 层抽象 stuck reason · stderr hook (ADR-006 Plan B `claude-stderr-watch.ps1`) 扩 grep `429 Too Many Requests` / `rate limit` 关键字 · POST /suspend 时带 `reason: 'rate-limited'`

### SOP-3 · Rate-limit aware wake IPC

**机制**：
- `broadcastNetworkUp` 现 wake all stale sessions（ADR-006 Plan A）
- 加 `wakeRateLimited({ resetAt })` 路径：当 `Anthropic-RateLimit-Reset-*` header 显示 reset 时刻已过 · 才 wake `reason: 'rate-limited'` 的 suspended sessions
- IPC 内容：
  ```
  【rate-limit auto-wake from jianmu-pm】 X-RateLimit reset 已恢复 · 自动续上 rate-limited 任务 · 如仍 429 立即 IPC 我重 suspend 不主动 retry
  ```
- 防止 reset 前误 wake 立即再 429 · 保护 token 不浪费

**Token 成本**：< 80 token / 次 wake IPC + < 200 token session 处理

### SOP-4 · Portfolio level dashboard

**机制**：
- 飞书控制台命令扩第 8 指令 `用量` / `usage`
- 飞书 bridge 调 Hub `GET /usage` 新端点：
  ```json
  {
    "anthropic_weekly_used_pct": 0.88,
    "anthropic_weekly_reset_at": "2026-04-30T00:00:00Z",
    "rate_limit_requests_remaining": 12000,
    "rate_limit_tokens_remaining": 4500000,
    "rate_limit_reset_at": "2026-04-26T15:00:00Z",
    "suspended_sessions": [...],
    "stuck_sessions_by_reason": { "rate-limited": 2, "retry-exhausted": 1, "network-down": 0 }
  }
  ```
- Hub `/usage` endpoint 从 watchdog memory + db.suspended_sessions 聚合
- 飞书卡片渲染：3 段进度条（周限额 / 请求 / token）+ 卡住 session 列表

**Token 成本**：飞书命令拦截不进 IPC · 卡片渲染 server-side · 0 portfolio token

### 30 天观察期

- 30 天内 portfolio 周限额 80% 阈值预警准时率（早期 vs 老板手动发现） ≥ 90% = 高速达成
- 30 天后 audit · < 90% 升 v0.2

## 与现有 ADR 的关系

| ADR | 关系 | scope |
|---|---|---|
| ADR-006 (ECONNRESET auto-wake) | **互补** | ADR-006 处理 retry exhausted / network down / 全局连接性 |
| ADR-003 (advisory hook) | **复用 hook 装载路径** | SOP-2 stderr hook grep 扩 429 关键字 · 与 checkpoint-refresh.ps1 / claude-stderr-watch.ps1 共享 portfolio 重启窗口装载 |
| ADR-005 (commit-msg-validate.ps1) | 共享 PS hook 装载路径 | install-hooks.mjs v2 PS pattern 复用 |
| ADR-004 (portfolio auto-rollover) | **互补** | rate-limit reset 后续命可解 · 不需立即切账号 · ADR-009 是切账号前置缓冲 |

## 后果

### 正面
- **周限额 80% 自动预警**（不靠老板手动发现）· 解决 02:02 critique 根因
- **rate-limited vs retry-exhausted 分治** · 防止误 wake 浪费 token
- **portfolio 实时 token 用量视图** · 老板飞书一键看
- **共享现有基础设施**（watchdog probe + Hub /suspend + PS hook + 飞书 bridge）· 实施成本低

### 负面
- watchdog probe 加读 anthropic API headers · 网络抖时 probe 失败概率上升 · 需 graceful fallback（headers 缺失时仅看连接性 · 现有逻辑保留）
- `/usage` endpoint 暴露 rate-limit 数据 · 需 loopback 限制（与 `/internal/network-event` 同源）
- 飞书"用量"命令 30 天观察期内可能误读（X-RateLimit headers 文档不全 · 需手动校对 anthropic console 真值）

### 中性
- 与 ADR-002/003/004/005/006 治理升级链共享 30 天 advisory event log
- 4 SOP 实施可拆 4 个独立 PR 增量 ship · 不需大单整合

## 替代方案

### 方案 D · 周限额到了切账号（已否决 · 当前路径）
当前 portfolio 流程：周限额 80% → 老板手动 critique → 切账号准备 → 关 wt 窗口
- ❌ 老板每次手动发现 + critique
- ❌ session 卡 88% 不是 80% 才动手 · 缓冲窗口被动消耗
- ❌ 切账号是末端方案 · 不解决"为何到 80% 才发现"
- 评分 ⭐ · 是当前现实路径但不是设计路径

### 方案 E · 限流式 token 预算分配（已否决）
给每 session 分配 token 预算配额 · 用满即冻结
- ❌ 实施复杂（需要 portfolio level token tracking · session 间转账）
- ❌ 与"AI 自驱拓展"理念矛盾 · session 应按需 token 不应配额限制
- 评分 ⭐⭐ · 不采纳（v2 候选若 4 SOP 仍不够）

### 方案 F · OpenAI/其他 LLM 双链路（候选 v0.2 升级）
周限额触发后切 OpenAI/其他后端
- ⭐⭐⭐ 不消耗 anthropic 周限额
- ⭐⭐⭐ 但 model capability gap（其他 LLM ≠ Claude Opus）· 可能影响 session 表现
- 评分 ⭐⭐⭐ · v0.2 候选

## 参考

- `xihe-tianshu-harness/handover/adr/ADR-006-PORTFOLIO-ECONNRESET-AUTO-RECOVERY.md` v0.1（同源 wake 机制 · ADR-009 互补）
- `xihe-tianshu-harness/domains/software/knowledge/network-resilience.md` v1.0（§3 假设破产 / §4 全局容错语境）
- `xihe-jianmu-ipc/CLAUDE.md` "Watchdog" 段（8 项 probe · ADR-009 SOP-1 加第 9 项 rate_limit_pct）
- `xihe-jianmu-ipc/CLAUDE.md` "HTTP API" 段（/suspend + /wake-suspended · ADR-009 SOP-2/3 复用）
- `xihe-jianmu-ipc/CLAUDE.md` "飞书AI控制台" 段（7 命令 · ADR-009 SOP-4 加第 8 命令）
- Anthropic API Rate Limit 文档（待 codex 实施时核 X-RateLimit-* / Anthropic-RateLimit-* headers 真名）

## 历史 anti-pattern 记录

1. **rate limit 与 ECONNRESET 混治**：ADR-006 Plan A 全部 stale session wake · 不区分 retry-exhausted / rate-limited · rate-limited session wake 后立即再 429 浪费 token。ADR-009 SOP-2 三态分类是 ADR-006 之外的补集
2. **API probe 仅看连接性**：watchdog 8 项 probe 全是连接性（cliProxy/hub/anthropic/dns/committed_pct/available_ram_mb/phys_ram_used_pct/harness）· 不读 rate limit headers · 周限额预警空白。SOP-1 第 9 probe 补
3. **portfolio 无 token 用量视图**：老板靠 npx 手查 / 切账号才发现 · 没有飞书一键查询路径。SOP-4 飞书"用量"命令补

## NextSteps

- [x] 立 ADR-009 v0.1 design 落档（本文）
- [ ] 老板 review 拍板综合策略（4 SOP / 拆分 / 其他）
- [ ] 切账号后实施 SOP-1（watchdog 第 9 probe）· 可与 ADR-006 Plan C 共派 codex（同改 network-watchdog.mjs）
- [ ] 切账号后实施 SOP-2（stderr hook 扩 grep 429 + Hub stuck-reason 字段）· 可与 ADR-006 Plan B 共派
- [ ] SOP-3 wakeRateLimited 路径（lib/network-events.mjs 扩 · 与 Plan A 同源）
- [ ] SOP-4 /usage endpoint + 飞书"用量"命令（独立 PR · ETA 2026-04-30）
- [ ] 30 天观察期 advisory event log（与 ADR-006 / ADR-004 / ADR-005 共享 jianmu-ipc Hub advisory_hit 路径）
- [ ] 30 天 audit · 周限额 80% 预警准时率 ≥ 90% 转 Accepted

---

立项时间：2026-04-26T14:18+08:00 · jianmu-pm 起草 v0.1（响应 boss 21:34 P0 派单 + 02:02 88% 周限额 critique）
作者：jianmu-pm
Reviewers：harness · 老板
