# HANDOVER · jianmu-pm · 2026-04-25 22:00 portfolio 重启 · schema v2

## Schema v2 头（8 字段）

```yaml
session: jianmu-pm
successor: jianmu-pm
parent_session_id: jianmu-pm  # IPC name as session id
lineage_depth: 2              # 前任 jianmu-pm → 本 session → successor
created_at: 2026-04-24T23:21:27+08:00
handover_reason: scheduled_portfolio_restart_for_hook_rollout
files_touched:
  - xihe-jianmu-ipc/CHANGELOG.md
  - xihe-jianmu-ipc/package.json
  - xihe-jianmu-ipc/.github/dependabot.yml
  - xihe-jianmu-ipc/bin/network-watchdog.mjs
  - xihe-jianmu-ipc/bin/hub-daemon.vbs
  - xihe-jianmu-ipc/bin/install-daemon.ps1
  - xihe-jianmu-ipc/CLAUDE.md
  - xihe-jianmu-ipc/handover/TODO.md
  - xihe-jianmu-ipc/handover/PROJECT-PLAN.md (无修改 · 仅读)
  - xihe-jianmu-ipc/handover/DESIGN-cold-start-scenario-B-drill.md (新)
  - xihe-jianmu-ipc/handover/ADR-003-AUTO-ROLLOVER-GAP-EVAL.md (新)
  - xihe-jianmu-ipc/handover/HUB-UPTIME-7D-BASELINE-DESIGN.md (新)
  - xihe-jianmu-ipc/tests/phys-ram-used-pct-probe.test.mjs (新)
  - xihe-jianmu-ipc/tests/hub-daemon-timebox.test.mjs (新)
  - ~/.claude/settings.json (hooks 段 install + hot-fix + A3 删 + PS install)
  - C:/Users/jolen/.claude/projects/D--workspace-ai-research-xiheAi/memory/feedback_codex_dispatch.md
  - C:/Users/jolen/.claude/projects/D--workspace-ai-research-xiheAi/memory/feedback_pnpm_multiprocess_discipline.md
  - C:/Users/jolen/.claude/projects/D--workspace-ai-research-xiheAi/memory/feedback_vitest_pool_guardrail.md
  - C:/Users/jolen/.claude/projects/D--workspace-ai-research-xiheAi/memory/feedback_cli_flag_semantics.md (新)
  - C:/Users/jolen/.claude/projects/D--workspace-ai-research-xiheAi/memory/reference_mcp_server_version_pin.md (新)
  - C:/Users/jolen/.claude/projects/D--workspace-ai-research-xiheAi/memory/MEMORY.md
files_completed:
  - phys_ram_used_pct 第 8 probe TDD（jianmu-ipc）
  - hub-daemon.vbs 时间盒 + schtasks 修复 TDD（jianmu-ipc）
  - v0.5.0 release cut commits + tag（jianmu-ipc）
  - dependabot.yml 配置修正（jianmu-ipc）
  - ADR-008 Phase 3 cold-start 演练设计 v0.1（jianmu-ipc · doc）
  - ADR-003 真自动 spawn 设计 gap 评估 v0.1（jianmu-ipc · doc）
  - Hub /health 7 天 uptime 基线测量设计 v0.1（jianmu-ipc · doc）
  - AC-PORTFOLIO-ACCEPTANCE-001 portfolio acceptance e2e self-test + ship gate（jianmu-ipc · c95cbc1/429cc61）
  - install-hooks v1 TDD（xihe-tianshu-harness · 老板派单 P0 失效修）
  - install-hooks Stop hook hot-fix（user config A3 止血）
  - PS hook 重写 4 TDD pair（xihe-tianshu-harness · 老板 critique 转 PS native）
  - install-hooks v2 PS pattern（xihe-tianshu-harness）
  - AC-PS-CHECKPOINT-002 PostToolUse 阈值 advisory（xihe-tianshu-harness · ADR-003 v2）
  - feedback memory 4 段沉淀（bash quote / Q9 4 型 + brief 三要素 / cli flag semantics / mcp version pin）
```

## 0. 给 successor 的最快上手（30 秒）

如果你是新接班的 jianmu-pm，先按 `xihe-tianshu-harness/domains/software/CLAUDE.md` §0 冷启动 7 步跑：

1. `date "+%Y-%m-%d %H:%M:%S %Z (%z)"` 真实时钟
2. 读 `D:/workspace/ai/research/xiheAi/.session-state/jianmu-pm.json` last breath（应已含 PS hook 自动写的 mtime · 比手 write 新）
3. `ipc_whoami` + `ipc_sessions`
4. `ipc_recent_messages(self, since=6h)` drain
5. 读本 doc + `handover/TODO.md` + `handover/PROJECT-PLAN.md` + memory `project_jianmu_ipc.md`
6. IPC harness "冷启继承"汇报
7. 任何用户 critique 落 memory feedback

**重点继承事项 · 一句话**：本 session 14h 跑了 23+ commits 完成 4 P1 主线（phys_ram_used_pct / hub-daemon / v0.5.0 / install-hooks）+ 3 P2/P3 设计 doc + 1 P0 老板派单（ADR-003 hook 失效）+ Q9 鲁棒性 5 型失效全实证。**当前 0 in-flight codex**，22:00 portfolio 重启加载 PS hook v2 advisory（new hook 才会真激活）。successor 继承 backlog 见 §5。

## 1. 时序大事记（按时段倒序）

### 16:23-16:32 · ADR-003 v2 PostToolUse 阈值 advisory ship（老板拍 A 路径）
- spike 实证 PostToolUse stderr 进 transcript（hook_success attachment before assistant final）
- AC-PS-CHECKPOINT-002 5/5 tests pass · 49% 边界不触发 + 50/65/80/95 各阈值
- 4 阈值 escalation 设计：50% silent ack / 65% escalate / 80% 必 self-handover / 95% emergency exit
- commits: `8a7f977 RED + 5aa948a GREEN + fc9eb9a fix` push origin xihe-tianshu-harness/main
- ETA 9min vs 60-90min 预算（advisory 路径直推 + 不启 fallback）

### 16:10-16:25 · ADR-003 真自动 spawn gap 评估 doc v0.1（老板派 60min）
- 老板 16:10 问 yuheng 67% 没自动交接 → harness 16:11 派 60min 评估
- jianmu-pm 16:25 ship doc v0.1（25min vs 60min 提前 35min）
- 3 路径评分：路径 1 ⭐⭐⭐⭐⭐ advisory 推 / 路径 2 ⭐⭐ 真 spawn 不可（Claude Code 无 lifecycle 接口）/ 路径 3 ⭐⭐⭐ 部署一次性成本必做
- 推 Plan A+C 组合：A 立即 ship + C 22:00 portfolio 重启
- commit `c9f46f5 docs(handover): ADR-003 真自动 spawn 设计 gap 评估 v0.1` push xihe-jianmu-ipc/master

### 15:09-15:55 · ADR-003 hook 失效 P0 老板派单（hot-fix 4 次反复 + PS native 真修）
- 15:09 老板报 hook error `/bin/bash: D:/...: No such file or directory`
- 15:15 五步法定位根因：~/.claude/settings.json 无 hooks 段 + writer.sh impl drift spec
- 15:17 hot-fix bash 绝对路径（fail · WSL bash 不解析 D:/...bash.exe）
- 15:25 老板 15:25 仍报 error → A3 止血整删 hooks 段
- 15:27 老板 critique "Windows 用 PowerShell 不绕 bash" → 治理层方向性纠正
- 15:32 tech-worker 协助起草 PS writer template 206 行（实测 4885 bytes 写 spec canonical）
- 15:34 dispatch bcd13e0ml v2 brief（用 tech-worker template + 起草剩余三块）
- 15:55 codex 闭环 4 TDD pair + install-run=ok + push（ETA 30min vs 90min · tech-worker 协作样板）
- harness 15:51 实证 ~/.claude/session-state/harness.json mtime 自动更新 = PS hook 真激活
- commits: dec86e7 install-hooks v2 PS + d1a6951 docs PS native + 1c957d9/020204b checkpoint + 920cefe/dec86e7 install + 8a7f977/5aa948a/fc9eb9a checkpoint-002

### 14:18-14:48 · 同日 P1 闭环 4 主线 + 1 P2 step 1
- **14:18 hub-daemon.vbs 时间盒** TDD + schtasks fix（origin master e694790/2f375ed/43d6f97 · 提前 ETA 04-28 3 天）
- **14:27 v0.5.0 release cut** commits 158eaf1 + 365b478 + tag v0.5.0 push origin master（提前 ETA 04-30 5 天 · 50+ commits 自 v0.4.1 累积 4 大主题：ADR-002/005/008/009 + watchdog 6/7/8 probe + hub-daemon timebox · 558→587 全绿）
- **14:48 dependabot.yml 配置修正**（a47be84 · 删不存在的 Cargo + apps/desktop · npm audit local 0 vuln · GitHub 9 vuln 多半误扫等重 scan）

### 13:48-14:03 · ADR-003 install-hooks v1 TDD（老板 13:43 派单）
- 老板 13:40 触发 self-handover（context 61% 未自动 rollover）→ 13:43 派 jianmu-pm 修
- 五步法 step 1-3 完成 30min 内：~/.claude/settings.json 无 hooks 段 + writer.sh hardcode `$HOME/.claude/...` drift spec v1.4
- bvjs0ao4l TDD 七步：dec1535 RED + 46722fd GREEN + install-run=ok push origin xihe-tianshu-harness/main
- ETA 1.5h（老板预计 2h 提前 30min）

### 05:08-05:33 · phys_ram_used_pct 第 8 probe Q9 鲁棒性压测
- harness 派 P1-b TDD §6.4 七步
- 一晚派 4 次 codex（btfq3nm92 bash quote 5h1m / br691gxlk model capacity 34min / by1kiiq0o stream disconnect 3min / **bosnf4y8s 240s cooldown 一次闭环**）
- Q9 4 派 × 3 挂 × 1 成 · work state 零污染累计递增 · rock solid 实战证明
- 最终 558 全绿 push origin/master · AC-WATCHDOG-008 grep 5 命中
- commits: e0d3baa RED + f46b7b6 GREEN + bd073ea docs

### 23:24:29 (2026-04-24) · 冷启 v1.5 7 步 + 4 段 feedback 沉淀
- 冷启继承前任 jianmu-pm 18 tasks_inflight（11 done · 6 pending）
- 沉淀 feedback：cli_flag_semantics（channels flag swap 踩坑）+ Q9 4 型失效模式锚点 + bash quote 陷阱 + Q9 follow-up brief 三要素
- 沉淀 reference：mcp_server_version_pin（hot-reload 不靠运行中 session）

## 2. Today 23+ commits 全列（按仓）

### xihe-jianmu-ipc origin/master（13 commits + 1 tag）

```
8c3eeb8 docs(handover): Hub /health 7 天 uptime 基线测量设计 v0.1 · skip-tdd: docs
c9f46f5 docs(handover): ADR-003 真自动 spawn 设计 gap 评估 v0.1 · skip-tdd: docs
e411f62 docs(handover): ADR-008 Phase 3 cold-start 场景 B 演练设计 v0.1 · skip-tdd: docs
a47be84 fix(deps): dependabot.yml 修正 · 删不存在的 Cargo + apps/desktop · skip-tdd: config
365b478 docs(handover): TODO 三 P1 闭环移已完成 + v0.5.0 prep 状态推进 · skip-tdd: docs
158eaf1 chore(release): v0.5.0 · CHANGELOG + version bump · skip-tdd: release
        + tag v0.5.0 → 158eaf1
43d6f97 chore(daemon): schtasks 触发器对齐 10min repetition · skip-tdd: config
2f375ed feat(daemon): AC-DAEMON-001 hub-daemon.vbs 时间盒改造 exit-after-once · GREEN
e694790 test(daemon): AC-DAEMON-001 hub-daemon.vbs 时间盒结构+exit+log 断言 · RED
85f1d78 docs(handover): TODO P1-b phys_ram_used_pct 闭环移至已完成 · skip-tdd: docs
bd073ea docs(watchdog): 8 项 probe + phys_ram_used_pct 说明 · skip-tdd: docs
f46b7b6 feat(watchdog): AC-WATCHDOG-008 phys_ram_used_pct probe · GREEN
e0d3baa test(watchdog): AC-WATCHDOG-008 phys_ram_used_pct 80/90 阈值 · RED
```

### xihe-tianshu-harness origin/main（10+ commits 与 tech-worker / yuheng / harness 协作）

```
fc9eb9a fix(hooks): AC-PS-CHECKPOINT-002 context advisory level throttle
5aa948a feat(hooks): AC-PS-CHECKPOINT-002 PostToolUse 阈值 advisory · GREEN
8a7f977 test(hooks): AC-PS-CHECKPOINT-002 PostToolUse 阈值 advisory · RED
a6fdbc0 fix(hooks): AC-PS-WRITER-001 restore XIHE_PORTFOLIO_ROOT writer contract · GREEN
d1a6951 docs(hooks): hooks 转 PS native · skip-tdd: docs
dec86e7 feat(hooks): AC-HOOKS-PS-001 install-hooks v2 PS pattern · GREEN
920cefe test(hooks): AC-HOOKS-PS-001 install-hooks v2 PS pattern · RED
1c957d9 feat(hooks): AC-PS-CHECKPOINT-001 checkpoint-refresh.ps1 PowerShell native · GREEN
020204b feat(hooks): AC-PS-CHECKPOINT-001 checkpoint-refresh.ps1 PowerShell native · GREEN (dup 重提交)
a99b06d test(hooks): AC-PS-CHECKPOINT-001 checkpoint-refresh.ps1 · RED
46722fd feat(harness): AC-HOOKS-001 install-hooks 工具 · GREEN
dec1535 test(harness): AC-HOOKS-001 install-hooks merge 逻辑 · RED
```

总 jianmu-pm 推进 **23 commits + 1 tag**（其中 doc-only commits 7 个 · skip-tdd: docs/release/config 豁免）。

## 3. 当前状态（22:00 重启切换前）

### 3.1 Git 状态
- **xihe-jianmu-ipc**: clean working tree · ahead 0 vs origin/master（最末 commit 8c3eeb8 push 完）
- **xihe-tianshu-harness**: clean working tree（codex 自动 push 完 fc9eb9a）

### 3.2 in-flight 工作
**0 codex in-flight** · 0 写盘 dirty · 0 待 push commits

### 3.3 ~/.claude/settings.json hooks 段
- 已 install PS hook 4 commands（PostToolUse + Stop 各 2 commands · checkpoint-refresh.ps1 + session-state-writer.ps1 + handover-threshold-check.ps1）
- 全用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <path>` 模式（不依赖 /bin/bash 解析）
- 但 **本 session 启动时（昨晚 23:21）settings.json 还没 hooks 段** → 本 session hook 未激活（hot-reload 限制）→ jianmu-pm.json mtime 仍是手写 23:14
- **22:00 重启后 successor 起来 settings.json hooks 已 install → PS hook 真激活**

### 3.4 portfolio 状态（截至 16:33）
- 主 Hub pid 47892 跑稳 19h+
- network-watchdog 独立 :3180
- hub-daemon.vbs 时间盒 schtasks 10min repetition
- install-cliproxy-daemon 在跑
- portfolio 双副本 ready · 22:00 重启 Hub 不下线

## 4. 关键决策与教训

### 4.1 老板 critique 转 PS native（治理层方向性纠正）
- **教训**：bash 是 Linux/Mac shell，Windows 一等公民是 PowerShell。15:17 hot-fix 用 bash 绝对路径 fail（WSL bash 不解析 D:/...bash.exe）；15:25 hot-fix 仍 fail；15:27 老板 critique 转 PS native；15:55 PS rewrite 闭环。
- **沉淀**：ADR-003 hook 不绕 /bin/bash，直接调 powershell.exe（Windows PATH 默认 · 不需 detect 路径）。
- **联想**：treasury 治理层"工具/路径解析"层踩坑 4 次（codex UAC + SSH proxy + vitest v4 + hook bash）= **底层用错 shell 是共性根因**。

### 4.2 tech-worker 非阻塞 contribute 协作样板
- **场景**：15:32 我刚 dispatch 自起 brief（含内嵌 PS sample 未自跑），tech-worker 同时 ship `temp/tianshu/session-state-writer.ps1` 206 行实测过 + 自测 4885 bytes 写 spec canonical。
- **决策**：TaskStop brf50t457 + cp tech-worker template + 写 follow-up brief（v2 缩短 90min → 30min ETA）= 不重做已实测的 work。
- **联想**：portfolio cooperation flywheel 第三种形态（与 yuheng aggregator + harness coordinator 并列）：**非阻塞 contribute**（不抢 ownership 但贡献材料）。

### 4.3 Q9 鲁棒性压测最极端 case 实证
- **场景**：phys_ram_used_pct 第 8 probe TDD 一晚派 4 次 codex 挂 3 次（btfq3nm92 bash quote 5h1m / br691gxlk model capacity 34min / by1kiiq0o stream disconnect 3min）→ bosnf4y8s 240s cooldown 一次闭环。
- **决策**：TDD 分 commit 设计 + follow-up brief 三要素（现状核对 + 禁覆盖清单 + 缺失 step-by-step）= work state 零污染 · 累计进度递增 · rock solid 防御。
- **沉淀**：feedback_codex_dispatch.md 4 段（bash quote 陷阱 / Q9 4 型失效锚点 + 4 例矩阵 / Q9 follow-up brief 模板三要素 / heredoc + codex exec 同 Bash call 禁止）= portfolio dispatch 层最完整防御手册。

### 4.4 ADR-003 hook 失效 6 天历史欠账
- **真因**：tech-worker A5 2026-04-19 21:00 应落地 Stop hook（ADR-002 §二 cherry-pick oh-my-claudecode），实际**只起草 templates/hooks-snippet.json 模板**未 install 到 user settings.json。6 天没人发现，直到 2026-04-25 13:40 老板 context 61% 未自动 rollover 暴露。
- **教训**：模板落档 ≠ 上线 install。需要 install-hooks 工具 + 部署一次性成本（老板低活动期统一重启）。
- **沉淀**：install-hooks.mjs 工具（detect Git Bash → 后撤 → PowerShell native command pattern）+ ADR-003 v2 PostToolUse 阈值 advisory + ADR-004 portfolio 自动交接立项（harness 16:30 落 ADR-004 v0.1）。

## 5. Successor 应继承的 backlog

### 5.1 22:00 重启后立即做（successor 第一件）
1. **冷启 v1.5 7 步**（含读 `D:/.../.session-state/jianmu-pm.json` last breath，应已含 PS hook v2 自动写的 fresh mtime）
2. **IPC harness 报"冷启继承 + PS hook v2 已激活"** · 含本 session 战绩简报
3. **观察 hook v2 真激活**：手跑一个 Bash → 检查 `D:/workspace/ai/research/xiheAi/.session-state/jianmu-pm.json` mtime 是否 < 30s 内更新 + 是否含正确 git snapshot
4. **派 codex follow-up 增量 case 6**（tester-worker 16:35 review 发现）：
   - AC-PS-CHECKPOINT-002 当前 5 case 含 49% 边界 + 50/65/80/95 各一阈值
   - **缺 case 6**：30min throttle 测试 · 同 session 50% hit 后 30min 内再次 PostToolUse 应 silent（避免 advisory 疲劳）
   - checkpoint-refresh.ps1 v2 实现已含 throttle（contextStampFile + ContextThrottleSec 1800），但对应 RED 测试 case 缺
   - follow-up brief：在 `tests/checkpoint-refresh-context.test.mjs` 加 case 6 · invoke 两次同阈值 · 第二次 stderr 无 [CONTEXT-N%] tag
   - ETA ~15-20min Codex TDD 单 case 增量 commit
   - 仓 = xihe-tianshu-harness · push origin main

### 5.2 P1 待跟（本周内）
1. **bug 2 self-handover-slim v0.2 review**（等 harness 出稿 ETA 04-28 · 我 standby）
2. **ADR-008 Phase 3 cold-start 演练执行**（design 已 ship e411f62 · 等老板 + portfolio session 选 yuheng_builder 当对象）
3. **dependabot 9 vuln 排查**（等 GitHub 重 scan a47be84 配置修生效后看真清单 · 多半归零或大幅缩减）

### 5.3 P2/P3 已设计 等执行
1. **Hub /health 7 天 uptime 基线测量**（设计 ship 8c3eeb8 · 起跑窗口 2026-05-01 至 05-08 · 需写 baseline-collector.mjs + report.mjs · ~3-3.5h Codex TDD）

### 5.4 协调中（harness 主驱）
- **ADR-004 portfolio 自动交接**（harness 落 v0.1 草稿 · 引用本 session spike 实证 + yuheng eb8095b 5min 闭环）
- **22:00 portfolio 重启 hook rollout**（harness coordinator · 16 active session · 23:00 全 advisory 真激活）

### 5.5 v0.6.0 议题（中长期）
- ADR-003 v3 真自动 spawn successor（绑 portfolio-boot 脚本 + ADR-008 Phase 3 演练）
- collector 持续监控 → portfolio 长期 health snapshot
- Grafana / 自部署 dashboard

## 6. 协作历史精简

| 协作方 | 频率 | 主要内容 |
|---|---|---|
| **harness** | 极高（~30+ IPC 互动） | coordinator 派单 / 拍板 / 跨 session 协调 / 评估 review |
| **tech-worker** | 高（5+ IPC 协作） | bash 路径解析诊断 + PS template 起草 + Q9 mode 数据点 + portfolio rollout 验证站 |
| **xiheAI** | 中（Q9 mode #3 例 c · 第 3 例实证沉淀） | brwwtgwr7 stream disconnect 案例补 |
| **yuheng_builder** | 中（v1.0.5 主驱 + audit-checklist） | 治理文档主驱 + 演练候选对象（推） |
| **codex** | 极高（10+ codex dispatch） | 自动化干活实施层 |

### 重点 IPC 时序节点
- 13:43 老板派 ADR-003 hook 修
- 15:27 老板 critique 转 PS native（治理层方向性纠正）
- 16:10 老板问 yuheng 67% 没自动交接
- 16:18 老板拍 A+C 组合
- 16:18 harness 通告 22:00 portfolio 重启

## 7. 已知坑 + 不动项

### 7.1 不动项（前任遗留 · 不要 stage）
- `xihe-tianshu-harness/handover/HANDOVER-HARNESS-20260425-1343.md`（前任 harness session 的 self-handover · 89d6be5 已 push）
- `xihe-tianshu-harness/handover/DESIGN-bug-2-self-handover-slim.md`（harness WIP）
- `xihe-tianshu-harness/samples/heartread-template/*`（heartread 模板）
- `xihe-jianmu-ipc/handover/jianmu-HANDOVER.md`（之前的 handover · M 状态 · 不动）

### 7.2 老板 PS profile 23:00 改回不动
- 老板 PS profile 已改回 `--dangerously-load-development-channels`（昨晚 23:00 自改）
- 不要再 swap 回 `--channels server:ipc`（feedback_cli_flag_semantics 严守）

### 7.3 GitHub dependabot 9 vuln 缓存值
- push response 仍报 9 vuln 是 GitHub 缓存值
- a47be84 配置修后 dependabot 重 scan 数字会变
- 不主动 npm audit fix（npm audit local 已 0）· 等 GitHub 真清单

### 7.4 portfolio 18 session 一次性部署成本
- 22:00 重启时段必含 30min downtime
- brand-builder + tianfu_builder 标 dormant/freeze 不参与
- 16 active session 参与重启 → 装 PS hook v2 真激活

## 8. 性能与资源 snapshot（22:00 前）

- **Hub /health uptime**：~21h（pid 47892 自 2026-04-24 20:46 跑）
- **物理 RAM**：~67% used（昨晚 02:23 老板睡时 41%，今天负载稳定）
- **commit% (V8 pagefile)**：~85%（new normal · 老板 commit% gate 作废后）
- **`npm test` 基线**：587 全绿（v0.5.0 cut 时 558 + AC-DAEMON-001 + AC-WATCHDOG-008 等）
- **Hub messages.db size**：~待测（下次基线测量收）

## 9. 推荐 successor 第一周节奏

| 时段 | 动作 |
|---|---|
| 22:00-22:30 | 22:00 portfolio 重启窗口 · 等老板 spawn |
| 22:30-23:00 | successor 起 + 冷启 v1.5 7 步 + IPC harness 冷启继承 |
| 23:00-Day end | 验 PS hook v2 advisory 真激活（手跑 Bash + 看 mtime + 等 50% 阈值实测）|
| 04-26 | bug 2 v0.2 review 等 harness 出稿 / dependabot 9 vuln 等 GitHub 重 scan |
| 04-27/04-28 | ADR-008 Phase 3 演练执行（与 yuheng + harness 协调） |
| 04-29/04-30 | bug 2 v0.2 review 完后 ship · ADR-008 Phase 3 演练简报 |
| 05-01 | Hub /health 7 天 uptime 基线起跑窗口 |

## 10. 版本

| 版本 | 日期 | 作者 | 说明 |
|---|---|---|---|
| v1.0 | 2026-04-25 16:40 | jianmu-pm | 22:00 portfolio 重启 self-handover · schema v2 8 字段 + 23 commits + 4 段教训 + 5 段 backlog |
