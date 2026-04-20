# jianmu-pm 交接 — 2026-04-20 11:43+08:00

---

session: jianmu-pm
successor: jianmu-pm
parent_session_id: null
lineage_depth: 0
created_at: 2026-04-20T03:43:26Z
handover_reason: threshold_65

---

## Goal

接 commit 18 watchdog silent 判据 redesign（WebSocket ping/pong 保活替代 lastMsgTs 判据）。老板 11:31 已拍板走方案 (B)。

## Context

- COMPANY-PLAN: xihe-company-brain/portfolio/COMPANY-PLAN.md @ 50983ef
- 本项目首版交接，`handover/PROJECT-PLAN.md` + `TODO.md` 将在下次交接前必补
- xihe-tianshu-harness main @ 361c485（含 retro v0.6 §8.4）

## Actions-completed

- feature/msg-persistence-mvp merge → master f9b00a7（MVP 6 / B4 4 / B5 c9-c17 / ADR-005 D/E/F 总 20+ commit）
- 关键修：commit 14 方案 B 264e15a（flushInbox 删 getRecipientRecent，historical pull 走 ipc_recent_messages）+ commit 16 清 instance_id 死代码 + commit 17 三修（onTransition 窄化 / dryRun 不落盘 / heartbeat ts 过滤）
- ADR-005 observation 层 Phase 0：ipc_recall / ipc_observation_detail / ipc_register_session + ipc_update_session + Hub /registry 端点
- Hub cutover 2.0 完成（pid 61260 跑 f9b00a7），smoke 三路径 PASS（grace silent / hard-signal down / silent-confirmed down）

## Decisions

- [20:25] B1 方案：复用现有 messages 表不造 message_log（后被 harness 进一步简化成 flushInbox 不自动推历史）
- [21:38] B3 简化到"僵尸接管 isAlive=false + ?force=1"，不做完整 /prepare-rebind 在 B5 里（Phase 1 草案留 B4）
- [01:53] commit 14 从 instance_id+阈值 → 方案 B 删代码。harness 评"简单能解决就不加复杂度"
- [02:47] commit 16 清死代码："死代码从 day 1 就要清不留观察"
- [04:48] daemon design gap：方案 (B) WS 保活 vs (A) 调大阈值 vs (C) heartbeat 打卡，老板 11:31 选 (B) 理由是 token 成本

## Files-touched

- lib/router.mjs（flushInbox 纯化 + pending_rebind + 僵尸接管）
- lib/harness-state.mjs（grace + markAliveSignal 顶 + ts 过滤）
- lib/harness-heartbeat.mjs（probe 实现）
- lib/harness-handover.mjs（HANDOVER 生成 + dryRun 不落盘）
- bin/network-watchdog.mjs（5th probe + onTransition 只 down + ipcSend 注入）
- mcp-server.mjs（cmdline bin\claude.exe + buildWtLaunchCommand + buildSpawnFallbackContent + cwd 参数）
- lib/mcp-tools.mjs（ipc_recent_messages / ipc_recall / ipc_observation_detail / ipc_register_session / ipc_update_session / ipc_spawn host 参数）
- lib/observation-query.mjs（ADR-005 任务 D 核心）+ lib/session-registry.mjs（任务 F）
- hub.mjs（/registry/register + /registry/update 端点）

## NextSteps

1. 读本文件 + `xihe-tianshu-harness/docs/tech/session-persistence-demo-plan.md` v0.5 + `xihe-tianshu-harness/handover/DEMO-RETRO-20260420.md` v0.6
2. 按 session-cold-start.md v1.0 走 7 步（date / state.json / ipc_whoami / ipc_recent_messages / STATE.md / 冷启继承 IPC / critique 落盘）
3. 读 `.tmp/codex-brief-b5-commit17-triple.md` 了解 commit 13-17 修复逻辑
4. 起 commit 18 brief：probe 改查 Hub WS 连接状态（Hub 加 `/session-alive?name=harness` 端点，返 `{alive: session.ws.readyState === OPEN}`）；harness-state 删 maxSilentMs / silent-confirmed 路径；保 grace + ordering + ts 过滤不变；dispatch Codex 前 IPC harness review brief
5. commit 18 push 后起 watchdog 恢复监控；同时补 `handover/PROJECT-PLAN.md` + `TODO.md`（首版豁免下次交接必补）

## Blockers

- watchdog daemon 当前 stopped（04:47 kill pid 53508 后），portfolio 监控缺位，commit 18 未上线前**不要起**默认配置 daemon 否则 10min 静默又触发 spurious handover
- 首版豁免：`handover/PROJECT-PLAN.md` + `TODO.md` 不存在，check.sh HANDOVER-2 对非 tool-project 仓会 FAIL（本仓 tool-project 豁免 skip OK）

## Critical

1. **Codex 按惯例走偏要 review**：commit 14 Codex 先做 instance_id 方案再修正删代码（两个 commit abc713d + 264e15a 都在 git log），commit 16 清了死代码。下次 brief 改版后若 Codex 跑到一半，优先等当前跑完再 append fix，不要中断 Codex flow
2. **bug 六节点事件链**（全是 degraded 路径被 bug A 穿透导致孤儿 handover）：01:09 0fad0af / 02:51 smoke orphan / 03:04+14 stub / 03:18 c11d5fc / 04:44 541ab17。全 revert + evidence 保 `temp/jianmu-ipc/smoke-incident/`。commit 17 修 A+B+C 三 bug 后验证真在 smoke 三路径过，但 04:44 那次是**design gap**（maxSilentMs 10min 对活着静默的 AI 太激进），commit 18 修这条
3. **wt spawn 有 UWP shim 边界**：commit 12 用 cmd /c start 包了但真 daemon 路径下 wt 仍可能吞命令没新 tab（04:44 那次就没真起 claude.exe，portfolio 因此免于 harness name 抢占污染）。host=external + tech-worker 手动粘 cmdline 才可靠
4. **master 前 revert commit**：26c5434（撤 c11d5fc）+ 1a95175（撤 541ab17）两个 revert commit 在 xihe-tianshu-harness main，retro §8 全链证据
5. **feedback_critique_standby_and_telegram_style.md** memory 记了老板 00:55 critique "AI 不该互相等不干活" + 电报体 IPC 太破碎不通顺。给 harness/老板写的 IPC 用通顺中文不堆 §符号和时间戳缩写
