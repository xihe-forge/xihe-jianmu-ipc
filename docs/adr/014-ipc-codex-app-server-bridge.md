# ADR-014: IPC codex App Server bridge

**日期**：2026-04-28
**状态**：决策通过（老板 04-28 13:22 拍开干）·实施中（Phase 1 派出 codex run·jianmu-pm dispatched）
**作者**：jianmu-pm（IPC 主架构师）
**评估文档**：`docs/research/IPC-INBOUND-PUSH-ARCH-EVAL-V01.md` v0.4
**配套调研**：`temp/codex-runs/poc-codex-app-server-bridge.md`（PoC v1）+ `temp/codex-runs/poc-v2-inject-items-schema.md`（PoC v2）

## 1. 决策摘要

让 Hub 通过 codex App Server JSON-RPC 协议把 IPC 消息直接推进 codex session 的 model 对话窗口·解决 codex 收 MCP `notifications/message` 不 surface model 的 issue #18056·**同时为 portfolio 部分 orchestrator 迁 codex 节省 max20x token 铺路**。

核心机制：
- codex active turn → `turn/steer` append 到 active turn·model 立即 incorporate
- codex idle → `thread/inject_items`（schema 4 严格命名）注 history·next turn surface
- CC 端 MCP `notifications/claude/channel` 路径 0 改动
- broadcast 按 session.runtime 分支扇出·CC 走 WS / codex 走 App Server

## 2. 上下文

**痛点根因**（已实证）：
1. **CC 端 MCP `notifications/claude/channel`**：CC 私有扩展·CC 客户端 SDK 注 conversation context·**CC 端 IPC 工作正常**·老板原话「CC↔CC 能正常推送」
2. **codex 端 MCP `notifications/message`**：codex CLI 走 `logging_client_handler.rs` 写 stderr tracing·**model 永远看不见**·**upstream issue #18056 OPEN since 2026-04-16·零 PR·不在 roadmap**
3. **跨 agent 兼容**：codex / Gemini / Copilot / OpenCode 不接 CC 私有扩展·必另起协议层

**老板战略 context**（2026-04-28 03:20 + 13:22 拍开干）：
- CC max20x 一周两个账号都不够用（5h 24-25% / 7d 45% / 累计 jianmu-pm $14.4 / harness $95.9）
- codex 周额度还用不完
- portfolio 部分 orchestrator session（jianmu-pm / harness / taiwei-director）迁 codex·节省 max20x token

## 3. 决定

采用 **hybrid 架构**：
- **MCP for CC**：现有 `notifications/claude/channel` 路径完全保留·0 改动
- **codex App Server bridge for codex**：Hub 加 JSON-RPC client driver·`turn/steer` + `thread/inject_items`（schema 4）解 inbound push
- **ACP for future agents**（待第 3 个 agent 加入·非本 ADR 范围）：spawn / 管理 Gemini / Copilot 等·OpenClaw acpx 模型
- **Hub sidecar 全保留**：43 项功能（16 MCP tools + 20 HTTP routes + 7 WS message types）100% cover·session metadata 加 runtime + appServerThreadId 字段·向后兼容

**schema 4 严格命名**（PoC v2 实证锚点）：
```javascript
// codex 0.125 唯一识别格式（PoC v2 [POC-V2-INJECT-4] 实证）
{
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text: '<内容>' }]
}

// schema 1/2/3 silently drop（response {result:{}} 假成功 / next turn 不 surface）
```

Hub `formatInjectItem(text)` helper 强制 schema 4·所有 inject 调用必走 wrap·禁手写 items。

## 4. 理由

### 4.1 cover 度最高（53/53 = 100%）

| 类别 | 数量 | ✅ | 🟨 | ❌ |
|------|------|----|----|----|
| 16 MCP tools | 16 | 14 | 2 (schema 扩展) | 0 |
| 20 HTTP routes | 20 | 14 | 6 (内部分支) | 0 |
| 7 WS message types | 7 | 5 | 2 (字段扩展) | 0 |
| 10 session metadata 字段 | 10 | 10（含 runtime + appServerThreadId 新增） | 0 | 0 |

详见 v0.4 §F.1-F.5。

### 4.2 短期成本最低

- CC 端 0 改动（保 MCP + 现有 channel push 工作良好）
- codex 端 codex CLI 0 改动（不需 fork upstream issue #18056）·**只在 Hub 侧加 client driver**
- 实施量 ~900-1100 行（含测试）·codex run ~1.5-2h·token ~5-8 万

### 4.3 PoC 实证

- **PoC v1**（b51e7v2u1·2026-04-28 03:31）：spawn `codex app-server --listen stdio://` + JSON-RPC client·`initialize` + `thread/start` + `turn/start` + `turn/steer` 全工作·marker `[POC-A-STEER]` mid-turn 实时 surface
- **PoC v2**（bzi77w8n4·2026-04-28 04:18）：4 档 schema 全测·**schema 4 唯一可工作**·marker `[POC-V2-INJECT-4]` next turn surface·1/2/3 silently drop

### 4.4 解决核心痛点

- codex active turn：turn/steer 实时 inject·延迟 <100ms（PoC v1 实证）
- codex idle：thread/inject_items schema 4·next turn surface（延迟 30-60s·取决 turn 触发频率）
- broadcast：Hub 按 runtime 分支 fan-out·CC + codex 各自路径

### 4.5 长期可扩展

session.runtime 字段已支持 'claude' / 'codex' / 'unknown'·未来加 'acp' 走 ACP layer·Hub 不动。

## 5. 后果

### 5.1 正面

- **解决 #18056**：不依赖 upstream PR·Hub 自己绕过
- **CC 0 回归**：MCP channel 路径 100% 保留
- **portfolio metadata 不破坏**：sidecar 字段（contextUsagePct / cost / model 等）保留
- **broadcast 全兼容**：to=* 同时含 CC + codex receiver·各自 surface
- **orchestrator 迁移铺路**：codex 当 orchestrator 配套（keepalive / outbound / handoff）配 ADR-014 后续 ship 后即可试点

### 5.2 负面

- 新增 1 个模块（codex-app-server-client.mjs ~500 行）+ 1 个新模块（codex-thread-keepalive.mjs ~200 行 Phase 2 ship）
- session.runtime + appServerThreadId 字段扩展·old client 不上报 = 'unknown'·向后兼容但需运维注意
- codex App Server 30min idle thread auto-unload·Hub 必加 keepalive 防失效

### 5.3 风险（详见 v0.4 §G + §H 兜底）

- **G.1 WebSocket experimental**：用 stdio 默认·避开
- **G.2 跨 thread broadcast 1:1**：Hub 层 fan-out·N <= 10 portfolio 体量可接受
- **G.3 30min idle unload**：Phase 2 keepalive 模块（H.3 兜底）
- **G.4 OpenAI 政策**：保留 fork 备选（H.4）+ 监控 release notes
- **G.5 跨 agent 兼容**：留 ACP layer 接口（H.5）·待第 3 agent 加入

## 6. 替代方案（已评估·拒绝）

- **A. ACP 全替 MCP**：cover 度 9/34（26%）·CC channel 失效·**不可行**
- **C. codex App Server only**：cover 度 27/34（79%）·跨 agent 不兼容·**短期可·长期受限**
- **D. fork MCP patch（codex-rs ~50 行 issue #18056 + thread/inject_items 30 行）**：cover 度 28/34（82%）·**维护 fork + 升级 rebase 高成本**·**v0.3 准备过 brief 腹稿但 PoC v2 ✅ 后撤**
- **E. polling 兜底**：5min latency·**不解决核心痛点**

详见 v0.4 §2 矩阵 + §4 trade-off 表。

## 7. 实施计划

### Phase 1·主路径 codex App Server bridge（**派 codex bg 跑·~1.5-2h**）

派单 brief：`temp/codex-briefs/phase1-codex-app-server-client-impl-brief.md`（10 节齐全·v0.4 §E 真行号 + 改前/改后伪代码 + schema 4 强制 + 测试 + 5 件套）

实施：
1. `lib/codex-app-server-client.mjs` 新建（~500 行 JSON-RPC 2.0 client + formatInjectItem 强制 schema 4）
2. `hub.mjs:477-483` register 加 runtime + appServerThreadId
3. `mcp-server.mjs` register payload 加 runtime（resolveRuntime 三档 fallback）
4. `lib/router.mjs:329 routeMessage` 加 runtime 分支
5. `lib/router.mjs:121 broadcast → broadcastWithRuntime` 同上分支
6. `lib/router.mjs` 新增 `pushViaAppServer` + `formatInjectItem` helper
7. `mcp-server.mjs:spawnSession` codex 分支扩展·spawn 主进程后另起 app-server 子进程
8. `tests/codex-app-server-client.test.mjs` 单元测试（~150 行）
9. `tests/integration/codex-inbound-push.test.mjs` 集成测试（~100 行·AC-1/2/4）

TDD 双 commit：
- RED `test(ipc): codex App Server client failing tests`
- GREEN `feat(ipc): codex App Server client + runtime branch routing`

5 件套同步（feat 触发硬规矩）：TODO.md + PROJECT-PLAN.md

### Phase 2·orchestrator readiness 配套（**Phase 1 GREEN 后立即启**·~3h 总）

- **K.A keepalive 模块** `lib/codex-thread-keepalive.mjs`（派 codex 1 run·1.5h·~200 行）：每 25min 对 codex thread 发轻量 turn/start `"keepalive ping"` + 立即 turn/interrupt·防 30min unload
- **K.B AC-11 outbound 实证**（jianmu-pm 自做 PoC·30min·~5k token）：活体测 codex MCP outbound tool call（ipc_send / ipc_recent_messages / ipc_spawn）
- **K.C atomic handoff SOP**（jianmu-pm 自做·1h·0 token）：thread/fork mapping ADR-010 5 步·写 `domains/software/CLAUDE.md`

### Phase 3·集成测试 + AC 跑（jianmu-pm + harness 协作·~5-7h）

跑 AC-1 ~ AC-11（v0.4 §I）：active turn steer / idle inject schema 4 / broadcast / CC 0 回归 / spawn 双进程 / fail-over inbox / 性能 200ms / 安全 stdio / dogfood 24h / schema 4 reproduction / outbound 实证。

### Phase 4·dogfood 试点（jianmu-pm 第 1 试点·1 周）

- jianmu-pm 自己迁 codex orchestrator·非关键路径 + context 中等 + 风险可控
- 1 周 dogfood·收集失败模式·迭代 keepalive
- 后续 2-3 试点（harness / taiwei-director）依试点 1 结果

## 8. 验收标准

11 条 AC（v0.4 §I·每条 prepare→execute→expected→FAIL 字符串级）：

- AC-1 codex active turn 收 IPC·turn/steer 实时 inject
- AC-2 codex idle 收 IPC·thread/inject_items schema 4 + next turn surface
- AC-3 broadcast (to=*) 同时含 CC + codex
- AC-4 CC ↔ CC IPC 现有路径 0 回归
- AC-5 codex spawn 双进程 + thread/start
- AC-6 App Server 异常·fallback inbox 不丢消息
- AC-7 性能·active turn IPC 推送延迟 <200ms
- AC-8 安全·stdio 默认·不暴露未授权 WebSocket
- AC-9 portfolio 24h dogfood
- AC-10 schema 4 reproduction（PoC v2 锚点）
- AC-11 codex MCP outbound tool call 实证（orchestrator readiness 假设验证）

## 9. 时间消耗 + token 估算

| 阶段 | 责任 | ETA | token |
|------|------|-----|-------|
| ADR-014 起草 | jianmu-pm（已完成 13:55） | 30min | 0 |
| Phase 1 brief 起草 | jianmu-pm（已完成 13:48） | 8min | 0 |
| Phase 1 实施 | 派 codex 1 run | 1.5-2h | ~5-8 万 |
| Phase 2 K.A keepalive | 派 codex 1 run | 1.5h | ~3 万 |
| Phase 2 K.B AC-11 PoC | jianmu-pm 自做 | 30min | ~5k |
| Phase 2 K.C handoff SOP | jianmu-pm 自做 | 1h | 0 |
| Phase 3 集成 + AC | jianmu-pm + harness | 5-7h | ~4 万 |
| Phase 4 dogfood 试点 1 | portfolio + jianmu-pm | 1 周 | ~3 万/周 |
| **总（前 3 Phase）** | | **~5-7h** | **~15-20 万** |

## 10. ROI（v0.4 §L）

- **现状**：portfolio 9 session 5h block 50-80% / 7d 50-60%·两 max20x 不够
- **迁 1 orchestrator**：节省 10-20% CC 5h block
- **迁 3 orchestrator**：节省 30-50% CC 5h block
- **codex 周额度**：当前 0%·迁 3 后 ~30-50%·仍有余量
- **payback 周期**：< 1 月·年省 $2400-3600

## 11. 5 件套同步

- 本 ADR 落 `docs/adr/014-...`·**不** trigger 5 件套（非 feat/fix/refactor）
- Phase 1 commit type=feat → trigger TODO + PROJECT-PLAN
- Phase 2-3 各 commit 同步

## 12. 角色到人

| 阶段 | 责任 |
|------|------|
| 评估 doc v0.1-v0.4 | jianmu-pm（已完成） |
| harness 审 | harness（已完成 04:25 v0.4 通过） |
| 老板拍板 | 老板（已 13:22 拍开干） |
| ADR-014 起草 | jianmu-pm（本文档·已完成） |
| Phase 1 实施 | 派 codex（jianmu-pm 出 brief + AC） |
| Phase 2 K.A keepalive | 派 codex |
| Phase 2 K.B / K.C | jianmu-pm 自做 |
| Phase 3 集成 + AC | jianmu-pm + harness |
| Phase 4 dogfood 试点 | jianmu-pm 第 1 试点 + portfolio |

## 13. 相关

- 评估文档：`docs/research/IPC-INBOUND-PUSH-ARCH-EVAL-V01.md` v0.4
- PoC v1：`temp/codex-runs/poc-codex-app-server-bridge.md`
- PoC v2：`temp/codex-runs/poc-v2-inject-items-schema.md`
- Phase 1 brief：`temp/codex-briefs/phase1-codex-app-server-client-impl-brief.md`
- ADR-009：MCP initialize race（前置·channel notification 冷启 race 已修）
- ADR-010：atomic handoff（lineage 切换 SOP·codex orchestrator 复用）
- ADR-011：statusline push（独立 sidecar·不受影响）
- ADR-013：ccusage 集成（成本评估 §10 数据来源）
- 上游 issue：https://github.com/openai/codex/issues/18056（不依赖此 PR）

---

— jianmu-pm · 2026-04-28T13:55+08:00 · ADR-014 v0.1 起草
