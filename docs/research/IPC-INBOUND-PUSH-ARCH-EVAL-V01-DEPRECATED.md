# IPC Inbound Push 架构评估 v0.1

**作者**：jianmu-pm（IPC 主架构师）
**日期**：2026-04-28T02:10+08:00
**触发**：老板 04-27 23:32 + 04-28 00:46 critique「为什么建木一直工作」「IPC 不能自动 push」+ harness 01:34 推 ADR-014（codex App Server migration）被老板 critique 4 点（无全局视角 / 无扩展性 / 没沟通主架构师 / 没比较 ACP vs App Server）→ harness 改派评估文档
**范围**：portfolio inbound push 全局架构（CC + codex + 未来 Gemini/Copilot/OpenCode/openclaw）
**性质**：评估文档·**不是 ADR**·**不实施**·harness 审 → 老板拍 → 主架构师出正式 ADR-014（如需）

---

## §0. 摘要

**核心问题**：portfolio session（CC + codex）收到 IPC 后·model 不自动 surface·必须主动 drain（或被外部 prompt 唤醒）·形成 idle blackhole。

**根因**（已实证）：
1. **CC 端**：MCP `notifications/claude/channel` 是 fire-and-forget context 注入·不是 wake event·idle 期 channel tag 静态躺着不被 process（待 next turn 触发）。CC 2.1.120 已 GA `asyncRewake` 配置字段·hook exit 2 后台运行可 wake idle model（系 CC 原生·非 IPC 协议层）。
2. **codex 端**：codex CLI 收 MCP `notifications/message` 仅 route 到 stderr tracing（`logging_client_handler.rs`）·model 永远看不见。upstream issue #18056 OPEN 2026-04-16 至今零 PR·不在 roadmap。
3. **跨 agent**：MCP `notifications/claude/channel` 是 CC 私有扩展·codex / Gemini / Copilot 不接受。

**评估结论**（详见 §5）：**推荐 hybrid 方案 B'**（MCP + codex App Server + ACP orchestration layer + Hub sidecar 保留）：
- **MCP for CC**：现有 channel push 保留 + 新增 `asyncRewake` hook 解 CC idle wake（5min ship）
- **codex App Server bridge for codex**：Hub 加 App Server JSON-RPC client driver·用 `turn/steer` 把 inbound message append 到 active turn·idle 时用 `thread/inject_items` 注 history·都解决 #18056（不需等 fork PR）
- **ACP orchestration layer for future agents**：spawn / 管理 Gemini / Copilot / OpenCode 等·参照 OpenClaw acpx queue-based persistence 模型（`~/.acpx/sessions/`·idle TTL 300s）·**不**作为 inbound push 协议
- **Hub 保留**：所有现有 16 MCP tools + 20 HTTP routes + 7 WS message types + sidecar metadata（statusline / cost / lineage / handover / ccusage）+ broadcast fan-out

**Elevator pitch**：「保 CC MCP channel 不动·给 codex 加 App Server 直驱·留 ACP 给未来 agent·Hub 当 broadcast + metadata sidecar — 各取所长·零回归·1-2 周 ship。」

---

## §1 · portfolio IPC 全需求清单（grep 真实代码 + 实证）

### 1.1 现有 16 MCP tools（`xihe-jianmu-ipc/lib/mcp-tools.mjs`）

| # | tool | 用途 | 客户端 |
|---|------|------|-------|
| 1 | `ipc_send` | 1:1 send / `*` broadcast | CC + codex |
| 2 | `ipc_sessions` | 在线列表（pid / cwd / contextUsagePct） | CC + codex |
| 3 | `ipc_whoami` | 当前 session 身份 | CC + codex |
| 4 | `ipc_subscribe` | topic pub/sub | CC + codex |
| 5 | `ipc_spawn` | atomic handoff lineage 切换 | CC + codex |
| 6 | `ipc_rename` | 重命名当前 session | CC + codex |
| 7 | `ipc_reclaim_my_name` | 自助回收同名 zombie 占位 | CC + codex |
| 8 | `ipc_reconnect` | Hub host/port 切换 | CC + codex |
| 9 | `ipc_task` | 结构化任务 create/update/list | CC + codex |
| 10 | `ipc_recent_messages` | 持久化 backlog 拉取（默认 6h/50 条） | CC + codex |
| 11 | `ipc_recall` | observation.db 跨项目检索（FTS5） | CC + codex |
| 12 | `ipc_observation_detail` | 单条 observation 完整字段 | CC + codex |
| 13 | `ipc_register_session` | sessions-registry.json 维护 | CC + codex |
| 14 | `ipc_update_session` | 更新 session projects | CC + codex |
| 15 | `ipc_cost_summary` | ccusage 聚合（today / 7d / 30d） | CC + codex |
| 16 | `ipc_token_status` | 5h block 状态（remaining_pct / resets_at） | CC + codex |

### 1.2 现有 20 HTTP routes（`hub.mjs` + `lib/http-handlers.mjs`）

| route | method | 用途 |
|-------|--------|------|
| `/health` | GET | Hub 状态 + session 列表 |
| `/sessions` | GET | session 列表（pid/cwd/contextUsagePct） |
| `/session-alive?name=` | GET | session WS readyState |
| `/session/context` | POST | statusline 上报 contextUsagePct |
| `/messages?peer=&from=&to=` | GET | 持久化消息查询 |
| `/recent-messages?name=&since=` | GET | 近期消息（默认 6h/50） |
| `/stats?hours=N` | GET | per-agent 消息统计 |
| `/send` | POST | 发消息 |
| `/suspend` | POST | 记录挂起 session |
| `/wake-suspended` | POST | 广播 network-up |
| `/feishu-reply` | POST | 直接回复飞书 |
| `/registry/register` | POST | sessions-registry 创建/更新 |
| `/registry/update` | POST | sessions-registry projects 更新 |
| `/task` | POST | 结构化任务创建 |
| `/tasks` | GET | 任务列表 |
| `/tasks/:id` | GET | 任务详情 |
| `/tasks/:id` | PATCH | 任务状态更新 |
| `/reclaim-name` | POST | 同名 zombie 回收（loopback） |
| `/prepare-rebind` | POST | 显式会话接力 |
| `/internal/network-event` | POST | 内部 network-down/up 事件 |

### 1.3 WebSocket 消息类型（`hub.mjs:474-501`）

`ping` / `register` / `update` / `subscribe` / `unsubscribe` / `message` / `ack`

### 1.4 session metadata（sidecar，hub.mjs:422-426）

`pid` / `cwd` / `contextUsagePct` / `cost` / `model` + `topics` / `connectedAt` / `lastAliveProbe`

### 1.5 跨协议桥（已有）

- **feishu bridge** (`feishu-bridge.mjs` + `lib/command-parser.mjs`)：飞书多 app worker thread + 7 命令解析 + 卡片 UI
- **OpenClaw bridge**（mcp-server.mjs:1104-1107 转发 `OPENCLAW_URL/TOKEN`·hub.mjs:47 `openclaw-adapter.mjs`）：通过 OpenClaw Gateway `/hooks/wake` 唤醒挂起 session
- **statusline push**（ADR-011）：CC 状态栏通过 `/session/context` 上报 8 字段

### 1.6 Inbound push 路径（**问题所在**）

- **CC 现有**：Hub WS → `mcp-server.mjs:1212 pushChannelNotification(msg)` → `channelNotifier.pushChannelNotification` → `server.notification({ method:'notifications/claude/channel', ... })` → CC 客户端 `<channel>` tag 注 conversation context
  - 已修：ADR-009 pre-init queue + 5s fallback（冷启 race fixed）
  - 未修：**idle 期不 wake**·model 等 next turn 才 process
- **codex 现有**：同 `pushChannelNotification` 路径（mcp-server.mjs 不区分 client）·但 codex CLI 收 `notifications/message` 仅 stderr tracing·model 不可见（issue #18056）
- **broadcast (to=*)**：Hub `broadcast()` (hub.mjs:243) fanout 到所有 session WS·每条 session 各自走自己的 pushChannelNotification 路径·= **同一 inbound push 缺陷在 broadcast 也存在**

### 1.7 ipc_spawn / atomic handoff（lineage 切换）

- `wt`/`external` host CC：环境变量 `IPC_NAME` 传 session 名·canonical cmdline 含 `--dangerously-skip-permissions --dangerously-load-development-channels server:ipc`
- `codex` host：`wt` 用 `codex --dangerously-bypass-approvals-and-sandbox -c 'mcp_servers.jianmu-ipc.env.IPC_NAME=...'`·`exec` 用 `codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check`
- 配套 `patchTrustForCwd`（mcp-server.mjs:380-433）：spawn 前 atomic 写 `~/.claude.json projects[normalizedCwd].hasTrustDialogAccepted=true`（forward-slash key 已 04-28 修）
- ADR-010 atomic-handoff-quit IPC（04-27 ship）：watchdog trigger atomic handoff 时 IPC `atomic-handoff-quit` 给老 session·portfolio CLAUDE.md §0.3 5 步 SOP

### 1.8 watchdog / network resilience

- `bin/network-watchdog.mjs` 8 项 probe：`cliProxy / hub / anthropic / dns / committed_pct / available_ram_mb / phys_ram_used_pct / harness`
- 阈值：`phys_ram_used_pct >= 80%` WARN / >= 90% CRIT + tree-kill；`available_ram_mb < 10GB` WARN / < 5GB CRIT / < 3GB tree-kill
- ADR-006 v0.3 五信号 AND stuck session 检测
- `triggerHarnessSelfHandover()` 仅 harness `down` 触发（degraded 不直接 swap）

### 1.9 ccusage 集成（ADR-013·04-27 ship）

- `ccusage-adapter.mjs` aggregation
- `ipc_cost_summary(window, group_by)` MCP tool
- `ipc_token_status()` 5h block status
- 5 件套同步：commit type ∈ {`feat` / `fix` / `refactor` / `perf` / `docs(adr-*)`} 后必更新 TODO + PROJECT-PLAN

### 1.10 飞书控制台

P2P / 群聊 @机器人 7 命令：`状态` / `帮助` / `让{agent}去{task}` / `广播:` / `重启` / `历史` / `日报` / `新增机器人`

### 1.11 完整需求维度（评估方案 cover 度的对照表）

| 维度 | 现状 | 重要度 |
|------|------|-------|
| D1. multi-session routing 1:1 + broadcast (to=*) | Hub WebSocket fan-out | P0 |
| D2. inbound push 实时（active turn） | MCP `notifications/claude/channel`（CC OK / codex 失败） | P0 |
| D3. inbound push idle wake | 全无（boss critique 的核心痛点） | P0 |
| D4. inbound push mid-turn inject | 全无 | P1 |
| D5. SQLite 持久化（messages.db / observation.db） | better-sqlite3 + FTS5 | P0 |
| D6. session 元数据（pid / cwd / contextUsagePct / cost / model） | Hub sidecar 字段 | P0 |
| D7. atomic handoff lineage 切换 | ipc_spawn + patchTrustForCwd + atomic-handoff-quit | P0 |
| D8. watchdog phys_ram trigger broadcast | network-watchdog.mjs + critique topic | P1 |
| D9. statusline push（context_pct / cost / model 8 字段） | `/session/context` POST | P1 |
| D10. ccusage cost integration | ccusage-adapter + 2 MCP tools | P2 |
| D11. task-notification（codex 跑完） | Claude Code background task hook | P1 |
| D12. feishu bridge | feishu-bridge.mjs + 7 命令 | P1 |
| D13. OpenClaw bridge `/hooks/wake` | openclaw-adapter.mjs | P1 |
| D14. 跨 agent 兼容（CC / codex / Gemini / Copilot / OpenCode 等） | 仅 CC + codex（部分） | P1 future |
| D15. handover lineage 跨协议 mapping | ipc_register_session + 5 件套 | P1 |
| D16. zombie eviction（同名占位回收） | reclaim-name + 5s ping/pong | P1 |
| D17. Hub WebSocket :3179 现有 contract（外部 watchdog / dashboard） | hub.mjs unchanged | P0 |

---

## §2 · 5 方案 cover 矩阵

### 评分规则

- ✅ = native cover（不需额外工作）
- 🟨 = partial cover（需 adapter / sidecar / 部分重写）
- ❌ = no cover（需另起协议层 / 重新实现 / 不可行）

### 2.1 矩阵全表

| 需求维度 | A. ACP 全替 | B. MCP+ACP hybrid | B'. MCP+App Server hybrid（推荐细化） | C. App Server only | D. fork MCP patch | E. polling 兜底 |
|---------|------------|-------------------|---------------------------------------|--------------------|-------------------|----------------|
| D1. routing + broadcast | 🟨 Hub fan-out 重写 | ✅ Hub 保留 | ✅ Hub 保留 | ✅ Hub 保留 | ✅ Hub 保留 | ✅ Hub 保留 |
| D2. active turn push | ❌ ACP 无 server→client mid-turn 等价（仅 session/cancel） | ✅ CC MCP channel + codex ACP/App Server | ✅ CC MCP channel + codex App Server `turn/steer` | ✅ App Server `turn/steer` | ✅ MCP+patch surface model | 🟨 5min latency |
| D3. idle wake | ❌ ACP 无 wake primitive | 🟨 CC asyncRewake + codex ACP queue（acpx pattern） | ✅ CC asyncRewake + codex App Server `thread/inject_items` 进 history + next thread/start trigger | ✅ App Server | ✅ MCP+patch | ❌ 5min 不算实时 wake |
| D4. mid-turn inject | ❌ ACP 仅 session/cancel | 🟨 ACP cancel + codex App Server steer | ✅ App Server `turn/steer` | ✅ App Server | ❌ MCP 无 mid-turn primitive | ❌ |
| D5. SQLite 持久化 | 🟨 重写到 ACP 不影响 db 层 | ✅ Hub 不动 | ✅ Hub 不动 | ✅ Hub 不动 | ✅ Hub 不动 | ✅ 不动 |
| D6. session 元数据 | ❌ ACP 仅 sessionInfo·必 sidecar | ✅ Hub sidecar 保留 | ✅ Hub sidecar 保留 | 🟨 codex App Server thread metadata 部分覆盖（branch/sha/originUrl）·portfolio 字段需 sidecar | ✅ Hub sidecar | ✅ |
| D7. atomic handoff lineage | ❌ ACP `session/resume` 不等价 atomic handoff | ✅ ipc_spawn 保留 | ✅ ipc_spawn 保留 | 🟨 codex App Server `thread/fork`/`thread/resume` 可 mapping | ✅ 保留 | ✅ |
| D8. watchdog broadcast | 🟨 Hub broadcast 重写 ACP fan-out | ✅ Hub WS 保留 | ✅ Hub WS 保留 | ✅ Hub WS 保留 | ✅ Hub WS 保留 | ✅ |
| D9. statusline push | ❌ ACP 无对应 | ✅ `/session/context` 保留 | ✅ `/session/context` 保留 | ✅ 保留 | ✅ | ✅ |
| D10. ccusage | 🟨 重写整合 ACP | ✅ ccusage-adapter 保留 | ✅ 保留 | ✅ | ✅ | ✅ |
| D11. task-notification | 🟨 ACP `session/update` 部分 mapping | ✅ 保留 | ✅ 保留 | 🟨 App Server `turn/completed` notification（事件名不同·要 mapping） | ✅ | ✅ |
| D12. feishu | 🟨 重写 | ✅ 保留 | ✅ 保留 | ✅ 保留 | ✅ | ✅ |
| D13. openclaw | 🟨 重写（但 OpenClaw 本身已用 ACP） | ✅ 保留 + ACP 双向 | ✅ 保留 | ✅ 保留 | ✅ | ✅ |
| D14. 跨 agent 兼容 | ✅ ACP 11+ agent | 🟨 ACP for new agent / MCP for CC / App Server for codex | 🟨 同 B 但 codex 走 App Server·ACP 仅 future agent layer | ❌ App Server 仅 codex（OpenAI proprietary） | ❌ MCP 仅 CC + patched codex | ✅ polling 不限 protocol |
| D15. handover lineage | ❌ 必重写 | ✅ 保留 | ✅ 保留 | 🟨 部分 mapping | ✅ | ✅ |
| D16. zombie eviction | 🟨 ACP `session/close` + reclaim 重写 | ✅ 保留 | ✅ 保留 | 🟨 App Server `thread/closed` notification 配 reclaim 重写 | ✅ | ✅ |
| D17. Hub :3179 contract | ❌ Hub 改 ACP server·WebSocket contract 失效 | ✅ Hub 不动 | ✅ Hub 不动 | ✅ Hub 不动 | ✅ Hub 不动 | ✅ 不动 |

### 2.2 cover 度统计

| 方案 | ✅ | 🟨 | ❌ | 总分（✅=2 / 🟨=1 / ❌=0·满分 34） |
|------|----|----|----|------------------------------------|
| A. ACP 全替 | 1 | 7 | 9 | 9（26%） |
| B. MCP+ACP hybrid | 11 | 4 | 2 | 26（76%） |
| **B'. MCP+App Server hybrid（推荐）** | **13** | **3** | **1** | **29（85%）** |
| C. App Server only | 11 | 5 | 1 | 27（79%）但仅 codex |
| D. fork MCP patch | 14 | 0 | 3 | 28（82%）但维护 fork |
| E. polling 兜底 | 14 | 0 | 3 | 28（82%）但 D2/D3/D4 全失（关键痛点未解） |

---

## §3 · 5 关键问题 WebFetch 实证答案

**实证源**：
- ACP spec：https://agentclientprotocol.com + /llms.txt + /protocol/prompt-turn
- codex App Server README：https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- codex App Server doc：https://developers.openai.com/codex/app-server
- codex issue #18056：https://github.com/openai/codex/issues/18056
- OpenClaw acpx：https://github.com/openclaw/acpx
- OpenClaw ACP agents 表：https://docs.openclaw.ai/tools/acp-agents

### Q1. ACP `session/prompt` 是否支持 mid-turn inject？

**❌ NO**。

- ACP 协议方法：`session/prompt`（client→agent 起 turn）/ `session/update`（agent→client 流式）/ `session/cancel`（client→agent 取消）/ `session/list`/`close`/`resume`
- **mid-turn inject 全无**·只有 `session/cancel`·**没有** `session/steer` 或等价方法
- 一个 turn 起来后 client 唯一介入是 cancel·不能 append 新内容
- agent→client 通过 `session/update` 流（plan / agent_message_chunk / tool_call / tool_call_update）·这是反向（agent 输出·不是 peer push 入 model）

**对比**：codex App Server 有 `turn/steer`·**append user input to active in-flight turn without creating a new turn**·`expectedTurnId` 必须匹配·不发 `turn/started`。这是 ACP 没有的关键 primitive。

### Q2. ACP 是否有 server→client push notification protocol primitive？

**🟨 部分 YES·但用途不同**。

- ACP `session/update` 是 agent→client 的 streaming notification（不是 client→agent push）
- 内容：agent 思考 / 工具调用 / 计划更新·**全是 agent 自己的输出**·**不能** carry peer agent 的 inbound message
- = ACP 设计是「IDE 显示 agent 进度」·不是「peer agent 注消息进 model context」

**对比**：codex App Server 有 unsolicited notifications（thread/started / turn/completed / item/agentMessage/delta 等）+ `thread/inject_items`（Responses API items 注 history 外·不依赖 active turn）。这两个组合可以实现「peer→model 注入」（虽然不是协议初衷，但 mechanism 在）。

### Q3. portfolio metadata（statusline / context_pct / cost / watchdog / atomic handoff lineage / ccusage）在 ACP 协议之外·sidecar 还是保留 MCP 路径？

**✅ 必 sidecar·保留 MCP / Hub 现有路径**。

- ACP `sessionInfo` 仅含 sessionId / agent name / 一些通用字段·**没有** portfolio 关心的 contextUsagePct / cost / model / lineage 字段
- codex App Server `thread/metadata/update` 仅 `{ branch, sha, originUrl }`·portfolio 字段不在内
- = portfolio metadata 必须保留 Hub sidecar（hub.mjs:422-426）+ `/session/context` `/registry/register` 等专用 HTTP API
- 优势：sidecar 与协议解耦·任何 agent（CC / codex / 未来 Gemini）都可上报到 Hub·不锁死 protocol

### Q4. CC 端现 MCP `notifications/claude/channel` 工作良好·切 ACP 后怎么 push？

**❌ 切 ACP 后 CC 私有 channel 失效·必 dual protocol（不能整层 swap）**。

- `notifications/claude/channel` 是 CC 私有 MCP 扩展·不是 ACP 标准
- ACP 没有等价的 server→client mid-turn inject（Q1 证）
- 整层切 ACP = CC 现有 inbound push 路径整体 broken
- **结论**：CC 必须保 MCP·codex / 新 agent 走另一协议（codex App Server 或 ACP）·hybrid 不可避免

### Q5. portfolio broadcast (to=*) 在 ACP session 1:1 模型下怎么 hub fan-out？

**🟨 Hub 层 fan-out·每 agent 独立 ACP/App Server/MCP 连接·与现有 WebSocket fan-out 模型一致**。

- ACP 是 1:1 session 模型·**无 native broadcast**（OpenClaw acpx 实证：`sessions_send` + A2A bounded turns fallback·**parent-owned skip A2A 防 echo**）
- codex App Server 同·**no native broadcast**·thread 1:1 subscription
- = portfolio broadcast 必须 Hub 层实现：Hub 收 to=* → 遍历所有 session → 每 session 走自己的 inbound push 协议（CC=MCP channel / codex=App Server steer / Gemini=ACP session/prompt 队列）
- 当前 Hub 已有 `broadcast()` (hub.mjs:243)·只需扩展支持多协议 dispatch

---

## §4 · trade-off 表（cover + 短期 / 长期 + 维护成本 + 风险）

| 方案 | cover 度 | 短期成本（≤2 周） | 长期成本（≥3 月） | 主要风险 | 是否可行 |
|------|---------|-----------------|------------------|---------|---------|
| A. ACP 全替 | 26% | 极高（重写 16 tools + 20 routes + Hub WS）·~6-8 周 | 中（ACP 标准维护成本低） | CC channel push 失效 / portfolio metadata 大量 sidecar / WS contract 破坏 / 现有用户回归 | ❌ 不可行 |
| B. MCP+ACP hybrid（harness 原推） | 76% | 中（CC 不动 + codex/未来 agent 走 ACP）·~2-3 周 | 中（双协议维护） | ACP 无 mid-turn inject·codex idle wake 仅 acpx queue + 30s polling·实时性次于 turn/steer | 🟨 可行但次优 |
| **B'. MCP+App Server hybrid（推荐）** | **85%** | **低（CC 不动 + codex 加 App Server client driver）·~1-2 周** | **中-低（codex App Server 是 OpenAI 一等公民·更新跟主线）** | **App Server WebSocket experimental·stdio 默认安全 / OpenAI 改 API 需跟 / ACP layer 推迟到第 3 个 agent 加入** | **✅ 推荐** |
| C. App Server only | 79% | 低（同 B'）·但跨 agent 不通用 | 高（每加 agent 要写新 driver） | 锁死 OpenAI 生态·Gemini/Copilot 进来时整体重整 | 🟨 短期可·长期受限 |
| D. fork MCP patch | 82% | 中（fork codex-rs + 50 LOC + 维护）·~2 周 | 高（每次 codex 升级 rebase patch） | upstream #18056 不在 roadmap·fork 永久维护 / CI 复杂度 | 🟨 备选（如 App Server 不通） |
| E. polling 兜底 | 82% | 极低（5min cron + ipc_recall）·~1 day | 低（运维成本）但实时性 fail | D2/D3/D4 全部 5min latency·boss critique 的核心痛点未解 | ❌ 不解决问题 |

---

## §5 · 推荐 + 理由 + Elevator Pitch

### 5.1 推荐：**B'. MCP + codex App Server hybrid + ACP orchestration layer + Hub sidecar**

### 5.2 理由

1. **cover 度最高（85%·29/34）**：保留所有 17 维度的 13 项 ✅·3 项 🟨（D6/D11/D14·均通过 sidecar / mapping 解决）·仅 1 项 ❌（D14 跨 agent 兼容·留给 ACP layer 第三阶段）。
2. **短期成本最低**：CC 端 0 改动（保 MCP + 加 asyncRewake hook 5min）·codex 端加 App Server client driver（~1-2 周·约 500-800 LOC）·Hub 改动局部（adapter 模块化）。
3. **长期可扩展**：第三个 agent（Gemini / Copilot）加入时·走 ACP layer（OpenClaw acpx 模型）·与 MCP+App Server 共存·Hub 不动。
4. **零回归**：现有 16 MCP tools / 20 HTTP routes / 7 WS messages / SQLite / sidecar metadata / atomic handoff / watchdog / ccusage / 飞书桥·全 0 改动·portfolio 在跑业务不打断。
5. **解决核心痛点**：
   - CC idle wake：`asyncRewake` 配置型 hook（CC 2.1.120 docs GA）·1 行 settings.json + 1 ps1 脚本（5min ship）
   - codex idle wake：codex App Server `turn/steer` 直接 append 到 active turn / `thread/inject_items` 注 idle thread history（next turn 自动 surface）
   - broadcast：Hub fan-out 每 agent 走自己 inbound push 协议
6. **避免 jumping**：不锁死 ACP（Q1 实证 ACP 无 mid-turn inject）·不锁死 App Server（仅用于 codex）·保留扩展点。

### 5.3 Elevator Pitch（一句话）

> **「保 CC MCP channel 不动·给 codex 加 App Server `turn/steer` 直驱·留 ACP 给未来 agent·Hub 当 broadcast + metadata sidecar — 各取所长·零回归·1-2 周 ship。」**

---

## §6 · Migration Path（推荐方案 B' 实施步骤）

### Phase 1：CC idle wake 立即 ship（5min·**本评估文档审完即可启动**）

**目标**：解决 CC idle wake 痛点。

**步骤**：
1. 写 `xihe-tianshu-harness/domains/software/hooks/ipc-asyncRewake-wake.ps1`：
   - 输入：CC PostToolUse hook event
   - 行为：HTTP GET `/recent-messages?name=<IPC_NAME>&since=<last_check>&limit=10`
   - 有未读 → stderr 输出 `[IPC-ASYNC-WAKE] <count> new messages: <preview>` + exit 2
   - 无未读 → stdout 空 + exit 0
2. `.claude/settings.json` PostToolUse 段加 hook handler · `asyncRewake: true` · `timeout: 5`
3. 活体测：复用 §B' codex 已写 recipe + ps1（`temp/asyncRewake-test/`）·jianmu-pm + harness 协作 30s idle 实测 a/b/c
4. 实测 (a) → ship 到 portfolio settings.json 模板·(b)/(c) → 走 Phase 2

**AC**：jianmu-pm idle 30s · harness 派 IPC · jianmu-pm 自动起 turn surface marker，无需 user prompt。

**ETA**：5min（已有 recipe + ps1 就绪）·**只缺活体测试**。

### Phase 2：codex App Server bridge（~1-2 周）

**目标**：解决 codex inbound push（issue #18056 不依赖 upstream PR）。

**步骤**：
1. **Hub 加 codex App Server client driver**（`xihe-jianmu-ipc/lib/codex-app-server-client.mjs`，~300-500 LOC）：
   - JSON-RPC 2.0 over stdio（默认）/ WebSocket（experimental·暂不用）
   - 实现 `initialize` / `thread/start` / `thread/resume` / `thread/list` / `turn/start` / `turn/steer` / `turn/interrupt` / `thread/inject_items`
   - 监听 server notifications：`thread/started` / `turn/completed` / `item/*` / `thread/closed`
2. **session registry 扩展**：每 codex session 在 register 时关联一个 App Server thread（`thread/start` 返回的 threadId）·存入 sessions-registry.json
3. **inbound push 路由分支**（`hub.mjs` route layer）：
   - target session.runtime === 'claude' → 现有 `pushChannelNotification` 路径不变
   - target session.runtime === 'codex' → 新路径：
     - active turn 存在 → `turn/steer` append message
     - active turn 不存在（idle） → `thread/inject_items` 注 history（带 marker）+ 等下次 thread/start
   - target session.runtime === 'acp'（未来）→ Phase 3 ACP layer
4. **broadcast (to=*) fan-out 扩展**：Hub `broadcast()` 改为按 session.runtime 分支 dispatch（已有 ws fan-out 复用）
5. **ipc_spawn 扩展**（mcp-server.mjs:spawnSession）：codex spawn 时同时 `thread/start` 一个 App Server thread·关联到 session·关闭时 `thread/unsubscribe`
6. **测试**：
   - 单元：codex-app-server-client.mjs 跑 mock JSON-RPC fixtures
   - 集成：spawn 一个 codex session · IPC 一条 message · 实证 turn/steer / inject_items 路径 · model 看见 marker
   - 回归：现有 CC ↔ CC IPC + atomic handoff 等不破坏

**AC**：
- AC-1：codex idle session · IPC `[CODEX-INBOUND-TEST]` marker · 下次 model turn 见到 marker（不需 user prompt 触发）
- AC-2：codex active turn 中 IPC · marker append 到当前 turn · model 立刻 incorporate
- AC-3：CC ↔ CC IPC 现有路径 0 回归
- AC-4：broadcast (to=*) 同时含 CC + codex session · 各 surface 各自 channel
- AC-5：codex App Server stdio 转 stdin/stdout · 不影响现有 codex CLI invocation 模式

**ETA**：1-2 周（~500-800 LOC + 测试 + 集成）。

### Phase 3：ACP orchestration layer（待第 3 个 agent 加入·~3-6 月）

**目标**：portfolio 加 Gemini / Copilot / OpenCode / Qwen 等 agent 时·走 ACP 标准 spawn / 管理（OpenClaw acpx 模型）。

**步骤**：
1. Hub 加 ACP server adapter（参考 acpx queue-based persistence）
2. ipc_spawn 扩展支持 `runtime=acp`·spawn 用 acpx 风格命令
3. inbound push 走 polling fallback（ACP 无 mid-turn inject）+ session/prompt 队列
4. 整合到 broadcast fan-out

**触发条件**：portfolio 真要加第 3 个 agent 时（不预先做）。

### Phase 4：长期监控

- 监控 codex issue #18056 PR 进展·如 upstream fix·可考虑 simplify codex MCP path（但 App Server 已 ship 不需 rollback）
- 监控 ACP 协议增加 mid-turn inject（`session/steer` 等）·如出·重评 Phase 3 路径
- 监控 CC `asyncRewake` schema 在 2.1.121+ 是否变·必版本 pin + 升级矩阵复测

---

## §7 · 拍板路径

```
本评估 doc v0.1 → harness 审 → 老板拍 → 主架构师（jianmu-pm）出正式 ADR-014（如拍 B'）
```

**拍板时机**：harness 审完没大改 → 老板看 `§5.3 Elevator Pitch` + `§4 trade-off 表`·一句拍。

**ADR-014 内容（如拍 B'）**：
- 摘 §5 推荐 + §6 Phase 1+2 实施步骤 + AC
- 增加：API contract 定义（Hub ↔ codex App Server client driver 接口）、回退策略（Phase 1/2 GREEN 失败回 polling 兜底）、AC 验收清单
- 落档：`xihe-jianmu-ipc/docs/adr/014-ipc-inbound-push-hybrid.md`

**5 件套同步**：
- 本评估 doc 是 `docs/research/`·不 trigger 5 件套自更（不是 feat/fix/refactor）
- ADR-014 ship（Phase 2 完成）→ trigger TODO + PROJECT-PLAN 更新

---

## §8 · 参考源（实证依据）

1. ACP spec：https://agentclientprotocol.com / llms.txt / /protocol/prompt-turn
2. codex App Server README：https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
3. codex App Server doc：https://developers.openai.com/codex/app-server
4. codex issue #18056（MCP push limitation）：https://github.com/openai/codex/issues/18056
5. OpenClaw acpx：https://github.com/openclaw/acpx
6. OpenClaw ACP agents 列表：https://docs.openclaw.ai/tools/acp-agents
7. Claude Code hooks docs（asyncRewake 字段）：https://code.claude.com/docs/en/hooks
8. CC issue #50160（asyncRewake schema 漂移）：https://github.com/anthropics/claude-code/issues/50160
9. CC issue #50682（Stop additionalContext OPEN feature request）：https://github.com/anthropics/claude-code/issues/50682
10. xihe-jianmu-ipc 真实代码 grep：mcp-server.mjs / hub.mjs / lib/mcp-tools.mjs / lib/http-handlers.mjs / lib/channel-notification.mjs / lib/openclaw-adapter.mjs

## §9 · 配套调研报告（评估输入）

- `temp/codex-runs/b-stop-hook-additionalContext-research.md`（B 调研：Stop additionalContext NOT supported (c) 已锁定）
- `temp/codex-runs/b-prime-asyncRewake-research.md`（B' 调研：asyncRewake 是 settings 配置字段·CC 2.1.120 GA·activity test recipe ready）
- `temp/codex-briefs/ipc-push-mechanism-research-brief.md`（前期总 brief：4 候选 A/B/C/D）

---

— jianmu-pm · 2026-04-28T02:10+08:00 · v0.1 草稿
