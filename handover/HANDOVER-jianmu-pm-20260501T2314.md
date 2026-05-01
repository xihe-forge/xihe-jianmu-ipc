# jianmu-pm self-handover · 2026-05-01T23:14+0800

## 今晚 ship 列表（按 commit 时序）

| commit | 说明 |
|---|---|
| `f7715af` | codex 启动检测 + bridge retry（让 ipcx 启动的 codex 能被 IPC push 唤醒） |
| `4e81257` + `3213912` | mcp-server 自己监听退出信号·parent 死后 self-exit |
| `2577539` | **真 leak 根因 fix**·mcp-wrapper.mjs lifecycle handler·SIGTERM forward + close child stdin·防 zombie 累积（之前每天漏 300+ 个） |
| `a0d2a0c` | hub 路由用 canonical session name 覆盖 from·防 fallback 名污染审计·name 字符集 enforce + audit fields |
| `7c8f02f` (xihe-tianshu-harness) | UserPromptSubmit hook ship·注入 [查证] [更新任务清单] [时间戳] [说人话] [工时评估] 5 条规则到 LLM context |
| `26d096e` | watchdog rate-limit critique dedup 5min → 30min |
| `27ee7b1` | atomic handoff 门槛 90% → **50%**·watchdog 优先读 contextWindow.used_percentage 真值·避免 MCP estimate stale |
| `bccbf68` | watchdog dedup 状态写文件·重启不丢 |
| `32ac545` | 7 天用量警告阈值 80% → 95%（老板拍·5h 仍 70%） |
| `603ac60` | `isGitTreeClean` 加 `--untracked=no`·忽略 portfolio drafts·不阻自动换班 |

K.X-1 (codex CLI UI 显示「← ipc:」first line) 改动合并在 `2577539`·实际功能 ship。

## 当前已知问题

1. **CC 自升级中断**（5-1 02:20 timestamp）·`claude.exe` 被改名成 `claude.exe.old.1777647812587`·新版没装上。我手动 rename 回去恢复·**老板可考虑跑 `npm install -g @anthropic-ai/claude-code` 真升级新版**·或保持当前旧版稳定。

2. **portfolio 老 session mcp-wrapper 仍旧版**（K.Y-1 ship 前启动的·没 lifecycle handler）·它们以后退出仍会漏一次。新启动 session 用新版·不漏。彻底清需 portfolio 19 session 全重启换新版（或自然 atomic handoff 换班）。

3. **install.ps1 hardcoded 路径**·外部 npm 用户装 jianmu-ipc 包时·`Push-Location 'D:\workspace\ai\research\xiheAi'` 不存在·ipc 函数 fail。K.S brief 已起·没派 codex bg·留待后续。

4. **codex 0.125 known issue**·sometimes false-success（exec exit 0 但实际 partial）·heartread 端有完整调研·portfolio 共用知道。

5. **物理内存压力**·47.7GB total·portfolio 19 session + 浏览器 + IDE 累积常 80%+·node 子进程 100+ 个正常（不全 zombie）·真 leak 已 K.Y-1 堵。

## hooks 当前 5 条（pre-prompt-reminder-rules.txt · `xihe-tianshu-harness` repo）

```
[查证] 回答前每个事实先查清·30 秒能查的必查。
不确定的明说"这是猜的没查"·别装作确定。
答完先扫一遍·有没说"猜的"但其实没查的·有就回头查再答。
[更新任务清单] 答前/答中/答后记得更新任务清单·新任务 TaskCreate·状态变 TaskUpdate·别让清单漂移。
[时间戳] 写时间戳前必跑 date 真值·别累加叙事时间。
[说人话] 跟老板说话用人话·禁内部代号 (K.X / ADR-XX) / 禁缩写 / 禁堆术语墙 / 禁表格 §段号 / 禁堆英文专有词。短·清楚·人能看懂。
[工时评估] 估时间用 AI 速度·禁人月/人天/招聘/团队节奏·N 个 session 并行 + 24/7 + IPC 异步·单位用分钟/小时/最多日历日。
```

UserPromptSubmit hook 每次 user prompt 注入到 LLM context（最低 token + 整轮可见）。**老 session 不一定 reload settings.json·部分需重启 session 才生效**·CC 自身 reload 机制不一致。portfolio session 重启时自动加载新 hook。

## 队列 backlog（pending）

- install.ps1 hardcoded path → dynamic detect（外部用户可用）
- 5 件套同步 4-30 → 5-1（harness own）
- portfolio session 全重启（让所有 mcp-wrapper 加载 K.Y-1 新版·彻底停 leak）
- atomic handoff 真触发 verify·当前我 75% > 50% 门槛 + 三 signal 全过·watchdog 60s tick 应触发·还没看到 swap 实际 fire（可能 watchdog 还在跑 / 三 signal 真值需再 verify）

## 关键文件路径

- mcp-server: `D:\workspace\ai\research\xiheAi\xihe-jianmu-ipc\mcp-server.mjs`
- mcp-wrapper: `D:\workspace\ai\research\xiheAi\xihe-jianmu-ipc\mcp-wrapper.mjs`
- watchdog: `D:\workspace\ai\research\xiheAi\xihe-jianmu-ipc\bin\network-watchdog.mjs`
- hook rules: `D:\workspace\ai\research\xiheAi\xihe-tianshu-harness\domains\software\hooks\pre-prompt-reminder-rules.txt`
- helper: `D:\workspace\ai\research\xiheAi\xihe-jianmu-ipc\bin\claude-stdin-auto-accept.mjs`
- install.ps1: `D:\workspace\ai\research\xiheAi\xihe-jianmu-ipc\bin\install.ps1`
- claude.exe: `C:\Users\jolen\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`（手动 restored from `.old.1777647812587`）

## 接班建议

1. ipc_whoami + ipc_sessions 验证身份（feedback_ipc_whoami_truth_check）
2. 看 portfolio 19 session 状态·有 idle 的考虑关
3. atomic handoff 真触发 verify（检查 watchdog log 是否 trigger spawn）
4. CC 升级决策（保旧 / 跑 npm install 升新版）

— jianmu-pm · 2026-05-01T23:14+0800 · 老板换账号前落盘
