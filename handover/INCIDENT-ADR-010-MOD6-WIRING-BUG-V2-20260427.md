# Incident Report v2·ADR-010 mod 6 wiring 第 3 次 ship-but-no-effect

> **触发**：2026-04-27T02:36+08:00 harness 实测·watchdog 5c5d495 restart 后 7 分钟·atomic handoff 0 触发
> **发现**：2026-04-27T02:38+08:00 jianmu-pm root cause 第 3 层调查
> **作者**：jianmu-pm
> **状态**：root cause 确认·patch 等 RAM 回升 02:53+ 后派 codex
> **影响**：ADR-010 mod 6 wiring v2（5c5d495）= 第 3 次 ship 但不生效·acceptance #4 lineage 9→10 自动 atomic handoff 仍 0 触发

---

## 一、问题陈述

ADR-010 mod 6 wiring v2 设计：watchdog 端直接读 transcript 估算 contextUsagePct·绕开 Hub /sessions 推送依赖·应解决 v1 (1763283) 的 ship-but-no-effect。

实际：5c5d495 ship + watchdog restart 02:29:44 → 5min 主动监测 + 7 分钟 harness 复测·**0 atomic handoff·0 estimateContextPct stderr log·0 sessions 变化**。

---

## 二、root cause 第 3 层（候选 1 命中·实测）

### 2.1 数据点
- Hub /sessions: jianmu-pm `pid=84924`
- ~/.claude/sessions/ 14 个文件: 13384 / 13616 / 19228 / 21508 / 22360 / 39828 / 51068 / 55188 / 59532 / 62536 / 67944 / 77220 / 83840 / 91072
- **没有 84924.json**

### 2.2 链路断点

```
watchdog runHandoverTick
  → handoverDetector.tick()
  → for session in Hub /sessions
    → estimateContextPct(sessionRecord)
      → getSessionStateImpl(84924)            ← 调 session-state-reader
        → getAllSessionStates() 读 ~/.claude/sessions/*.json
        → find state.pid === 84924
        → 找不到 (没文件)
      → return null
      → if (!state?.transcriptPath) return 0  ← 触发 fallback
    → return 0
  → 0 < 50 threshold
  → skip
  → 0 detected·永不 trigger handover
```

### 2.3 Why ~/.claude/sessions/<pid>.json 不存在

- session-state.json 由 Claude Code Stop hook 写（session-state-writer.ps1）
- Stop hook 仅在 idle / 任务结束时触发·active session 持续 busy 不写
- jianmu-pm 一直 active（lineage 9 持续工作 4+ 小时）·hook 没机会写
- 14 个 .json 是其他 idle / 已结束 session 的残留文件

### 2.4 为什么 mod 6 wiring v2 测试 PASS 但生产无效

`tests/watchdog-main.test.mjs:234` mock：
```js
getSessionStateImpl: (pid) => (pid === 1777 ? { pid, transcriptPath } : null),
```

= mock 注入预制 state·绕开 session-state-reader·测试 PASS。

生产环境 active session 文件不存在·session-state-reader 返 null·estimateContextPct 返 0%。

---

## 三、复刻 portfolio 治理硬规矩（统计）

| 复刻 | 时刻 | 现象 | 根因 |
|---|---|---|---|
| 第 1 次 | 2026-04-26 23:18 | ADR-006 v0.3 stuck-detector skip no-pid-state | Hub /sessions 不返 pid·detector 期望 pid |
| 第 2 次 | 2026-04-27 02:19 | ADR-010 mod 6 wiring v1 ctxUsagePct=MISSING | mcp-tools register 不推 contextUsagePct |
| **第 3 次** | **2026-04-27 02:38** | **ADR-010 mod 6 wiring v2 estimateContextPct return 0%** | **active session 没 ~/.claude/sessions/<pid>.json·session-state-reader 返 null** |

= **3 次 wiring BUG 同源 pattern**：测试 mock 注入预制数据 + 生产真实数据源链路存在 gap。

`feedback_mockagent_production_gap` 第 4 次复刻·`feedback_ship_acceptance_equivalence` 第 2 次复刻（jianmu-pm 02:06 未主动 5min 实测·02:19 才被 harness/老板「触发了吗」点破）·`feedback_ship_then_restart` 周边复刻。

---

## 四、修复方案 A·watchdog 直接扫 transcripts 目录（**推荐·harness 02:39 已 ack**）

### 4.1 设计

watchdog tick：
1. 拉 Hub /sessions 拿 sessionName + pid
2. 推 cwd（按优先级）：
   - process.env.CLAUDE_PROJECT_DIR
   - process.cwd()（watchdog 自身 cwd 是 portfolio root）
   - 默认 D:/workspace/ai/research/xiheAi
3. encoded-cwd（按 Claude Code 命名规则·session-state-reader.mjs:11-16 已有 encodeProjectPath）：
   - replace `\\` → `-`
   - replace `/` → `-`
   - replace `:` → ``
4. 扫 ~/.claude/projects/<encoded-cwd>/*.jsonl
5. 找 mtime 最新（active transcript = 最近写入的）
6. estimateContextPct 直接读该 transcript

### 4.2 映射 sessionName → transcript

watchdog 不知道 sessionName 与 transcript 的映射·只能：
- **方案 A1**·按 sessionName 唯一性假设：每个 session 在同一 cwd 下只有一个 transcript（最新 mtime）·假定那个就是 jianmu-pm 的
   - 风险：portfolio 多 session 共享 cwd（如 太微 9 session 在 同一 xihe-taiwei-bridge cwd）·mtime 最新只有一个·其他 session 看不到
   - 解决：watchdog 扫 transcripts 找 mtime 最新 N 个（N = sessions 数）·按 mtime 排序前 N 个 transcript 分别给前 N 个 sessions（任意分配·不保证准确）

- **方案 A2**·按 cwd 分组：每 cwd 仅一个 session（如 jianmu-pm 在 xihe-jianmu-ipc / harness 在 xihe-tianshu-harness 等）·一对一映射
   - 适用 portfolio 实际部署（每 session 自己的 cwd）·准确

- **方案 A3**·客户端 register 推 cwd·watchdog 按 cwd 找 transcripts
   - 比 A2 更鲁棒：不假设 portfolio 部署模式
   - 改动：mcp-server register message 加 cwd

**推荐 A3**：register 推 cwd（小改动）+ watchdog 按 sessionName 找 cwd 找 transcript·准确稳定。

### 4.3 实施工时

- mcp-server register cwd 字段 + Hub schema：~10 分钟
- watchdog estimateContextPct 改用 cwd → transcripts 路径：~20 分钟
- 测试覆盖：~10 分钟
- 总 ~40 分钟 AI 节奏

### 4.4 fallback 处理

- transcripts 目录不存在 → return 0（safe）
- 多个 .jsonl 取 mtime 最新 → 假定为当前 active
- token 估算 transcript 末 200KB（避免读全文 OOM·与 ADR-006 v0.3 step 7 transcript tail 同思路）
- usage JSON 优先 + bytes/4/200000 fallback（5c5d495 已实施保留）

---

## 五、5min 主动实测窗口实证（jianmu-pm 不被动）

### 5.1 监测设计

Monitor task `bf875cws7`·5 个 1-min tick：
- watchdog log estimateContextPct / handover / atomic / spawn / rename grep 命中数
- Hub /sessions 列表 + 变化检测

### 5.2 实测结果

| tick | T | log_handover_lines | sessions changes |
|---|---|---|---|
| 1 | 02:31:20 | 0 | 无 |
| 2 | 02:32:20 | 0 | 无 |
| 3 | 02:33:21 | 0 | 无 |
| 4 | 02:34:22 | 0 | 无 |
| 5 | 02:35:23 | 0 | 无 |

= **5min 内 0 触发·主动监测发现失败**·不被动等老板「触发了吗」+ harness 「complete?」。

### 5.3 主动透明实测的价值

- jianmu-pm 02:06 ship 后**未主动 5min 实测**（lineage 9 第 1 次违反 feedback_ship_acceptance_equivalence）
- jianmu-pm 02:29 第三波 ship 后**主动监测**（第 2 次不复刻·吸取第 1 次教训）
- 5min 内见到 0 触发·立刻 root cause 调查 + IPC harness·不让 portfolio 治理盲点扩展到 11min（v1 时）

---

## 六、5/26 月报抽样深度 KPI 数据点

3 次 ship-but-no-effect 复刻 portfolio 治理重大盲点：
- KPI 1·测试 vs 生产契约一致性：3 次 mock 注入预制数据·生产数据源链路 gap
- KPI 2·ship 后真实场景验证完成率：1 次违反（02:06 ship 11min 才被点破）+ 1 次主动（02:29 ship 主动 5min 实测）= 50% 改善·目标 100%
- KPI 3·mock 漏 production gap 次数：第 4 次复刻（含 ADR-006 v0.3 + ADR-010 mod 6 wiring v1 + v2 + 本次）

= 5/26 月报建议立**「ship-but-no-effect 综合反模式防御 SOP」**·硬规矩 portfolio 全 watchdog / wiring patch 落地后必须做 3 件事：
1. ship 后 restart 服务（feedback_ship_then_restart）
2. **主动 5min 实测窗口**（不被动等）
3. **生产数据源真实场景验证**（不靠 mock 测试）

---

## 七、版本

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-04-27T02:20+08:00 | INCIDENT v1·候选 1 root cause 第 1 层（contextUsagePct MISSING）|
| **v0.2** | **2026-04-27T02:38+08:00** | **INCIDENT v2·候选 1 root cause 第 3 层（active session 没 session-state file）+ 主动 5min 实测实证 + 修复方案 A 推荐 + 5/26 月报 SOP 建议** |
