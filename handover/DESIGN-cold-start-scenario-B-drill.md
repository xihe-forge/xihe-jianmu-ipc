# DESIGN · ADR-008 Phase 3 cold-start 场景 B 实地演练

**日期**：2026-04-25
**作者**：jianmu-pm
**状态**：草案 v0.1 · 等 harness review + portfolio session 选取演练对象
**前置**：ADR-008 Phase 1 reclaim 工具 ship（90590a4 master）+ Phase 2 `session-cold-start.md` v1.3 切换
**目标 ETA**：2026-04-30（绑 xihe-tianshu-harness TODO P1 bug 8 portfolio-boot 联动）

---

## 1. 目的

ADR-008 Phase 1 的 reclaim 工具 + Phase 2 的规范文档切换都基于 unit / integration mock 级别验证（545/545 pass）。Phase 3 演练通过**真实 portfolio session 在真实 Hub 环境**走一次 zombie 死锁 → 自助回收 → 重连 → inbox 回放的端到端流程，得到三方面证据：

1. **mock 之外的边界**：真实 WebSocket pong 时序 / 真实 mcp-server 重连流 / 真实 inbox 回放是否含未覆盖 case
2. **AI 调用人体工程学**：被演练 session 在 cold-start 7 步（`session-cold-start.md` v1.5）流程里调 `ipc_reclaim_my_name(name)` 是否自然、是否需补规范说明
3. **Hub-side audit 链路**：`/reclaim-name` audit log + `push_deliver` audit + `ack_received` audit 三层是否给出可读演练复盘材料

不通过演练 = 工具上线但缺真场景验证证据，下次真出 zombie 死锁还是会乱。

---

## 2. 前置条件（必满足才演练）

| 前置项 | 验收 | 状态 |
|---|---|---|
| reclaim 工具 ship | `git log master \| grep 90590a4` | ✅ 已合 |
| 规范 v1.3 切换 | `xihe-tianshu-harness/domains/software/knowledge/session-cold-start.md` `搜"工具未上线"命中 0` | ✅ harness 2026-04-24 完成 |
| Hub 在线 + audit 三层 active | `curl /health` ok + push_deliver / ack_received audit log 可见 | ✅（已含 e37df5b + 3e64309） |
| 演练对象 session 同意 + 工作可中断 | 该 session 当时无 in-flight 长任务，可承受 ~10min 中断 | 待协商 |
| 备份与回退预案 | 演练失败时手工恢复路径明确 | 见 §7 |
| 老板/harness 知情 | 演练时段 IPC 通知 portfolio，避免误判网络故障 | 演练前 30min 广播 |

---

## 3. 演练对象候选

按 "可中断 + 工作量轻 + 历史无 zombie 事故" 三标准挑：

| 候选 | 适用度 | 备注 |
|---|---|---|
| **yuheng_builder** | ⭐⭐⭐ 推荐 | 主驱治理文档，演练时无 in-flight 测试 / Codex；工作可中断；与 jianmu-pm 协同最熟 |
| houtu_builder | ⭐⭐ 可选 | 内容运营自动化系统；演练时若有 cron 内容发布需 hold |
| heartread | ⭐⭐ 可选 | TDD retrofit 推进中，但单测试粒度短可错峰 |
| pc-pet-builder | ⭐ 不推荐 | 9 Codex 并发 + Stryker 长任务，中断成本高 |
| taiwei_builder | ⭐ 不推荐 | F39 Phase 2 PRD 推进中，long-context 中断浪费 |
| harness | ❌ 禁用 | 治理层 session，演练失败会拖累 portfolio 监督；harness self-handover 已有自己 P1 路径不混合 |

**默认推荐 yuheng_builder**，由 harness 协商最终确认。

---

## 4. 演练流程（10 步 · 含监控点）

### Phase A · 准备（演练 T-30min）

#### Step 1 · 演练公告
- **动作**：harness 广播 portfolio：`【演练】<演练对象> ADR-008 cold-start 场景 B reclaim 演练，T-30min。期间该 session WebSocket 临时离线 ~3min，IPC 仍可通过 jianmu-pm/harness backup 路径。`
- **目的**：避免演练触发其他 session 的"name conflict / SSH 断 / Hub 异常"误判广播

#### Step 2 · 演练对象冷启 baseline
- **动作**：演练对象走完 `session-cold-start.md` v1.5 7 步，落 baseline 状态：
  - `cat ~/.claude/session-state/<name>.json` 记 last_heartbeat / current_doing
  - `ipc_recent_messages(self, since=6h)` 拉空 inbox
- **目的**：确认起点干净，演练后 inbox 回放可对比

#### Step 3 · jianmu-pm 监控点 arm
- **动作**：jianmu-pm（本 session）开 audit 监控：
  - `tail -f data/hub.log | grep -E 'reclaim_evict|push_deliver|ack_received|<演练对象>'`
- **目的**：实时 capture audit log 三层数据作为演练证据

### Phase B · 制造 zombie（演练 T+0）

#### Step 4 · 演练对象 SIGKILL 模拟崩溃
- **动作**：演练对象的 Claude Code 进程被 `Stop-Process -Force`（或 `kill -9`）杀掉，**不走** /exit 优雅退出
  - 由演练对象自己在 IPC 报"我即将被 kill -9 模拟崩溃"后另开 PowerShell 执行
  - 或由 jianmu-pm 拿到演练对象的 claude.exe PID 后远程 kill（**三维验明正身**：Get-Process + cmdline 含 `IPC_NAME=<name>`）
- **目的**：确保 Hub-side `ws.readyState === OPEN` 仍存（pong timer 没到 → zombie 占位）

#### Step 5 · 验证 zombie 占位
- **动作**：jianmu-pm `ipc_sessions()` 应仍见 `<演练对象>` 在线（Hub 还没 detect zombie）
- **验收**：返回数组包含演练对象 name + connectedAt 字段
- **若 fail**（Hub 已 detect zombie）：等待时间窗口太长（commit 18 wsDisconnectGraceMs 60s 已过 + isAlive 翻转），演练 reset 重来

### Phase C · 新 session 起 + reclaim（演练 T+1min）

#### Step 6 · 新 session 启动
- **动作**：演练对象用 `ipc <name>` 启动新同名 session（PowerShell 自动构造 `IPC_NAME=<name>` env + 跑 claude.exe + MCP server stdio）
- **预期**：mcp-server 冷启时 WS connect 收 `4001 name taken`（Hub 拒）
- **验收**：mcp-server.mjs log（或 jianmu-pm Hub log）见 `4001 name taken` 记录

#### Step 7 · 新 session 调 ipc_reclaim_my_name
- **动作**：mcp-server.mjs 冷启自检流程检测到 4001 → 自动调 `ipc_reclaim_my_name(<name>)`
  - 注：当前 mcp-server.mjs 是否已自动调 reclaim **需核对**（ADR-008 §"调用方流程"段是设计指南，实际是否实现需 grep mcp-server.mjs `ipc_reclaim_my_name` 调用点）
  - 若 mcp-server 未自动调，演练对象的 AI 在 cold-start 7 步收到 4001 报错时**手动**调 `ipc_reclaim_my_name(<name>)`（按 `session-cold-start.md` v1.3 标准路径）
- **预期 Hub 响应**：
  - Hub 收 `/reclaim-name` POST
  - Hub 对 zombie ws 主动 ping
  - 5s 内**不收**到 pong（zombie 已死）
  - Hub `audit('reclaim_evict', ...)` 落 hub.log
  - `ws.terminate()` zombie
  - 回 `{ ok: true, evicted: true, previousConnectedAt }`

#### Step 8 · 验证 evict
- **动作**：jianmu-pm 在 hub.log 看到 `reclaim_evict <演练对象>` audit entry
- **验收**：
  - hub.log 含 `reclaim_evict {name:"<演练对象>", previousConnectedAt:<ts>, remoteAddress:"127.0.0.1"}`
  - `ipc_sessions()` 不再含老 zombie 占位

### Phase D · 重连 + inbox 回放（演练 T+1.5min）

#### Step 9 · 新 session WS reconnect 走 force-rebind
- **动作**：mcp-server WS reconnect → 进入 `hub.mjs` L350-404 的 force-rebind 分支 → 回放 SQLite inbox
- **预期**：
  - WS 连接成功（Hub 不再拒 name taken）
  - inbox 内（如有）历史消息一次性 push 到新 session（mode=`flush-inbox` audit）
  - 新 session 的 `<channel>` tag 内容含历史消息
- **验收**：
  - `ipc_sessions()` 见演练对象（new connectedAt）
  - 新 session 调 `ipc_recent_messages(self, since=10min)` 与 baseline 对比 inbox 内容

#### Step 10 · 验证可继续工作
- **动作**：
  - 演练对象发 `IPC harness "演练复活，准备测发消息收消息"`
  - jianmu-pm 回演练对象一条 ping 测试消息
  - 演练对象通过 `<channel>` tag 收到 ping
- **验收**：双向 IPC 通畅 = 完整闭环

### Phase E · 演练后清理（演练 T+5min）

#### Step 11 · 收集 audit 数据 + 写演练简报
- **动作**：
  - jianmu-pm 抓取 hub.log 演练时段 reclaim_evict / push_deliver / ack_received 三层 audit entries
  - 写 `handover/DEMO-COLD-START-SCENARIO-B-<YYYY-MM-DD>.md` 简报（参考 retro §8.5 格式：场景 + 时序 + 证据 + 教训）
  - 演练对象写一段"AI 调用人体工程学体感"
  - harness 独立审 + 决定是否标 ADR-008 Phase 3 DONE

---

## 5. 监控指标

演练时 jianmu-pm 实时关注：

| 指标 | 来源 | 阈值 |
|---|---|---|
| `reclaim_evict` audit 出现 | hub.log | 必现 1 次 |
| ping → pong 超时实测 | hub.log | < 5s（5s 是上限） |
| zombie evict 后重连耗时 | mcp-server log | < 3s |
| inbox 回放消息数量 | `ipc_recent_messages` 对比 | 等于 baseline 后 zombie 期 Hub 收到的消息总数 |
| portfolio 其他 session 误警报 | 各 session IPC | 0（公告生效则无） |
| Hub /health 不变 | curl /health | 仍 ok |

---

## 6. 风险评估 + 缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| Hub 主动 ping 5s 内 zombie 居然 pong（pong-undead） | 低 | 演练失败需 reset | reclaim 返回 `holder-alive`，按 `holder-alive` 路径处理：演练对象先杀本机所有 claude.exe / wscript.exe（**严守 feedback_no_kill_node 不动 node.exe**），再起新 session |
| inbox 回放被 token 轰炸 | 低 | 新 session 启动 context 大量消耗 | 264e15a 已 fix flushInbox 不自动推 messages 表历史。若仍轰炸 → 临时 IPC `ipc_recent_messages(self, since=1min)` 限窗 |
| 演练对象的 mcp-server 没实现自动 reclaim | 中 | Step 7 需 AI 手动调 reclaim | brief 里明示 fallback 手动调路径；演练后报"自动化缺口"作 ADR-008 Phase 4 候选 |
| 演练撞上 SSH 拥塞 / Hub 重启 | 中 | 演练时序混乱 | 演练时段选 SSH 稳定窗口（参考 14:36 portfolio 实测节奏）+ 提前 jianmu-pm 测一次 push 通过 |
| 演练对象的 Claude Code 进程 kill -9 杀错（误杀 jianmu-pm 或 harness） | 低 | portfolio 雪崩 | 三维验明正身（Get-Process + cmdline `IPC_NAME=<演练对象>` + 端口/PID 验证），feedback_kill_verify_pid 严守 |
| reclaim ping 5s 期间演练对象 mcp-server 撞 rate-limit 10s | 低 | reclaim 反复 fail | 演练前确认演练对象 10s 内未触发过 reclaim；rate-limit 触发时 backoff 等 retryAfterMs |
| 演练后 inbox 回放遗漏 zombie 期间消息 | 低 | 演练对象工作上下文丢失 | 演练前 baseline 记 last_heartbeat；演练后比对 `getRecipientRecent(since=baseline)` 全量列表 |

---

## 7. 失败回退方案

如果 Step 7-9 任一失败：

1. **立即停演练**：jianmu-pm IPC harness 停止 `【演练终止】Phase X 失败：<原因>`
2. **保护 work state**：演练对象不强制 retry · 接受 zombie 占位
3. **手工 evict 兜底**：jianmu-pm 直接 `curl POST /reclaim-name` 强制 evict + 等 jianmu-pm 实测 evict 成功后让演练对象重连
4. **极端兜底**：jianmu-pm 暂停 Hub（绕过 vbs daemon `kill -PID 3179_listener`） + 重启 Hub（schtasks AtLogOn 触发或 vbs 单次跑）+ 演练对象重连
5. **演练复盘**：失败也是数据，把 fail 模式 + 时序写进演练简报，不删 audit log

---

## 8. 演练后产出物结构

`handover/DEMO-COLD-START-SCENARIO-B-<YYYY-MM-DD>.md` 含：

```
# DEMO · ADR-008 Phase 3 cold-start 场景 B 演练 · YYYY-MM-DD

## 演练对象 + 时段
- 对象：<name>
- 时段：HH:MM-HH:MM（实际 N 分钟）
- 演练人：<演练对象 AI> + jianmu-pm（监控）+ harness（审）

## 时序（10 步实际执行）
- T-30min Step 1 公告：...
- T+0    Step 4 SIGKILL：PID=N，cmdline=...
- T+15s  Step 5 zombie 验证：ipc_sessions 见 <name>，connectedAt=...
- T+1min Step 6 新 session 起：...
- T+1m5s Step 7 reclaim 调用：...响应={ok:true, evicted:true}
- ...

## audit 数据（hub.log 抓取）
```log
<reclaim_evict ...>
<push_deliver ...>
<ack_received ...>
```

## 体感（演练对象 AI 写）
- 调用 ipc_reclaim_my_name 是否自然、是否需查文档
- inbox 回放 `<channel>` 内容是否符合预期
- mcp-server 是否自动调 reclaim 还是手动

## 教训
- 边界 case 发现：...
- 工具改进点（ADR-008 Phase 4 候选）：...
- 规范文档需补的说明：...

## 验收
- jianmu-pm 监控数据：PASS / FAIL（每条监控指标）
- harness 独立审：LGTM / 改动单
- ADR-008 Phase 3：DONE / 留 retry
```

---

## 9. 时间窗口建议

- **演练时长**：~10min（公告 30min 前 + 真实演练 5min + 复盘写简报 30min）
- **演练时段**：portfolio 整体相对静默期（夜间 / 周末 / 老板休息时段），SSH 拥塞低概率
- **避开**：portfolio 重活并发（如 pc-pet Stryker 全量 / 大量 codex 并发派单 / SSH 拥塞高峰）
- **建议**：2026-04-26 / 2026-04-27 周末晚 22:00 后 · 或 SSH 拥塞解除证实后任意时段

---

## 10. 一次成功后的延展（可选 · 留 ADR-008 Phase 4）

如果 Phase 3 演练通过 + 发现自动化缺口（如 mcp-server 未自动调 reclaim），ADR-008 Phase 4 候选：

- mcp-server.mjs 冷启自检：发现 4001 自动调 ipc_reclaim_my_name + retry connect
- 集成进 portfolio-boot 脚本（绑 xihe-tianshu-harness P1 bug 8）
- 加 metrics：reclaim 调用次数 / 成功率 / 平均 ping-pong 耗时

---

## 版本

| 版本 | 日期 | 作者 | 说明 |
|---|---|---|---|
| v0.1 | 2026-04-25 | jianmu-pm | 首版草案，等 harness review + portfolio session 选取演练对象 |
