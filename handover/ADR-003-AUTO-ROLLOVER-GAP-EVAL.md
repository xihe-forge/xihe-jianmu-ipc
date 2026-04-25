# ADR-003 真自动 spawn 设计 gap 评估 + v2 推荐

**日期**：2026-04-25
**作者**：jianmu-pm
**触发**：老板 16:10 IPC 问 yuheng_builder 67% context 为什么没自动交接 → harness 16:11 派 jianmu-pm 60min 评估
**状态**：草案 v0.1 等 harness review + 老板拍板

---

## 1. 背景：现象与 gap

### 现象（老板观察）
yuheng_builder context % 触达 67%（超 ADR-002 §二 设计的 60% level 2 阈值），**未自动 spawn successor + 未自动 self-handover**。

老板期望：session 触达 50%/65% → 自动 spawn 新 successor → 老 session 自然 retire。

### 当前 ADR-003 hook 能力（v1 ship 后）
- **PostToolUse hook**：每次 Tool 调用后触发 `checkpoint-refresh.ps1`（advisory 提示）+ `session-state-writer.ps1`（dump state.json，**不查阈值**）
- **Stop hook**：每次 turn 结束后触发 `handover-threshold-check.ps1`（查 context %，三级 stderr 警告，≥65% 输出 block decision JSON）+ `session-state-writer.ps1`（dump state）
- **harness 实证**：~/.claude/session-state/harness.json mtime 15:51:04 自动更新 = writer.ps1 真激活

### Gap 清单（设计层）
1. **PostToolUse hook 不查阈值** —— 只 dump state，不提示 context %
2. **Stop hook 查阈值但只 block/warn** —— 输出 decision JSON 给 Claude Code，但 **不能 spawn successor**（Claude Code agent harness API 限制）
3. **settings.json session-start cache** —— portfolio 18 session 大部分启动时 hook 是旧的，必须重启才装新 hook
4. **hook 架构本身无 spawn successor 能力** —— Claude Code hook 是 sync command spawn，无 cross-session control 权限

---

## 2. 三路径可行性评分

### 路径 1 · PostToolUse 加阈值检查 ⭐⭐⭐⭐⭐（推荐）

#### 设计
扩展 `checkpoint-refresh.ps1`：
- 读 `$env:CLAUDE_CODE_TRANSCRIPT_PATH`（与 handover-threshold-check.ps1 同源）
- 解析 transcript file 末尾 4096 bytes，提取 `input_tokens` + `context_window`
- 计算 pct，三级阈值：50% / 65% / 80%
- 输出 stderr 提示给当前 turn

#### 关键认知
**PostToolUse stderr 是否注入 conversation？** —— 实测需验证。
- 若进 turn → AI 看到 stderr 提示 → 自驱手动 self-handover（路径 1 work）
- 若不进 turn → 等价于无操作 → 退化为 Stop hook 兜底（路径 1 fail）

**Stop hook 已实现 65% block decision JSON**（handover-threshold-check.ps1 380 行 .sh + PS 重写已 ship），block decision 进 turn 是 Claude Code 文档明确支持。所以 **Stop hook 的 65% block 已能让 AI 自驱手动 self-handover**——实际 yuheng 67% 没触发是因为：
- yuheng session 启动时 settings.json 没 hooks 段（portfolio rollout gap）
- 或 yuheng session 持续不到 Stop event（一直 in-flight 没自然 turn 结束）

**所以路径 1 真正价值**：在 **PostToolUse 高频触发**（每次 Tool call 后即时）覆盖率优于 Stop（需 turn 结束才触发，长任务可能跑很久不到 Stop）。

#### 可行性评分
- 技术可行：⭐⭐⭐⭐⭐（脚本改动小，参考 handover-threshold-check.ps1 现有 estimate-context-bp 逻辑）
- 成本：低（~30-60min Codex 派活）
- 可靠性：高（advisory，不阻 user 操作）
- 风险：stderr 是否进 turn 需 spike 实证

#### 实施分解
1. checkpoint-refresh.ps1 扩 estimate-context-bp 函数（复用 handover-threshold-check.ps1 同实现）
2. 50%/65%/80% 三级 stderr 输出（文案参考 Stop hook level1/2/3）
3. ≥95% 静默放行（避免 compaction 死锁同 Stop hook）
4. 30min throttle stamp file（沿用 checkpoint-refresh.ps1 现 throttle）
5. AC-PS-CHECKPOINT-002 TDD case 4 个：50%/65%/80%/95%
6. RED→GREEN + push + 实际跑 install 触发新 hook（老 session 仍需重启）

### 路径 2 · 真 spawn successor ⭐⭐（不推荐）

#### 选项 2.1 · ipc_spawn 起 child session
**否定**：起 child 不是 successor，老 session 不会自动 retire（context 没满之前不会 stop）。父子并存违反"接力"语义。
- 即使加"父 session 调 `/exit` 自杀"逻辑，依赖 AI 自觉，与"自动"目标不符
- ipc_spawn 是 IPC 工具不是 lifecycle 工具

#### 选项 2.2 · 外部 daemon scan
**hub-daemon.vbs 或独立 watchdog 加 scan 逻辑**：
- 读 .session-state/*.json 的 last_heartbeat / pid uptime / dirty_files / tasks_inflight
- 估算 context %？**不可靠**：
  - last_heartbeat：只是 hook 触发频率，不反映 context
  - pid uptime：session 启动时间不等于 context 累积（IDE close 后 reopen 仍同 session）
  - tasks_inflight count：不同 session 工作密度差 10x
- **真 context % 数据在 transcript jsonl 里**（input_tokens / context_window），daemon 要：
  - 找当前活跃 transcript file（每 session 一个 jsonl）
  - 解析末尾 token 字段
  - daemon 与 Claude Code 进程对应关系不明确（pid → transcript path 映射 Claude Code 内部数据）

#### 选项 2.3 · Claude CLI 起新 session 替老
- daemon detect 老 session 阈值 → spawn 新 Claude Code instance（同 IPC name）+ 让老 session 自杀
- 复杂：需 Claude Code daemon 接口（不存在）+ 跨进程 ipc-reclaim-my-name + 老 session 接收 SIGTERM 优雅退场（agent 不响应 OS signal）

#### 可行性评分
- 技术可行：⭐⭐（daemon 可写但不可靠 + Claude Code 缺 lifecycle 控制接口）
- 成本：高（~3-5h 设计 + impl + 测试）
- 可靠性：低（无可靠 context % 数据源 + 进程映射不明）
- 风险：高（误判触发抢救 spawn 浪费资源 + 老 session 不自杀变 zombie）

**结论**：留 ADR-003 Phase 4 候选 + 绑 ADR-008 Phase 3 演练 + portfolio-boot 脚本一并设计。**当前不推**。

### 路径 3 · settings.json hot-reload 限制 ⭐⭐⭐（部署一次性成本，必做）

#### 现状
- Claude Code session-start 时 cache `~/.claude/settings.json` hooks 段
- portfolio 18 session 中只有 install-hooks v2 ship 后启动的新 session 装新 hook（< 5 个）
- 大部分老 session 仍跑无 hook 状态

#### 解法
**A · 老板低活动期统一指令重启**：
- 老板某时段 IPC `【全 portfolio 重启】低活动期重启全 session 装新 hook`
- 各 session 完成 in-flight task → IPC last breath → /exit → 老板手动 `ipc <name>` 重启
- 一次性 ~30min portfolio downtime

**B · portfolio-boot 脚本**（绑 xihe-tianshu-harness P1 bug 8 + ADR-008 Phase 3 演练）：
- 脚本读 `~/.claude/sessions-registry.json` 列全 session
- 对每个 session 调 `ipc_reclaim_my_name(name)` evict 老 + spawn 新（用新 IPC_NAME env）
- 自动化批量重启
- 复杂度中（~2-3h impl）

**C · accept reality**：新 session 启动自然装新 hook，老 session 跑到自然 lifecycle 结束（context 满 + 手动 self-handover）

#### 可行性评分
- A：⭐⭐⭐⭐（简单可靠，需老板时段配合）
- B：⭐⭐⭐（自动化更优，但开发成本高 + portfolio-boot 待立项）
- C：⭐⭐⭐⭐⭐（零成本，自然衰减）

**推 A + C 并行**：老板下次低活动期重启活跃 session（A），其他 session 自然衰减（C）。B 留中长期。

---

## 3. 推荐 v2 设计 · PostToolUse 阈值提示 + Stop block 兜底 + 部署一次性成本

### v2 hook 链路升级
```
PostToolUse 触发
  → checkpoint-refresh.ps1 (advisory + context% 阈值提示)
    - 50% Level 1: stderr "建议下一 turn 结束自查 /compact"
    - 65% Level 2: stderr "建议立即写 .session-checkpoint.md + IPC harness"
    - 80% Level 3: stderr "立即 self-handover：写 HANDOVER + ipc_spawn successor + /exit"
    - ≥95%: 静默放行（避免 compaction 死锁）
  → session-state-writer.ps1 (dump state · spec canonical xiheAi/.session-state/)

Stop 触发
  → handover-threshold-check.ps1 (现有逻辑保留 · 65% block decision JSON 兜底)
  → session-state-writer.ps1 (dump state · 最后一次心跳)
```

### 关键设计原则
1. **PostToolUse 高频提示 + Stop 兜底**：双层防御。PostToolUse 即时通知，Stop turn 结束兜底
2. **AI 自驱手动 self-handover** 比"daemon 自动 spawn"更可靠：AI 知道当前任务 + 能写好 HANDOVER 主观字段
3. **不真 spawn successor**：Claude Code agent harness 限制不可绕，PHP-1 真自动留 Phase 4
4. **deployment 一次性成本承担**：老板低活动期统一重启活跃 session

### v2 实施分解（路径 1 实施）
| 任务 | Owner | ETA |
|---|---|---|
| AC-PS-CHECKPOINT-002 4 case TDD（50/65/80/95 阈值 stderr 提示） | jianmu-pm 派 codex | 30-45min |
| checkpoint-refresh.ps1 加 estimate-context-bp 复用 handover-threshold-check.ps1 实现 | codex 起草 | 同上 |
| spike 实证 PostToolUse stderr 是否进 turn | jianmu-pm 实测（spawn test session 触发 50% 看 AI 是否回应） | 15min |
| 若 stderr 不进 turn → 改用 stdout decision JSON（参考 Stop block）| codex 派活 | 30min（fallback path） |
| docs 同步 session-cold-start.md / ADR-003 落 v2 段 | harness | 15min |
| portfolio rollout 老板低活动期重启活跃 session | 老板指令 + 各 session 配合 | 30min |

### Phase 4 候选（中长期）
- 真自动 spawn successor 设计（绑 portfolio-boot 脚本 + ADR-008 演练）
- 复杂度高 + 老板未必需要（v2 自驱手动够用）
- 留 ADR-003 v3 议题

---

## 4. 风险评估

| 风险 | 缓解 |
|---|---|
| PostToolUse stderr 不进 turn → 路径 1 fail | spike 实证 15min 内验证 + fallback 改 stdout decision JSON（与 Stop block 同模式） |
| 50% 阈值过早 throttle 30min 烦 | throttle stamp file 沿用 + 50% Level 1 仅每 30min 提示一次 |
| 老板期望"真自动"不是 advisory → 不满意 | 评估 doc 明示真 spawn 限制 + 推荐 v2 advisory 路径 + Phase 4 候选 |
| portfolio rollout 一次性重启 30min 流速降 | 选低活动期（如夜间 22:00 后）+ 提前 30min 广播 |

---

## 5. 推荐决策（请老板拍板）

### Plan A · v2 path 1（PostToolUse 阈值提示） + 路径 3 解法 A（老板低活动期统一重启）
**ETA 1-2h ship + 30min portfolio rollout**
- v2 ship 后老 session 重启即装载（一次性成本）
- AI 自驱手动 self-handover（advisory 模式，老板可干预）

### Plan B · 等 Phase 4 真自动 spawn 设计
**ETA 3-5h 设计 + impl 不可靠**
- 不推荐：技术上限（Claude Code 无 lifecycle 接口）
- 后续可留作 Phase 4 议题（绑 portfolio-boot + ADR-008 Phase 3）

### Plan C · accept current Stop hook 65% block decision 已够用
**ETA 0**
- yuheng 67% 没触发是因为 settings.json 没 hooks 段（部署 gap，非设计 gap）
- portfolio rollout 后 Stop hook 会触发 yuheng 65% block
- 不推荐：Stop hook 触发频率受 turn 影响，不及 PostToolUse 即时

**推 Plan A**：v2 PostToolUse 阈值提示 + 部署一次性成本承担。

---

## 6. 老板答疑要点

| 老板问题 | 答 |
|---|---|
| yuheng 67% 为什么没自动交接？| 双因：(1) 她 session 启动时 settings.json 没 hooks 段（portfolio rollout gap）(2) 即使有 hook，当前 Stop hook 65% block 也只是提示 AI 写 HANDOVER，不真 spawn successor（Claude Code agent harness 限制）|
| 真自动 spawn 能做吗？| 当前 Claude Code agent harness 限制无 lifecycle 控制接口，无法 hook 触发跨 session spawn。绕道 daemon 不可靠（context % 数据源问题）。**留 Phase 4 候选**，当前 v2 走 advisory 路径 |
| advisory 路径足够吗？| 在 PostToolUse 高频提示下，AI 看到 stderr 50%/65%/80% 阈值警告会自驱写 HANDOVER + ipc_spawn successor + /exit。比 daemon 自动更可靠（AI 知任务 + 写好 HANDOVER） |
| 部署一次性成本如何承担？| 选你低活动期 IPC `【全 portfolio 重启】`，30min 内全 session 完 in-flight + last breath + /exit + 老板手动 `ipc <name>` 重启装新 hook |

---

## 7. 版本

| 版本 | 日期 | 作者 | 说明 |
|---|---|---|---|
| v0.1 | 2026-04-25 16:25 | jianmu-pm | 草案，60min ETA 内出（耗 ~25min）· 等 harness review + 老板拍板 Plan A/B/C |
