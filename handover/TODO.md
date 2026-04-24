# xihe-jianmu-ipc · TODO

> IPC 基础设施 repo 的活清单。按优先级分段。所有条目有明确"现状 / 目标 / 验收 / Owner / ETA"。

**最后刷新**：2026-04-24T12:50+08:00（jianmu-pm）
**刷新节奏**：每次重要产出 + 每周一 portfolio-sync

---

## 0. 这份文档怎么看（30 秒入门）

如果你是刚接手的 session 或刚加入的人类，先读这段。

### 关键词速查

| 词 | 是什么 |
|---|---|
| jianmu-pm | 本 repo 主 session，IPC Hub owner |
| Hub | WebSocket server 跑在 `localhost:3179`，协议入口 |
| Watchdog | `bin/network-watchdog.mjs`，5 项 probe，跑在 `:3180` |
| MCP 工具 | 14 个 ipc_* 工具，通过 mcp-server.mjs 注入 Claude Code / OpenClaw |
| release-rebind | 显式接力，旧 session prepare → 让位，新 session 继承 topics + buffered |
| force-rebind | zombie 隐式接管，只回放 SQLite inbox 不恢复 topics |
| reclaim | `ipc_reclaim_my_name` 2026-04-24 新上线，自助回收同名 zombie 占位 |
| commit 18 | 2026-04-21 watchdog Hub WS 保活改造，cutover 2026-04-22 闭环 |
| v0.5.0 | 下一版本，Phase 1-4 代码已 implemented @ 2026-04-19，等 cut release |
| dependabot | 9 个漏洞 @ 2026-04-21（1 high / 8 moderate），base 存量 |

### 优先级含义

- **P0**：当前焦点，每天看
- **P1**：本周内（截止当前刷新日 + 7 天，即 2026-05-01 前）
- **P2**：两周内
- **P3**：一个月内
- **P4**：筹备 / 观察 / 等外部条件

### 每条 task 字段

- **现状**：当下卡在哪 / 已经做了什么
- **目标**：要达到什么 verifiable 状态
- **验收**：怎么算"做完了"，可机械判定
- **Owner**：谁主做（+ 谁审 + 谁配合）
- **ETA**：截止日

---

## P0 当前焦点

### ADR-008 Phase 2 · session-cold-start.md v1.3 切换

- **现状**：2026-04-24 12:46 reclaim merge master 90590a4，工具上线。harness 12:49 回执承诺本回合直做 `xihe-tianshu-harness/domains/software/knowledge/session-cold-start.md` v1.2 → v1.3：删场景 B "工具未上线兜底"段 + changelog 标 reclaim merge 90590a4 工具上线
- **目标**：v1.3 落档，场景 B 标准路径单一指向 `ipc_reclaim_my_name()`，无兜底分支；ADR-008 doc Phase 1 DONE 段已在 2026-04-24 12:46 本仓更新
- **验收**：xihe-tianshu-harness 仓 `domains/software/knowledge/session-cold-start.md` 搜索"工具未上线"命中 0；v1.3 版本号出现在文档顶部
- **Owner**：harness 主做 · jianmu-pm 审
- **ETA**：2026-04-24（当日内）

---

## P1 本周内（2026-05-01 前）

### ADR-008 Phase 3 · 实地 cold-start 场景 B 演练

- **现状**：工具上线 + 规范切换完成后，需要一次真实环境下的"旧 session zombie → 新 session reclaim → inbox 回放"端到端演练。目前只有 unit 7 + integration 3 mock 级别验证
- **目标**：选一个软件 session（yuheng 或 houtu）做 cold-start 场景 B 复现：mock zombie → 新 session 起时 `ipc_reclaim_my_name(name)` → 验 evict + force-rebind 继续走 inbox 回放
- **验收**：演练 session 产出一份简报（类似 retro §8.5 格式）落在 `handover/` 下；harness 独立核对；演练通过后 ADR-008 Phase 3 标 DONE
- **Owner**：jianmu-pm 主组织 · harness 审 · 演练 session 执行
- **ETA**：2026-04-30（绑 xihe-tianshu-harness TODO P1 bug 8 portfolio-boot 联合修法）

### bug 2 self-handover 瘦身设计稿 v0.2 review

- **现状**：2026-04-23 11:47 harness 发 `xihe-tianshu-harness/handover/DESIGN-bug-2-self-handover-slim.md` v0.1 review 请求。11:51 harness 通知今晚出 v0.2（tech-worker 提的 actions_24h 字段缺失 / state.json 当档案 + HANDOVER 当窗口的修法 / baseline 冗余可压框架三处 gap）。设计稿 §5 Step 2 state.json schema 扩展撞 ipc_reclaim_my_name（已 merge）同周，验证过无重叠
- **目标**：review v0.2 的 §3 state.json schema 扩字段（recent_decisions / promised_to_others / open_questions_for_successor / actions_24h）+ §5 Step 2 Hub 持久化层改动接口 + §6 异步协调 race condition 兜底 + §7 open question 4 sessions-registry 状态机
- **验收**：jianmu-pm 给出 review 意见（LGTM / 改动单）；harness 落 v1.0
- **Owner**：harness 主出 v0.2 · jianmu-pm 审
- **ETA**：2026-04-28

### v0.5.0 release cut

- **现状**：v0.5.0 Phase 1-4 代码 @ 2026-04-19 implemented；commit 18（2026-04-21）+ reclaim-my-name（2026-04-24）作为补丁特性一并入 release。package.json 当前 `0.4.1`。CHANGELOG.md [Unreleased] 段有累积改动未 tag
- **目标**：cut v0.5.0 tag + push GitHub + dependabot 漏洞清零前置链路打通
- **验收**：`git tag v0.5.0 + push` 可见；CHANGELOG [Unreleased] → [0.5.0] 切换且 diff 链接更新；GitHub Releases 页面有 v0.5.0 entry
- **Owner**：jianmu-pm 主做 · harness 审 /release-check 门禁
- **ETA**：2026-04-30（v0.5.0 稳定 1-2 天后再开 v0.6.0）

---

## P2 两周内（2026-05-08 前）

### dependabot 9 漏洞清理（1 high / 8 moderate）

- **现状**：2026-04-21 GitHub 推 master 后 dependabot 报告 9 项。base commit 3916bb9 就有这些漏洞，commit 18 + reclaim-my-name 未引入新漏洞。xihe-tianshu-harness TODO P3 同条目 Owner=jianmu-pm ETA=2026-05-07
- **目标**：`npm audit` 返回 0 漏洞
- **验收**：依赖升级 PR（或 dependabot 自动 PR）合入 master 后 `npm audit` 报告 0 漏洞；`npm test` 仍 545/545 全绿无回归
- **Owner**：jianmu-pm 派 Codex 升级依赖 · harness 审
- **ETA**：2026-05-07

---

## P3 一个月内（2026-05-24 前）

### Hub `/health` uptime 7 天基线测量

- **现状**：没有系统性 uptime 数据，只有 cutover 时 1h 观察期数据
- **目标**：跑 7 天基线后给出 Hub `/health` + WebSocket connection 稳定性统计（断连次数 / auto-restart 触发次数 / 消息持久化丢失率）
- **验收**：落档 `handover/HEALTH-BASELINE-20260500.md`（形式参考 xihe-tianshu-harness DEMO-RETRO-* 格式），harness 审
- **Owner**：jianmu-pm · network-watchdog 协助
- **ETA**：2026-05-24

### 探索方向评估 · 独立调度 agent 立项

- **现状**：ROADMAP 里 Phase 10/11 明确"不在 Hub 加逻辑"，留给独立 agent 通过 IPC 实现。当前全 portfolio 任务分配是手动 `让{agent}去{task}` 飞书命令
- **目标**：评估是否需要立项独立调度 agent（subscribe 各 agent 状态 → 自主决策任务分配 → `ipc_send` 下发）。若值得做则起立项 brief
- **验收**：落一份 feasibility note 到 `docs/exploration/scheduler-agent-feasibility.md`，老板裁定开/不开立项
- **Owner**：jianmu-pm 起 brief · 老板拍板
- **ETA**：2026-05-20

---

## P4 筹备 / 观察

### OpenClaw ClawHub 整合（被动等外部条件）

- **现状**：`SKILL.md` 已定义 OpenClaw ClawHub 消费 IPC 工具清单；OpenClaw 侧 WhatsApp/桌面自动化走 Gateway 并透过 Hub 路由。实际 E2E 链路未做过压测
- **目标**：等 OpenClaw 3D 桌宠（pc-pet-builder）或 WhatsApp 自动化扩用时，做 1 次 end-to-end IPC 接入验证
- **Owner**：openclaw 主 session · jianmu-pm 接入支持
- **ETA**：等 OpenClaw 那边排期

### 飞书控制台指令扩展（按需）

- **现状**：已支持 7 种命令（状态/帮助/派发/广播/重启/消息记录/日报）+ 审批卡片按钮。Phase 8.5 原"日报 cron 定时推送 + 卡片形式历史消息"已标已完成
- **目标**：等老板或新 portfolio 需求触发时再加指令（如"谁在摸鱼" / "本周 ship 列表"等）
- **Owner**：按需
- **ETA**：无

---

## 已完成（按日期倒排，最近 14 天）

### 2026-04-24

- [x] ipc_reclaim_my_name MCP 工具 + /reclaim-name Hub endpoint ADR-008 Phase 1 DONE（master HEAD 90590a4，+654/-3，545/545 tests，Codex+jianmu-pm+harness 三签 LGTM）
- [x] handover/PROJECT-PLAN.md + TODO.md 首版补齐（兑现 2026-04-20 handover-20260420-jianmu-pm.md §NextSteps 第 5 条承诺）

### 2026-04-21

- [x] commit 18 merge master · watchdog Hub WS keepalive 存活判据（HEAD=4b51f29，16 files / +567 / -406；三方 review 闭环）

### 2026-04-20

- [x] feature/msg-persistence-mvp merge master（f9b00a7，MVP 6 + B4 4 + B5 c9-c17 + ADR-005 D/E/F 共 20+ commit）
- [x] ADR-005 observation 层 Phase 0（ipc_recall / ipc_observation_detail / ipc_register_session + ipc_update_session + /registry 端点）
- [x] Hub cutover 2.0（pid 61260 跑 f9b00a7，smoke 三路径 PASS）

### 2026-04-19

- [x] v0.5.0 Phase 1-4 全部 implemented（docs/planning/v0.5.0-phase-plan.md）

---

## 刷新记录

| 时间 | 操作人 | 操作 |
|---|---|---|
| 2026-04-24T12:50+08:00 | jianmu-pm | 首版 TODO，接 handover-20260420-jianmu-pm.md §NextSteps 第 5 条"PROJECT-PLAN.md + TODO.md 下次交接前必补"承诺；P0 装 ADR-008 Phase 2 / P1 装 Phase 3 + bug 2 v0.2 review + v0.5.0 release cut / P2 装 dependabot 9 漏洞 / P3 装 uptime 基线 + 调度 agent 评估 / P4 装 OpenClaw 整合 + 飞书控制台指令扩展 |
