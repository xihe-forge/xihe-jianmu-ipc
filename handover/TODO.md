# xihe-jianmu-ipc · TODO

> IPC 基础设施 repo 的活清单。按优先级分段。所有条目有明确"现状 / 目标 / 验收 / Owner / ETA"。

**最后刷新**：2026-04-26T14:56+08:00（jianmu-pm）
**刷新节奏**：每次重要产出 + 每周一 portfolio-sync · 老板 88% 周限额硬规矩：每完成任务立即落盘 + commit + push（不批量积压）

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

### 切账号窗口待 trigger · spawn fix v2 keystone 已解锁

- **现状**：2026-04-26T01:34 AC-IPC-SPAWN-WT-002 fix v2 三层校验全过（git origin push 5b9a6b9+0967749+df9de3a / 独立 node --test 7/7 PASS / harness mkdir 补救后 reports 目录已建）。harness 01:41 manual verify 暴露 portfolio runtime 全 fix v1 cache · runtime cache 不 hot-reload · 切账号 reload 是 fix v2 真生效 trigger 不是切账号前 prerequisite。harness 01:42 已 IPC 老板"切账号 ready"信号
- **目标**：boss 关 wt 窗口 → portfolio 全 session /exit → 新账号 fresh load fix v2 → successor 接班 ADR-004 v0.2 三步 atomic handoff 第一例 dogfood = ipc_spawn host=wt 真 acceptance gate
- **验收**：
  1. successor 调 `ipc_rename` 让名 → `ipc_spawn(name=原名, host=wt)` → `/exit` 三步成功
  2. 新 session 真起 claude.exe（Get-Process claude 见进程）+ 真注册 IPC name（ipc_sessions 见）
  3. ADR-004 v0.2 mark spawn path Accepted
- **Owner**：boss trigger · successor 执行 · harness 验
- **ETA**：boss 切账号当时

### ADR-009 v0.1 design 已 ship · 等老板 review 拍板

- **现状**：2026-04-26T14:18 ship `handover/ADR-009-RATE-LIMIT-AUTO-WAKE-DESIGN.md` v0.1 · `cb38bc3` push origin。4 SOP design 完整（SOP-1 watchdog 第 9 probe rate_limit_pct / SOP-2 stuck 三态分类 retry-exhausted/rate-limited/network-down / SOP-3 wakeRateLimited 路径 / SOP-4 飞书"用量"命令 + Hub /usage endpoint）。与 ADR-006 互补 · 共享 watchdog/Hub/PS hook/飞书基建
- **目标**：老板 review 拍板综合策略 → 切账号后派 codex 实施 4 SOP（SOP-1+Plan C 共派 / SOP-2+Plan B 共派 / SOP-3 与 Plan A 同源扩 / SOP-4 独立 PR）
- **验收**：design v0.1 落档 ✅ · 老板 LGTM 转正式 ADR 编号 · 4 SOP 实施 PR 切账号后 1-2 周内 ship
- **Owner**：jianmu-pm 主驱实施 · harness 审 · 老板拍板
- **ETA**：review 2026-04-27 / 实施 2026-05-08

### ADR-006 v0.1.1 Plan B 路径 C · Hub stale-detect-suspend 实施

- **现状**：harness 14:48 cross-check Plan B 原 PowerShell stderr daemon 路径技术不可行（Claude Code hook events 无 stderr-watch）→ 改路径 C 与 Plan A 同源 lib/network-events.mjs/hub.mjs · ADR-006 v0.1.1 patch ship `2e29650` push origin/main · 我 jianmu-pm 接 brief + codex 实施。Hub 加 lastAliveProbe stale > 10min → POST /suspend {reason:'stuck-stale'} 自动触发 Plan A wake 路径
- **目标**：TDD RED→GREEN + push origin · 与 Plan A/C 形成 portfolio session 自动接续完整链
- **Owner**：jianmu-pm 派 codex（按 SOP v1.0 模板起 brief）
- **ETA**：15:00 brief ship · 15:55 codex done

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

### ADR-002 Phase 2 A1 · session-state hook ipc_spawn IPC_NAME 注入 verify

- **现状**：yuheng 14:58 查出 A1 hook 从未实现（ADR-003 MVP 只含 A4+A5，harness.json 是 harness 手 Write 的）。harness 15:23 方案 ADR-002 Phase 2 指名 tech-worker 主做 `session-state-writer.sh`（bash 脚本 stdin JSON merge `~/.claude/session-state/$IPC_NAME.json`）+ `templates/hooks-snippet.json` Stop hook writer；**我侧负责 ipc_spawn 的 IPC_NAME env 注入**
- **本仓现状扫描**：`mcp-server.mjs` grep `IPC_NAME` 实证 5 个 spawn host 路径全注入（PowerShell `$env:IPC_NAME` / cmd `set IPC_NAME` / WSL env line / Linux terminal shell prefix / bash fallback），Claude Code 进程继承父 shell env，hook 内部应能读到 `$IPC_NAME`
- **目标**：等 tech-worker ready `session-state-writer.sh` 后做 E2E verify——ipc_spawn 测试 session → 触发 Stop hook → cat `~/.claude/session-state/$IPC_NAME.json` 验证文件名含 session name 而非 `session-<pid>` fallback
- **验收**：
  1. verify 场景 5 host 全通过（wt / vscode-terminal / external / Linux terminal / bash fallback）
  2. 若发现任何 env 丢失的 edge case 同回合补 injection 代码 + 回归测试
- **Owner**：jianmu-pm 主 verify · tech-worker 主做 hook 脚本
- **ETA**：阻塞在 tech-worker `session-state-writer.sh` 出稿，她出稿当日我做 verify（~30min 零代码改动前提）

### v0.5.0 release cut · 等 SSH push tag

- **现状**：CHANGELOG.md `[0.5.0] - 2026-04-25` 段写完（50+ commits 整合 4 大主题：ADR-002 Phase 1 / ADR-005 observation / ADR-008 reclaim / ADR-009 race fix + watchdog 6/7/8 probe + hub-daemon 时间盒）。package.json `0.4.1` → `0.5.0` bump。本地 commit `158eaf1` chore(release): v0.5.0 已 land local · ahead origin/master by 1 commit
- **目标**：等 SSH 恢复批量 push origin master + `git tag v0.5.0` + push tag + `/release-check` skill 门禁
- **验收**：`git tag v0.5.0 + push` 可见；GitHub Releases 页面有 v0.5.0 entry
- **Owner**：jianmu-pm 主做 · harness 审 /release-check 门禁
- **ETA**：2026-04-25（SSH 恢复后）/ 2026-04-30 兜底窗口

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

### 2026-04-26

- [x] **AC-ADR-006-PLAN-C watchdog wake-suspended reaper** TDD Red→Green（origin/master 二 commit：RED `1093eee` + GREEN `7ae0271` · 5/5 PASS · npm test PASS · push OK · codex 三派两停（baseline-mismatch / line-1174 CRLF mixed）后 v3 grep-only 一次过）。改 `bin/network-watchdog.mjs` 加 `createWakeReaper` 工厂 export + 周期 60s 检查 suspended.length>0 + 最近 3 次 anthropic ok → POST /wake-suspended + 5min cooldown 防风暴。`lib/http-handlers.mjs` `/health` 端点扩 `suspended_sessions` 字段。配合 Plan A stale wake 形成双层（reaper 触发 broadcastNetworkUp → Plan A 自动 wake stale）。**沉淀**：feedback_codex_brief_preflight_relax.md v0.2（CRLF/LF mixed 文件 wc -l 不可信 · 必走 grep -cE 模式 + test -f 文件存在 · dispatch 前自验前置）+ MEMORY.md index 同步
- [x] **AC-ADR-006-PLAN-A Hub auto-wake hook** TDD Red→Green（origin/master 二 commit：RED `e49be13` + GREEN `2c47c60` · 5/5 PASS · npm test 605/605 PASS · push OK · codex `bwoknxtsk` 4min 闭环）。改 `lib/network-events.mjs` broadcastNetworkUp 扩 stale session wake 逻辑（lastAliveProbe > 5min + ws.readyState=OPEN → router.routeMessage wake IPC · payload 加 autoWokenSessions[] 字段 · /wake-suspended 返回扩展不破坏现有）+ hub.mjs wire getSessions。三层校验全过：git log origin/master --grep ✅ + 独立 node --test 5/5 ✅ + bash task exit 0 ✅（mkdir 前置生效后 tee 不再 fail · feedback_codex_log_dir_mkdir 教训生效）。**注意**：runtime cache 不 hot-reload · 切账号后 portfolio fresh load 才真生效（feedback_mcp_server_no_hot_reload）
- [x] **ADR-009 v0.1 design 4 SOP**（origin/master `cb38bc3` 178 lines · `handover/ADR-009-RATE-LIMIT-AUTO-WAKE-DESIGN.md`）。响应 boss 21:34 P0 派 + 02:02 88% 周限额 critique。SOP-1 watchdog 第 9 probe rate_limit_pct / SOP-2 stuck 三态分类 / SOP-3 wakeRateLimited 路径 / SOP-4 飞书"用量"命令 + Hub /usage endpoint。与 ADR-006 互补 · 共享 watchdog/Hub/PS hook/飞书基建。走 handover/ design 路径（docs/adr/009 已用 mcp-initialize-race-fix）· review 后转正式编号。harness 14:20 ack LGTM 等老板拍板
- [x] **AC-IPC-SPAWN-WT-002 ipc_spawn host=wt fix v2 真起 acceptance** TDD Red→Green（origin/master 三 commit：RED `0967749` + GREEN `5b9a6b9` + sync `df9de3a`，7/7 tests PASS，npm test 全绿，push origin OK）。**真 root cause**：fix v1 (ba0ccef+2ad7d1a+fa526ff) 5/5 unit case PASS 但 harness 23:42 manual verify 暴露 partial — wt cmdline 构造对但 claude.exe 0 process · trace log 不存在 · ipc_sessions 5min 后空。第三层根因：mcp-server.mjs L439 `spawn('cmd', ['/c', startCommand], shell:false)` Node Windows 自动用 `\"` escape vs cmd.exe 期待 `""` doubled-quote · cmd 看 `\"` 当引号结束 inner path 截断。fix v2 方案 A：直接 `spawn('wt.exe', [args 数组])` 跳 outer cmd · Node 对 wt.exe 用 C runtime escape 兼容。新增 `buildWtSpawnArgs` + 保留 `buildWtStartCommand` v1 5 case 维持 PASS。**Q9 第 6 例 + dispatch lessons**：bash task notification exit 1 因 tee 写不存在目录 silent fail · 真值 fallback `git log origin/master --grep` + 独立 `node --test` 三层校验全过 · 立 `feedback_codex_log_dir_mkdir.md` + `feedback_mcp_server_no_hot_reload.md` 双 user memory（mcp-server 改 ship ≠ portfolio runtime 生效 · 必须切账号或重启 session 才 fresh load · 与 settings.json hot-reload 同源 · ADR-004 v0.1.1 §背景已点）

### 2026-04-25 (晚 P0 spawn 链)

- [x] **AC-IPC-SPAWN-WT-001 ipc_spawn host=wt 命令构造修复 fix v1** TDD Red→Green（origin/master 三 commit：RED `ba0ccef` + GREEN `2ad7d1a` + test sync `fa526ff`，5/5 tests PASS）。修 buildWtStartCommand 去 `start ""` 包装 + wt `--` 分隔符 + cmd /k 替代 cmd /c。**遗漏**：5/5 unit 验 cmdline 字符串构造 ≠ 验真起 claude（ship=acceptance 教训复刻 → 触发 fix v2）
- [x] **AC-PORTFOLIO-ACCEPTANCE-001-f after() cleanup 真自动** TDD Red→Green（origin/master：RED `849d042` + GREEN `3a35844`，6/6 tests PASS · TEST_DB_DIR 跑完不残留 SQLite 三文件）。e2e-tester 17:36 verify-ok advisory follow-up
- [x] **portfolio-acceptance e2e self-test ship gate** 立（origin/master `c95cbc1` 5 cases first-write 5/5 PASS · `429cc61` OPERATIONS.md ship gate §加 + `a9bd6ab` cleanup 语义精确文案）。老板 16:55 critique "ship 标准 = acceptance 标准 partial check 自欺禁止" → harness portfolio 通告
- [x] **ADR-003 hook 失效修复 v2 PowerShell native 4 hook**（xihe-tianshu-harness 仓 · `1c957d9`/`020204b` checkpoint-refresh.ps1 v1 + `5aa948a`/`fc9eb9a` v2 4 阈值 advisory + `341d79e` v2.1 advisory-hit.log telemetry · `dec86e7` install-hooks.mjs v2 PS pattern · 老板 15:27 critique "Windows 用 PowerShell not WSL bash" 后 1.5h 闭环）
- [x] **HUB-UPTIME-7D-BASELINE-DESIGN.md** v0.1+v0.2（origin/master `8c3eeb8` + `9bdb375` §14 patch 4 sub-section）
- [x] **HANDOVER-jianmu-pm-20260425-2200.md schema v2** 286 lines（`47c77ae` v1.0 + `ef9efe3` §5.1 case 6 + `af5ad41` linter auto-update）
- [x] **dependabot.yml fix**（`a47be84` 删 Cargo ecosystem + npm directory /apps/desktop 不存在）
- [x] **ADR-003-AUTO-ROLLOVER-GAP-EVAL.md**（`c9f46f5` v0.1 215 lines · 3 paths：advisory⭐⭐⭐⭐⭐ / true spawn⭐⭐ rejected / deployment⭐⭐⭐ one-time）
- [x] **DESIGN-cold-start-scenario-B-drill.md**（`e411f62` v0.1 249 lines · ADR-008 Phase 3 drill design）

### 2026-04-25

- [x] **hub-daemon.vbs 时间盒改造 + schtasks 触发器修复 TDD Red→Green**（origin/master 三 commit：RED `e694790` + GREEN `2f375ed` + chore `43d6f97` schtasks AtLogOn+Repetition 10min · `npm test` 558→587 pass · AC-DAEMON-001 4 case：vbs 无 Do/Loop / cscript 30s 内 exit 0 / data/hub.log 末行 [housekeeping] ISO-ts OK / 严守 feedback_no_kill_node）。Q9 第 5 例 stream disconnect 实证：bbrj22chz 13:48 起跑 13:50 stream 截断 task-notification exit 0 但 GREEN/push 未跑，b94q23pql 13:57 起 14:18:04 续完 push=ok 587 pass schtasks 顺手 fix
- [x] **ADR-003 hook 失效修复 install-hooks 工具 TDD Red→Green**（仓 = xihe-tianshu-harness · origin/main 二 commit：RED `dec1535` + GREEN `46722fd` + 实际跑 `node tools/install-hooks.mjs` 把 templates/hooks-snippet.json 幂等 merge 进 ~/.claude/settings.json）。AC-HOOKS-001 4 case：empty + snippet → settings.hooks / 保留非 hooks 段 / 同 matcher append 不覆盖 / 幂等。**根因**：~/.claude/settings.json 完全无 hooks 段，模板 hooks-snippet.json 完整 + 三脚本本体正确（含 ADR-002 §二 55%/60%/65% Stop hook + ≥95% 放行）但**从未被 merge**，6 天历史欠账。**hot-reload 限制**：当前老 session 不重读 settings.json，新 session 启动才装 hook
- [x] **v0.5.0 CHANGELOG + version bump 准备**（local commit `158eaf1` chore(release): v0.5.0 · 50+ commits 自 v0.4.1 整合 · skip-tdd: release · 待 SSH 恢复 push + tag v0.5.0 + /release-check 门禁）
- [x] network-watchdog P1-b · 第 8 probe phys_ram_used_pct 百分比化 TDD Red→Green（origin/master 三 commit：RED `e0d3baa` + GREEN `f46b7b6` + docs `bd073ea`，`npm test` 554→558 pass，AC-WATCHDOG-008 grep 5 命中 4 case + 1 describe，CLAUDE.md 7→8 项同步）。**Q9 鲁棒性压测最终战绩**：一晚派 4 次 Codex，挂 3 次（btfq3nm92 bash quote 5h1m / br691gxlk model capacity 34min / by1kiiq0o stream disconnect 3min），work state 零污染累计递增，最终 bosnf4y8s（240s cooldown + 三要素 brief）一次闭环。feedback_codex_dispatch.md 沉淀"bash quote 陷阱"+ "Q9 四型失效模式锚点" + "Q9 follow-up brief 模板三要素"三段

### 2026-04-24

- [x] ipc_reclaim_my_name MCP 工具 + /reclaim-name Hub endpoint ADR-008 Phase 1 DONE（master HEAD 90590a4，+654/-3，545/545 tests，Codex+jianmu-pm+harness 三签 LGTM）
- [x] handover/PROJECT-PLAN.md + TODO.md 首版补齐（兑现 2026-04-20 handover-20260420-jianmu-pm.md §NextSteps 第 5 条承诺）
- [x] `--dangerously-load-development-channels` → `--channels server:ipc` 批量替换（master HEAD 93f94db，7 files +13/-13，545/545 tests pass，retro §8.5 bug 5 收口）
- [x] daemon wscript cleanup · 去 cmd /c 外壳 + CPA 6.9.36 路径 bump（master HEAD 8e0b806，3 files +9/-9，CMD 闪窗修复 + GPT-5.5 via CPA 6.9.36 支持）
- [x] network-watchdog P1-a · 第 6 probe committed_pct + 90/95 阈值动作 + session-guard tree-kill 集成（master HEAD f722ed4，7 files +432/-11，npm test 545→554 pass，承诺 ETA 2026-04-26 提前 43h 闭环，LGTM 三签）

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
| 2026-04-24T14:28+08:00 | jianmu-pm | P1 增"hub-daemon.vbs 时间盒改造"条目（harness A+B 双登约定的 B 侧，A 侧为 retro v1.0 §8.5 bug 9）；已完成清单追 2026-04-24 的 channels flag swap 93f94db + daemon wscript cleanup 8e0b806 两 commit |
| 2026-04-24T15:35+08:00 | jianmu-pm | P1 增 2 条：network-watchdog committed_pct 采样（harness P1-a，ETA 2026-04-26）+ ADR-002 Phase 2 A1 session-state hook IPC_NAME 注入 verify（阻塞在 tech-worker session-state-writer.sh 出稿）；触发事件 xuanji 2026-04-24 14:49 / 15:00 两次 vitest 近爆 pagefile · tech-worker tree-kill 兜住 57GB · 老板批严格档 maxForks=2 + NODE_OPTIONS=2048 + 70% 硬 abort 预检 + 95% tree-kill rollout；jianmu-ipc 不在 T-VITEST-001 范围（node --test runner 栈证据已回执 yuheng） |
| 2026-04-24T17:05+08:00 | jianmu-pm | P1-a 闭环（提前 43h）：master HEAD f722ed4 committed_pct 第 6 probe + 90 WARN 广播 + 95 CRIT session-guard tree-kill + 5min dedup per-level；tech-worker d4b435b 接口 + 三维验明正身安全保护 + ExcludePattern 扩 codex\|openai 采纳；npm test 545→554 pass；P1-a 条目从 P1 区移至已完成；A1 仍 standby 等 tech-worker hook 出稿 |
| 2026-04-25T00:23:53+08:00 | jianmu-pm | P1 增"network-watchdog 第 8 probe · phys_ram_used_pct 百分比化"条目，ETA 2026-04-28。触发：harness 00:02 广播 commit% gate 作废改物理 RAM<80% used 单 gate；vitest-memory-discipline v1.0.3 fb7e196 附录 D line 470 要求 watchdog 补百分比指标；tech-worker msg_b14a96 IPC 确认 DIM4 1b85ee9 对齐百分比语义。hub-daemon vbs 时间盒 Codex 后台 btfq3nm92 跑中 |
| 2026-04-25T05:34+08:00 | jianmu-pm | P1 phys_ram_used_pct 第 8 probe 闭环（提前 3 天）：origin/master RED e0d3baa + GREEN f46b7b6 + docs bd073ea 三 commit push · 558 pass · AC-WATCHDOG-008 grep 5 命中。Q9 鲁棒性压测战绩一晚派 4 次挂 3 次（bash quote 5h1m / capacity 34min / stream disconnect 3min）work state 零污染，bosnf4y8s 最终闭环。条目移至已完成段。hub-daemon vbs 时间盒因 btfq3nm92 死讯排期 2026-04-26 窗口 |
| 2026-04-25T14:25+08:00 | jianmu-pm | 三 P1 同日闭环（自驱模式）：(1) hub-daemon.vbs 时间盒 TDD origin/master e694790/2f375ed/43d6f97 587 pass schtasks 10min repetition fix，提前 3 天；(2) ADR-003 hook 失效 install-hooks TDD（xihe-tianshu-harness 仓 dec1535/46722fd）+ 实际 install merge user settings.json，老板派单 ~1.5h 闭环；(3) v0.5.0 CHANGELOG+version bump local commit 158eaf1 prep · 待 SSH push tag。Q9 mode #3 stream disconnect 第 4 例（bbrj22chz）+ feedback_codex_dispatch.md "heredoc + codex exec 同 Bash call 禁止"段（xuanji 踩坑同步沉淀）。两条目同步：hub-daemon 时间盒删 P1 移已完成段；v0.5.0 release cut 现状改为"local commit 待 SSH push tag" |
| 2026-04-26T02:14+08:00 | jianmu-pm | P0 全面重置（响应 boss 88% 周限额 + harness 02:10 todo 频次升级硬规矩）：(1) ADR-008 Phase 2 P0 标 done（harness 已 ship session-cold-start.md v1.3 切换 · 移已完成）；(2) 新 P0 = 切账号窗口待 trigger · spawn fix v2 keystone 已解锁（5b9a6b9+0967749+df9de3a · 7/7 PASS）· runtime cache 是 reload trigger 不是 prerequisite；(3) 新 P0 = ADR-009 / API rate limit 治理 gap 4 SOP（boss 21:34 派 · successor 接班后做）；(4) 已完成段加 2026-04-26 spawn fix v2 + 2026-04-25 晚 P0 spawn 链 11 条目（fix v1 / portfolio acceptance e2e ship gate / hook PS native v2 / hub-uptime baseline v0.2 / handover schema v2 / dependabot fix / ADR-003-gap-eval / cold-start-drill design）；(5) 双 user memory 沉淀 feedback_codex_log_dir_mkdir + feedback_mcp_server_no_hot_reload（mcp-server 改 ship ≠ portfolio runtime 生效 · 必须切账号 reload · 与 settings.json hot-reload 同源） |
| 2026-04-26T14:21+08:00 | jianmu-pm | 自驱抓 backlog（response harness 14:07 信号 + boss 13:57 "活都干完了吗" critique）：(1) ADR-009 v0.1 design ship `cb38bc3` 4 SOP 完整（boss 21:34 派 P0 ack）；(2) ADR-006 Plan A codex `bwoknxtsk` 14:14 dispatched · TDD RED→GREEN broadcastNetworkUp 扩 stale session auto-wake；(3) ADR-006 Plan C 待 Plan A done 后接力 + 评估与 SOP-1 共派；P0 段重排：ADR-009 v0.1 design 已 ship 等 review / ADR-006 Plan A 实施中 / Plan C 待派 |
