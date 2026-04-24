# xihe-jianmu-ipc · PROJECT-PLAN

> 曦和 AI 团队 **IPC 通信基础设施**项目。WebSocket 消息路由 + MCP 工具层 + 飞书控制台 + SQLite 持久化 + sessions-registry 维护 + harness/watchdog 存活探测 endpoint。

**项目类型**：tool-type / infrastructure-project（本 repo 是治理层下面的传输层 + 协议层，所有软件 session IPC 都走这里）
**主 session**：jianmu-pm（IPC name）
**上级**：直汇老板 + portfolio 协调
**协同**：harness（消费 `/session-alive` 探测 + 所有规范 source of truth）/ tech-worker（cutover 时执行+监督）/ network-watchdog（消费 5 项 probe）/ 所有软件 session（消费 MCP + HTTP API）

---

## 0. 这份文档怎么看（30 秒入门）

如果你是刚接手的 session 或刚加入的人类，先读这段。

### 关键词速查

| 词 | 是什么 |
|---|---|
| jianmu-pm | 本 repo 主 session，IPC Hub owner |
| Hub | WebSocket server 跑在 `localhost:3179`，协议入口 |
| Watchdog | `bin/network-watchdog.mjs`，5 项 probe（cliProxy/hub/anthropic/dns/harness），跑在 `:3180` |
| MCP 工具 | 14 个 ipc_* 工具，通过 `mcp-server.mjs` stdio 注入 Claude Code / OpenClaw |
| sessions-registry | `~/.claude/sessions-registry.json` 全 portfolio session 清单，Hub `/registry/*` 端点维护 |
| observation | ADR-005 层，`~/.claude/project-state/<project>/observations.db` + FTS5 检索 |
| force-rebind | 隐式 zombie 接管，只回放 inbox 不恢复 topics |
| release-rebind | 显式接力路径，旧 session `POST /prepare-rebind` 让位，新 session 继承 topics + buffered_messages |
| reclaim | 2026-04-24 新工具 `ipc_reclaim_my_name`，解决冷启场景 B zombie 死锁 |
| 飞书控制台 | P2P/@群聊命令（状态/派发/广播等 7 指令），命令在 bridge 拦截不转 Hub |
| commit 18 | 2026-04-21 watchdog Hub WS 保活改造，cutover 2026-04-22 闭环 |
| ADR | `docs/adr/` 决策记录，8 份（001-008） |
| v0.4.1 | 当前 release 版本（package.json @ 2026-04-21） |
| v0.5.0 | 规划中下一版本，Phase 1-4 代码均已 implemented @ 2026-04-19，等 cut release |

### 全文结构

- **一、定位**：本项目是什么，核心能力清单
- **二、已 ship 产出**：按日期倒排的交付物
- **三、阶段路线图**：历史 Phase 1-9（ROADMAP）+ v0.5.0 Phase 1-4 + Phase 10/11 探索
- **四、与 portfolio 关系**：本项目和其他仓的依赖
- **五、关键约束**：硬规则
- **六、度量指标**：怎么衡量项目健康
- **七、版本**：本文档自身的修订历史

### 这份和 TODO 的关系

- **PROJECT-PLAN**（本文档）：项目长程视图——定位 / 路线图 / 已交付清单
- **TODO**：每周活清单——P0-P4 当前要推的事

---

## 一、定位

**一句话**：jianmu-ipc 是曦和 AI 团队的**消息总线 + 协作协议底座**，所有 session 间通信、所有 Claude Code MCP 工具、所有飞书控制台指令都跑在这上面。不是业务产品，是**所有 portfolio session 的传输层**。

**核心能力**：
1. WebSocket 多 session 实时路由 + topic 订阅 fanout + broadcast
2. SQLite 消息持久化（WAL + 7 天 TTL）+ inbox 离线回放
3. 14 个 MCP 工具（send/sessions/whoami/subscribe/spawn/rename/reclaim/reconnect/recent-messages/recall/observation-detail/register-session/update-session/task）
4. HTTP API 20+ 端点（send/reclaim-name/prepare-rebind/suspend/wake-suspended/internal-network-event/feishu-reply/registry/sessions/session-alive/messages/recent-messages/stats/task/tasks/dashboard）
5. 飞书多 app 控制台（worker_thread 架构 + 热重载 + 7 种卡片 + 7 种命令）
6. 会话接力双路径：release-rebind（显式 prepare → 继承 topics + buffered）/ force-rebind（zombie 隐式接管 + inbox 回放）+ reclaim（2026-04-24 新增自助回收）
7. sessions-registry 集中维护（Hub 代写 `~/.claude/sessions-registry.json`，避免 session 并发竞态）
8. observation 检索层（ADR-005，跨项目 FTS5 全文搜索）
9. network-watchdog 5 项 probe + harness-state 机状态机 + coldStart grace + WS disconnect grace

## 二、已 ship 产出（按时序倒排）

### 2026-04-24

- **ipc_reclaim_my_name MCP 工具 + /reclaim-name Hub endpoint**（ADR-008 Phase 1）
  - 仓位：master HEAD=90590a4（ff-only merge feature/reclaim-my-name → master，+654/-3，11 files，含 2 new test file）
  - 改了什么：解决 session-cold-start 场景 B 死锁——旧 session 崩溃但 Hub 侧 `ws.readyState` 还停 OPEN，新同名 session 被拒 `4001 name taken`。新工具给 AI 自助回收路径，Hub 对 holder 主动 ping+5s 无 pong 才 evict
  - 核心文件：`lib/session-reclaim.mjs` 93 行 5 分支状态机（no-holder/pending-rebind/rate-limit 10s/holder-alive/evict）；`lib/http-handlers.mjs` `POST /reclaim-name` loopback-only + 1KB body cap
  - 怎么验的：545/545 tests pass（unit 7 + integration 3 + mcp-tools 1 reclaim 专项全绿）；grep 92 命中 11 files；LGTM 三签（Codex 04-23 12:26 / jianmu-pm 04-24 12:46 / harness 04-24 12:49）

### 2026-04-21

- **commit 18 · watchdog Hub WS keepalive 存活判据改造**
  - 仓位：HEAD=4b51f29，feature/msg-persistence-mvp → master ff，16 files / +567 / -406
  - 改了什么：把判活从 `lastMsgTs + maxSilentMs=10min`（消息静默就判死）换成 `GET /session-alive?name=X → ws.readyState===OPEN` + `wsDisconnectGraceMs=60s`
  - 为什么改：04-20 04:44 harness 编辑文档 14min 没发 IPC 被老算法误判 silent，触发孤儿 commit 541ab17
  - 怎么验的：三方独立闭环——jianmu-pm 8 条 grep / harness 4 个文件 diff / tech-worker 91 tests + 6 grep；2026-04-22 cutover 4 阶段 0 false positive

### 2026-04-20

- **feature/msg-persistence-mvp merge master**（f9b00a7，MVP 6 + B4 4 + B5 c9-c17 + ADR-005 D/E/F 总 20+ commit）
- commit 14 方案 B（264e15a）：flushInbox 删 getRecipientRecent，historical pull 走 ipc_recent_messages
- commit 16（8cea552）：清 instance_id + session_instances 死代码
- commit 17（f9b00a7）：onTransition 只触发 down + dryRun 不落盘 + heartbeat ts 过滤
- **ADR-005 observation 层 Phase 0**：ipc_recall / ipc_observation_detail / ipc_register_session + ipc_update_session + Hub /registry 端点

### 2026-04-19

- **v0.5.0 Phase 1-4 全部 implemented**（`docs/planning/v0.5.0-phase-plan.md`）
  - Phase 1：IPC 同名接力（release-rebind）—— `pending_rebind` 表 + `POST /prepare-rebind` + close handler + 宽限期消息缓冲
  - Phase 2：ipc_spawn host 参数（wt / vscode-terminal / external）+ cmdline canonical 形式
  - Phase 3：harness-heartbeat probe（watchdog 第 5 项 probe）
  - Phase 4：harness self-handover（触发 check.sh + `ipc_spawn("harness", host=?)`）
- **ADR-005/006/007** 立项：Hub 模块化 / Register-ScheduledTask 参数转义 / 网络韧性 watchdog

### 2026-04-18 及更早

- **Phase 1-9 ROADMAP 里程碑**（见 `ROADMAP.md`）：群聊收发 → 进程管理 → SQLite 持久化 → 监控 Dashboard → 多 App 热重载 → 安全加固 → 飞书 AI 控制台（命令解析/状态追踪/任务派发/审批流）→ Agent 协作协议
- **ADR-001 纯 JS 不用 TypeScript**
- **ADR-002 file-watch 默认关闭**
- **ADR-003 offline inbox SQLite 持久化**
- **ADR-004 harness self-handover**（与 xihe-tianshu-harness 协同）

## 三、阶段路线图

### 历史 Phase 1-9（均已完成，见 ROADMAP.md）

基础设施 → 飞书 AI 控制台 → Agent 协作协议。

### v0.5.0 Phase 1-4（代码已 implemented @ 2026-04-19，等 cut release）

| Phase | 主题 | 状态 |
|---|---|---|
| 1 | IPC 同名接力 release-rebind | implemented 2026-04-19 |
| 2 | ipc_spawn host 参数 + canonical cmdline | implemented 2026-04-19 |
| 3 | watchdog 第 5 项 probe `harness-heartbeat` | implemented 2026-04-19 |
| 4 | harness self-handover 触发链 | implemented 2026-04-19 |

ADR-008（`ipc_reclaim_my_name`）作为 v0.5.0 的补丁特性一并 cut release。

### ADR-008 Phase 2/3（本周内）

| Phase | 主题 | 备注 |
|---|---|---|
| 2 | `session-cold-start.md` v1.3 场景 B "工具未上线兜底段"删除 + reclaim 标准路径正文化 | harness 2026-04-24 本回合直做 |
| 3 | 实地 cold-start 场景 B 复现 + reclaim 自助恢复演练 | 待 portfolio-boot 脚本落地时一起打磨（绑 xihe-tianshu-harness TODO P1 bug 8） |

### 探索方向（不改 Hub）

原 Phase 10/11 的调度和知识共享需求**不在 Hub 加逻辑**，Hub 保持轻量纯路由定位。如需实现，做独立 agent 通过 IPC 通信：

- **调度 agent**：订阅各 agent 状态广播，自主决策任务分配，通过 `ipc_send` 下发指令
- **知识 agent**：监听群消息，索引问题和方案，响应查询请求，避免重复踩坑

## 四、与 portfolio 关系

**下游消费者**（所有软件 session）：
- 走 MCP 工具：ipc_send / ipc_sessions / ipc_whoami / ipc_subscribe / ipc_rename / ipc_spawn / ipc_recent_messages / ipc_recall / ipc_reclaim_my_name
- 走 HTTP：`POST /send` / `POST /task` / `GET /sessions`

**治理层依赖**（xihe-tianshu-harness）：
- 消费 `GET /session-alive?name=harness`（commit 18 watchdog 判活）
- 消费 `POST /internal/network-event`（network-resilience 广播）
- 消费 `POST /suspend` / `POST /wake-suspended`（挂起/唤醒）
- `HANDOVER` schema v2 + session-cold-start.md 规范 source of truth 在 harness

**Watchdog 消费者**（network-watchdog）：
- 订阅 topic `harness-heartbeat`
- 5 项 probe 轮询（cliProxy / hub / anthropic / dns / harness）
- 触发 `POST /internal/network-event`（network-down / network-up）

**飞书 app** 通过 `feishu-bridge.mjs`（worker_thread 每 app 独立）转发消息至 Hub，`POST /feishu-reply` 直接回发跳 IPC。

## 五、关键约束

1. **纯 JS（.mjs）** — ADR-001 决策，不引入 TypeScript。依赖仅 `ws` + `@modelcontextprotocol/sdk` + `better-sqlite3` + `@larksuiteoapi/node-sdk`
2. **Hub 仅 localhost 绑定 `:3179`** — ADR-008 威胁模型基础
3. **Git 身份**：`Xihe <xihe-ai@lumidrivetech.com>`，推送到 `xihe-forge` org，提交不加 AI 署名
4. **Hub 保持纯路由定位** — 不在 Hub 里叠业务逻辑，调度/知识/AI 服务都做独立 agent 走 IPC
5. **消息协议变动联动**：改 `lib/protocol.mjs` → 检查 `hub.mjs` 路由 + `lib/mcp-tools.mjs` 工具是否同步
6. **feedback_no_kill_node** — 禁用 `taskkill node.exe`（会杀掉所有 Claude Code 会话）
7. **测试必须三类全过**：`npm test` = unit + integration + e2e 合计当前 545 条
8. **角色分工**：jianmu-pm 主 session 做编排+文档+review；实际代码由 Codex 写；Sonnet 子 agent 自 2026-04-17 起收紧不再派（除文档外全部走 Codex）
9. **Hub 端点改动需同步文档**：`CLAUDE.md` MCP Tools 清单 + HTTP API 清单 + `README.md` + `README.zh-CN.md` + `SKILL.md`（OpenClaw）五处

## 六、度量指标

| 指标 | 目标 | 当前 |
|---|---|---|
| `npm test` 全绿率 | 100% | 545/545 @ 2026-04-24 |
| MCP 工具数 | 持续增长 | 14 @ 2026-04-24（+1 reclaim） |
| HTTP 端点数 | 与 MCP 对应 | 20+ @ 2026-04-24 |
| Hub `/health` uptime | > 99% | 需跑 7 天基线后复核 |
| dependabot vuln | 0 | 9（1 high / 8 moderate）@ 2026-04-21，base 3916bb9 存量，ETA 2026-05-07 清零 |
| ADR 数 | 全决策有档 | 8 @ 2026-04-24（001-008） |
| release cadence | ~2 周 | v0.4.1 @ 2026-04-21，v0.5.0 待 cut |
| session 冷启成功率 | 100% | 需 portfolio-boot 落地后做 E2E 统计 |

## 七、版本

| 版本 | 日期 | 作者 | 说明 |
|---|---|---|---|
| v1.0 | 2026-04-24 | jianmu-pm | 首版，兑现 2026-04-20 交接承诺（"首版豁免：handover/PROJECT-PLAN.md + TODO.md 将在下次交接前必补"）；迁入 ROADMAP + v0.5.0 phase plan + ADR-008 Phase 1 产出 |
