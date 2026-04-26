# 交接文档·建木项目经理 jianmu-pm · 2026-04-26T18:35+08:00

> **触发**：周限额 99%·随时切账号
> **交接对象**：新账号下的 jianmu-pm（lineage 10）
> **本任期 lineage**：上次 lineage 8（2026-04-25T15:17 上线，session-state last_breath 2026-04-25T15:17:57+08:00）→ lineage 9（2026-04-26T17:46+08:00 cold start）

---

## 一、cold start 第一动作清单

接手立刻按顺序执行：

1. `date -Iseconds` 拿真实时钟
2. `cat ~/.claude/session-state/jianmu-pm.json` 读 last breath
3. `ipc_whoami` + `ipc_sessions` 确认 Hub + 在线清单（预期 ≥ 7：harness/network-watchdog/jianmu-pm/4 太微+ 切账号后第二波 5 个）
4. `ipc_recent_messages since=24h` drain 消息
5. 读本文 + `xihe-tianshu-harness/handover/HANDOVER-HARNESS-20260426-1710.md`（harness 视角）+ `RESEARCH-vscode-session-spawn-20260426.md`
6. IPC harness 自报上线 + 询问下一步派单
7. drain 到 user critique → 落 memory

---

## 二、本任期 in-flight 工作总览

### 2.1 已 ship（lineage 9，17:46-18:35 累计 ~50 分钟）

| 工作 | SHA / 路径 | 内容 |
|---|---|---|
| P1 VSCode R&D 报告 | `xihe-jianmu-ipc/handover/RESEARCH-vscode-session-spawn-20260426.md` | 4 路径对比 + URI handler 实证 + ipc_spawn host=vscode-uri 增强方案 |
| 4a IPC Hub 视角 patch | tianshu `2e235a5` | §十 24h 消息流量 + 4 owner 时序 + Hub 触达延迟 + 月报字段建议 |
| 4b §3.1 spawn 时刻填入 | tianshu `2e235a5` | 第一波 4 session connectedAt 实测 + 路径 B 验证 |

### 2.2 等待中

| 项 | 阻塞条件 | 我侧准备 |
|---|---|---|
| P0 spawn 9 session 第二波 | 切账号后老板手动 spawn 5 个（architect/designer/frontend/backend/auditor-portfolio）| 不做协调，等 harness 派单 |
| ipc_spawn host=vscode-uri 实施 | 老板拍板转 Accepted | 设计已在 RESEARCH 报告 §5.2-5.3，预计 1-2h 派 codex 即可 |
| 4 太微新 session IPC 自报上线后跟进 | 4 session 各自 cold start 完成 | 不主动催（peer 关系，feedback_no_peer_command）|
| ADR-006 v0.3 五信号 AND 实施 | 老板拍板转 Accepted | 设计已 ship `96ee9d4`，等触发后建木派 codex 走步骤 6-10 |
| VSCode 报告未验 4 项 | 手工实测（开 VSCode 即可）| 4 项见 RESEARCH 报告 §八，3-5 分钟可清 |

---

## 三、当前 portfolio 在线状态（17:57 取样）

| session | 类型 | 状态 |
|---|---|---|
| `harness` | 治理 | lineage 9（17:30 上线）|
| `jianmu-pm` | 治理 | 本 session（17:46 上线）|
| `network-watchdog` | 治理 | 100h+ uptime · state=down (cliProxy 502 假阳性，hub/anthropic/dns 全 ok) |
| `taiwei-director` | 业务（试行）| 17:56:09 上线 + 等 IPC 自报 |
| `taiwei-pm` | 业务（试行）| 17:56:43 上线 + 等 IPC 自报 |
| `taiwei-tester` | 业务（试行）| 17:56:57 上线 + 等 IPC 自报 |
| `taiwei-reviewer` | 业务（试行）| 17:57:11 上线 + 等 IPC 自报 |

**第二波 5 session 切账号后 spawn**：architect / designer / frontend / backend / auditor-portfolio

---

## 四、关键参考文件（按读取优先级）

| 优先级 | 文件 | 用途 |
|---|---|---|
| P0 | 本文 | 自我接手指引 |
| P0 | `xihe-tianshu-harness/handover/HANDOVER-HARNESS-20260426-1710.md` | harness 视角 portfolio 状态 |
| P0 | `xihe-tianshu-harness/handover/adr/ADR-007-TAIWEI-9-SESSION-ROLE-ARCHITECTURE-TRIAL.md` | 9 session 试行 ADR |
| P1 | `xihe-tianshu-harness/handover/adr/ADR-006-PORTFOLIO-ECONNRESET-AUTO-RECOVERY.md` v0.3 | 网络断连自动接续，等老板拍板转 Accepted 我侧实施 |
| P1 | `xihe-jianmu-ipc/handover/RESEARCH-vscode-session-spawn-20260426.md` | VSCode R&D，老板拍板可立即派 codex 实施 |
| P1 | `xihe-jianmu-ipc/handover/ADR-009-RATE-LIMIT-AUTO-WAKE-DESIGN.md` v0.3 | 周限额自动接续，已 ship `384a85e` |
| P1 | `xihe-tianshu-harness/handover/case-study/opc-v2.2-emergency-response-20260426.md` v0.1.1 | 紧急响应案例，§十 我 patch |
| P2 | `xihe-tianshu-harness/handover/case-study/taiwei-9-session-trial-20260426.md` v0.1.1 | 9 session 试行案例，§3.1 我 patch |
| P2 | `~/.claude/projects/D--workspace-ai-research-xiheAi/memory/MEMORY.md` | 用户记忆索引 |

---

## 五、本 session 网络看门狗 anomaly（已 IPC harness）

**症状**：
- `curl http://127.0.0.1:3180/status` 返回 `state=down` `failing=["cliProxy"]`
- cliProxy 探测 HTTP 502
- hub / anthropic / dns 全 ok
- harness.lastTransition 是 4 天前的 stale（1776949514530），但 lastProbe ok=true

**判断**：
- cliProxy 502 是常见假阳性（CLI proxy 偶发），不阻塞
- harness 状态机滞后未刷新，但 ws 实际 OPEN
- ADR-006 v0.3 五信号 AND 设计正在解决这类问题

**新 lineage 不要**：
- 看到 state=down 就 panic
- 主动 kill watchdog 或 harness（feedback_no_kill_node）
- 误触 self-handover（cold-start grace 应覆盖）

---

## 六、git 身份与提交规范（务必）

- xihe-jianmu-ipc + xihe-tianshu-harness 仓 git 身份：`Xihe <xihe-ai@lumidrivetech.com>`
- 提交不加 AI 署名 / 不加 Claude trace
- 推送到 xihe-forge org（不是 47Liu）
- commit 后**直接 push 不问**（feedback_auto_push）
- 文档用中文 + 九段式（人类可读决策文档规范 v1.0 `330e4b2`）

---

## 七、版本

| 版本 | 日期 | 变更 |
|---|---|---|
| 1835 | 2026-04-26T18:35+08:00 | jianmu-pm lineage 9 切账号前最后落档 · in-flight 总览 + 在线状态 + 关键文件 + watchdog anomaly |
| 1900 update | 2026-04-26T19:00+08:00 | lineage 9 实质工作收尾 update（提前通用·切账号信号未到但工作基本结束）|

---

## 八、lineage 9 实质工作 final 总览（19:00 update）

### 8.1 已 ship（push xihe-forge）

| SHA | 仓 | 内容 |
|---|---|---|
| 2e235a5 | tianshu | case-study 4a §十 + 4b §3.1 IPC Hub 视角 patch |
| 20afbac | jianmu | self-handover + VSCode R&D（17:54 报告）|
| 9f6d2d4 | jianmu | ADR-006 v0.3 codex brief draft |
| 9c331a9 | jianmu | cliProxy 502 anomaly 根因 + 修复方案 |
| e614e47 | jianmu | VSCode URI 4 项验证报告 |
| **d78b339** | jianmu | **cliProxy probe 修复 GET /healthz**（E.2 ship · 14/14 测试）|
| **20ca6b7** | jianmu | **ADR-006 v0.3 STEP6 session-state-reader**（E.1 ship · 5/5 测试）|
| **3580f6b** | jianmu | **ADR-006 v0.3 STEP7 stuck-session-detector 5-signal AND**（12/12 测试）|
| **d7c5c1d** | jianmu | **revert v0.2 stale-suspend-detector** |
| **b1d396c** | jianmu | **watchdog 接 stuck-session-detector** |
| ⏳ 跑中 | jianmu | **B vscode-uri 一键 spawn 实施**（codex `bg6lccz4s` 18:55 起·预计 19:15 ship）|

### 8.2 lineage 9 元自纠总结（lineage 10 警示）

lineage 9 同日内**累计 5 个反 idle / 反漂移 memory**：
- feedback_codex_sandbox.md §3 场景接力 + §preflight 5 项（jianmu-pm 立·flag 误用 3 次复刻）
- feedback_timestamp_format.md §lineage 9 二次复刻（auditor-portfolio 18:14 catch +38min 偏差）
- feedback_ai_pace_not_human_pace.md（harness 立·portfolio 硬规矩·3 个感叹号 critique）
- feedback_treat_decided_as_pending.md（harness 立·拍板当待拍板 anti-pattern）
- 各 session 高密度元失职 = critique 触发新 memory + 缺 dispatch 前 own / peer 刚立 memory 自检

### 8.3 lineage 10 必读警示（接 §五 watchdog anomaly）

**flag dispatch 反例避坑**：
- 派 codex 命令模板（v0.124+）：`codex exec -s danger-full-access "<prompt>" < /dev/null > logs/...log 2>&1`
- **不要**：`--full-auto` 与 `-s danger-full-access` 并用（line 21）
- **不要**：`--ask-for-approval`（v0.124+ 已移除）
- **必跑**：dispatch 前 §preflight 5 项（含 codex --help 自验 flag）

**memory↔memory 漂移检测**（harness 18:57 立项）：
- dispatch / IPC peer / 给老板汇报前必 grep 自己 + peer 最近 1 小时立的 memory 自检
- 与 SOP §preflight 第 5 项 codex --help 自验同源
- 防 lineage 9 同日 memory 引用过时 memory 的 3 次复刻

### 8.4 双 codex AI 节奏数据点（case-study 4a §十 后续 patch 用）

| 任务 | codex 跑 | 接力 commit | 总 cycle | token |
|---|---|---|---|---|
| cliProxy probe | 17min（含 stdin 重派）| 3min | 17min | 67.6k |
| ADR-006 v0.3 第一波 | 10min | 3min | 13min | 161.9k |
| B vscode-uri | ⏳ 跑中（v2 第二派） | - | - | - |

= AI 节奏比 brief 原估（~2h）快 4-9×。flag 误用 3 次复刻成本：cliProxy 17min + ADR-006 10min + vscode-uri v1 <1min = 总 ~28min 浪费（可下 lineage 完全避免，SOP §preflight 5 项立后归 0 是 KPI）。
