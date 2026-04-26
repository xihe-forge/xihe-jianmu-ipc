# ADR-009：API 周限额预警与自动唤醒方案设计

> **版本**：v0.3（按《人类可读决策文档规范》v1.0 重写 + 大修订数据源）
> **状态**：设计待拍板（v0.1 落档 SHA `cb38bc3` / v0.2 SHA `1911cbb`，本版按老板 15:24 critique 大修订数据源，等老板拍板进入实施）
> **重写日期**：2026-04-26T15:48+08:00
> **历史**：
> - v0.1（2026-04-26T14:18 建木项目经理起草，4 SOP 设计，中英文混杂、缺消耗与角色分工，老板 14:58 反馈不可读）
> - v0.2（2026-04-26T15:10 harness 协调员按规范九段式重写，模块拆分清晰，但数据源仍假设看门狗自跑 OAuth API 重造轮子）
> - v0.3（2026-04-26T15:48 建木项目经理按老板 15:24 critique 大修订：改读 claude-hud 缓存 + Claude Code v2.1.6+ statusline stdin `rate_limits` 字段，省 OAuth 凭证管理、省 Anthropic API 调用、代码量节省 43%）
>
> **正式编号**：xihe-jianmu-ipc 仓 `docs/adr/009-mcp-initialize-race-fix.md` 已占用 ADR-009 编号；本文档作为 design 路径落档于 `handover/`，老板拍板后转 ADR-007（xihe-tianshu-harness 仓 portfolio 级编号）正式编号。

---

## 一、问题陈述

### 1.1 当前遇到的具体问题

老板的 Anthropic 账号有周限额（按 7 天滚动窗口算的 token 总量配额）。但 portfolio 没有任何主动预警机制：

- 看门狗只看连接性，不读 token 用量
- 周限额到 80% 阈值无人广播，老板靠手动看 npx 命令或切账号时才发现
- 单 session 触发 HTTP 429 速率限制时，被当成普通断连处理，唤醒后立刻再次 429，浪费 token
- portfolio 没有 token 用量的实时面板，老板看不到当前周已用百分比

### 1.2 触发事件

事件一：2026-04-25T21:34+08:00 老板派 P0 任务：

> "API 限额管理 4 SOP 缺失。周限额到 88% 才被发现。session 卡待机时无自动唤醒。portfolio 无面板实时显示 token 用量。"

事件二：2026-04-26T02:02+08:00 老板再次警告：

> "周限额 88%。明天 token 用尽风险。session 可能突然停止。todo 落档频次必须升级。"

事件三（v0.3 触发）：2026-04-26T15:24+08:00 老板 critique v0.2 数据源设计：

> "我有 claude-hub 插件可以看到 token 用量实时面板，能知道当前周已用百分比。不清楚的是你们。这个插件已经做好了相关工作，只要你们去读取人家的记录文件即可。"

= 老板指出 v0.2 重造轮子。已有现成数据源（claude-hud + Claude Code 原生 statusline stdin），不需要 portfolio 自跑 OAuth API。

### 1.3 不解决会有什么后果

| 影响维度 | 量化描述 |
|---|---|
| 老板手动介入次数 | 每周至少 2–3 次（80% 警戒线 + 90% 红线 + 用尽前应急切账号）|
| 切账号缓冲窗口 | 当前 88% 才发现，切账号准备时间被压缩到 2 小时内 |
| 单次 HTTP 429 浪费 | 误唤醒一次约浪费 200–500 token（429 立刻再次 429 占用主对话）|
| portfolio 整体停摆风险 | token 用尽前 24 小时无预警，可能突发集体停工 |

### 1.4 现有规范的覆盖盲区

| 现有规范 | 覆盖的范围 | 漏掉的范围 |
|---|---|---|
| 看门狗 8 项探针 | 连接性（网络、Hub、Anthropic 端点、DNS、内存、CPU 等）| token 用量、周限额累计 |
| ADR-006 自动唤醒 | 网络断连后唤醒 | HTTP 429 速率限制场景（误唤醒会立刻再 429）|
| 飞书控制台 7 命令 | 状态、帮助、派发、广播、重启、历史、日报 | 用量查询 |
| 网络容错规范 §3 / §4 | 连接性容错 | 速率限制容错 |

= **速率限制治理是 ADR-006 之外的独立空隙**。ADR-006 处理网络断连（重试耗尽、连接关闭），本 ADR 处理速率限制（429、周限额预警）。

### 1.5 portfolio 实证数据

- 2026-04-25T22:00 老板看到周限额约 70%，启动自我交接准备
- 2026-04-26T00:25 老板看到 80%，全 portfolio 广播切账号准备
- 2026-04-26T02:02 老板看到 88%，警告明天可能用尽
- = **24 小时内涨 18 个百分点**，没有任何自动预警，全靠老板手动发现

### 1.6 v0.3 数据源真相（关键修订）

老板 15:24 critique 后 harness 协调员 15:30 实测调查，发现两个现成数据源：

#### 数据源 A · claude-hud 缓存文件

| 维度 | 实测 |
|---|---|
| 真名 | `claude-hud`（HUD = Heads-Up Display），作者 Jarrod Watts，MIT |
| 路径 | `C:\Users\jolen\.claude\plugins\claude-hud\` |
| 数据来源 | Anthropic 官方 OAuth 用量 API：`GET https://api.anthropic.com/api/oauth/usage`，鉴权 `Bearer <accessToken>` + `anthropic-beta: oauth-2025-04-20` |
| 响应字段 | `five_hour.utilization` (0–100) + `five_hour.resets_at` (ISO) + `seven_day.utilization` + `seven_day.resets_at` |
| 缓存文件 | `C:\Users\jolen\.claude\plugins\claude-hud\.usage-cache.json`，60 秒 TTL（v0.0.12 改 5 分钟） |
| 凭证位置 | `{CLAUDE_CONFIG_DIR}/.credentials.json` 的 `data.claudeAiOauth.accessToken` |
| 当前状态 | 缓存文件还没生成（HUD 没渲染过），需 HUD 跑过才有 |

#### 数据源 B · Claude Code v2.1.6+ statusline stdin（推荐主路径）

读 claude-hud 源码 `src/types.ts` L23–32 发现 Claude Code 自身已在 statusline 脚本 stdin 提供：

```typescript
rate_limits?: {
  five_hour?: { used_percentage?: number, resets_at?: number },
  seven_day?: { used_percentage?: number, resets_at?: number }
}
```

= **每次 statusline 脚本被 Claude Code 调用时直接读 stdin 即得**。不需要 OAuth API、不需要 access token、不需要等 claude-hud 渲染。

#### 当前 statusline 实测

`~/.claude/statusline-account.mjs`（老板自建 47 行账号显示脚本）：
- L7 已读 stdin
- L37 已 spawn HUD 脚本
- 但**没写共享文件** = v0.3 第 0 模块要扩这一段（约 10 行）

#### 推荐方案

**主路径**：扩 statusline-account.mjs 写 `~/.claude/usage-snapshot.json`（每次 statusline 渲染即更新 · 实时 · 无凭证管理）。

**兜底路径**：claude-hud `.usage-cache.json` 存在时也读（HUD 渲染过则可用 · 60s TTL）。

两路径都生成同一 schema 的 `~/.claude/usage-snapshot.json`，看门狗与飞书命令读同一接口。

---

## 二、目标

| 目标项 | 量化标准 |
|---|---|
| 周限额预警准时率 | 30 天观察期内，80% 阈值由系统主动广播的占比 ≥ 90%（vs 老板手动发现）|
| HTTP 429 误唤醒率 | 30 天内，rate-limited session 在 reset 时间到达前被误唤醒的次数 ≤ 1 次 |
| 老板手动查询次数 | 30 天内，老板主动跑 npx 查 token 用量的次数 ≤ 5 次（飞书面板替代）|
| 切账号缓冲窗口 | 80% 触发预警到周限额用尽，至少留 24 小时缓冲 |

判断已达成：30 天后跑审计脚本统计预警命中次数 / 误唤醒次数 / 老板查询次数。

---

## 三、工作路径

五个模块（含第 0 前置模块）互补，覆盖从数据源到预警到唤醒到查看的完整链路：

```
[第 0 模块] 扩 statusline-account.mjs 写 ~/.claude/usage-snapshot.json
    ↓
    每次 Claude Code 调用 statusline 即更新（rate_limits stdin → 共享文件）
    ↓
[第 1 模块] 看门狗读共享文件加第 9 项探针 anthropic_rate_limit_pct
    ↓
    seven_day.used_percentage ≥ 80% → 广播 WARN 主题
    seven_day.used_percentage ≥ 90% → 广播 CRIT 主题
    ↓
[第 2 模块] Hub 挂起态分类：retry-exhausted / rate-limited / network-down
    ↓
    共享文件 apiError == 'rate-limited' / 五小时与七天用量 100% → 自动 POST /suspend reason='rate-limited'
    ↓
[第 3 模块] 速率限制感知唤醒：按 sevenDayResetAt / fiveHourResetAt 触发
    ↓
    reset 时间已过才唤醒 rate-limited session
    ↓
[第 4 模块] 飞书面板：用量查询命令直接读 ~/.claude/usage-snapshot.json
    ↓
    老板飞书发"用量"看到 3 段进度条 + 卡住 session 列表（不需 Hub 新端点）
```

五个模块可独立实施、独立验收，互不阻塞（第 0 模块为前置依赖）。

---

## 四、步骤拆分

| 步骤 | 内容 | 负责人 | 参与人 | 产出物 | 预计耗时 | 预计 token | 前置依赖 |
|---|---|---|---|---|---|---|---|
| 1 | 起草 v0.1 设计 4 SOP | 建木项目经理 | harness 评审 | SHA `cb38bc3` | 30 分钟 | 10 000 | 无 |
| 2 | v0.2 按规范九段式重写 | harness 协调员 | 建木项目经理评审 | SHA `1911cbb` | 30 分钟 | 6 000 | 步骤 1 |
| 3 | v0.3 数据源大修订（claude-hud + statusline stdin）| 建木项目经理 | harness 守门评审 | 本文 SHA | 60 分钟 | 8 000 | 步骤 2 + 老板 15:24 critique + harness 15:30 技术调查 |
| 4 | 老板拍板综合策略（5 模块 / 拆分 / 其他）| 老板 | harness、建木项目经理 | 决策记录 | 5–30 分钟 | 1 000 | 步骤 3 |
| 5 | 第 0 模块实施：扩 statusline-account.mjs | 建木项目经理派 Codex | 建木项目经理评审 | 红绿双 SHA | 15 分钟 | 2 000 | 步骤 4 |
| 6 | 第 1 模块实施：看门狗读共享文件 | 建木项目经理派 Codex | 建木项目经理评审 | 红绿双 SHA + CLAUDE.md 同步 | 30 分钟 | 4 000 | 步骤 5 |
| 7 | 第 2 模块实施：挂起态分类 | 建木项目经理派 Codex | 建木项目经理评审 | 红绿双 SHA | 30 分钟 | 5 000 | 步骤 5 |
| 8 | 第 3 模块实施：速率限制感知唤醒 | 建木项目经理派 Codex | 建木项目经理评审 | 红绿双 SHA | 30 分钟 | 5 000 | 步骤 7 |
| 9 | 第 4 模块实施：飞书"用量"命令 | 建木项目经理派 Codex | 建木项目经理评审 | 红绿双 SHA + 飞书卡片样式 | 30 分钟 | 4 000 | 步骤 5 |
| 10 | portfolio 重启加载新代码 | 老板手动 | 全 portfolio session | 各 session 重启完成 | 5 分钟 | 0 | 步骤 6/7/8/9 |
| 11 | 30 天观察期审计 | harness 协调员 | 建木项目经理提供日志 | 审计报告 | 1 小时 | 5 000 | 步骤 10 + 30 天 |
| 12 | 拍板转 Accepted 或升级 v0.4 | 老板 | 全 portfolio | 决策记录 | 30 分钟 | 2 000 | 步骤 11 |

---

## 五、模块拆分

### 5.1 第 0 模块·扩 statusline-account.mjs 写共享文件（前置）

| 字段 | 内容 |
|---|---|
| 模块名 | statusline 共享文件写入 |
| 边界 | 负责：每次 Claude Code 调用 `~/.claude/statusline-account.mjs` 时，从 stdin 抽 `rate_limits` 字段写入 `~/.claude/usage-snapshot.json`。不负责：聚合、广播、唤醒 |
| 负责人 | 建木项目经理派 Codex |
| 对外接口 | 输出文件 `~/.claude/usage-snapshot.json`，schema：`{five_hour: {used_percentage, resets_at}, seven_day: {used_percentage, resets_at}, ts: <number>}` |
| 实施位置 | `~/.claude/statusline-account.mjs`（已有 47 行，加约 10 行）|
| 代码量 | 约 10 行 |
| 兼容性 | stdin 缺 `rate_limits` 字段时不写文件、不报错（Claude Code 旧版本兼容）|

### 5.2 第 1 模块·看门狗速率限制探针

| 字段 | 内容 |
|---|---|
| 模块名 | 看门狗第 9 项探针（anthropic_rate_limit_pct）|
| 边界 | 负责：周期 60 秒读 `~/.claude/usage-snapshot.json`，按 80% / 90% 阈值广播 `critique` 主题（5 分钟去重）。不负责：判断是否唤醒 session |
| 负责人 | 建木项目经理派 Codex |
| 对外接口 | 看门狗周期 60 秒；广播 `critique` 主题（WARN 80% / CRIT 90% / 5 分钟去重）；CLAUDE.md "Watchdog" 段同步加第 9 项 |
| 实施位置 | `bin/network-watchdog.mjs` |
| 代码量 | 约 30 行（v0.2 估 60 行减半，因不需 OAuth 调用）|
| 兼容性 | 共享文件不存在或字段缺失时降级为现有连接性探针，不破坏现有逻辑 |
| 兜底 | 共享文件不存在则尝试读 `claude-hud/.usage-cache.json`，再不存在则跳过本探针不报错 |

### 5.3 第 2 模块·挂起态分类

| 字段 | 内容 |
|---|---|
| 模块名 | session 挂起态分类（retry-exhausted / rate-limited / network-down）|
| 边界 | 负责：把进入挂起态的 session 按原因分三类，写入 `db.suspendSession({reason: <类型>})`。不负责：判断 session 何时该挂起 |
| 负责人 | 建木项目经理派 Codex |
| 对外接口 | `POST /suspend` 已支持 `reason` 字段，新增枚举值 `rate-limited`；触发条件：共享文件 `seven_day.used_percentage` 100% 或 `apiError == 'rate-limited'` |
| 实施位置 | `lib/network-events.mjs` 扩判定逻辑（与 ADR-006 Plan B 路径 C `stale-suspend-detector` 同源 · 加 detector 类型字段）|
| 代码量 | 约 60 行（v0.2 估 80 行减少，因复用 stale-suspend-detector pattern）|
| 依赖 | 第 0 模块（共享文件提供分类判定数据）|

### 5.4 第 3 模块·速率限制感知唤醒

| 字段 | 内容 |
|---|---|
| 模块名 | wakeRateLimited 路径 |
| 边界 | 负责：当共享文件 `seven_day.resets_at` 或 `five_hour.resets_at` 已过时，才唤醒 `reason: 'rate-limited'` 类挂起 session。不负责：唤醒其他类型挂起 session（走 ADR-006 路径）|
| 负责人 | 建木项目经理派 Codex |
| 对外接口 | `POST /wake-suspended` 加 `reason` 过滤参数（已支持广播，新增分类唤醒）；唤醒 IPC 内容固定模板 |
| 实施位置 | `lib/network-events.mjs` 加 `wakeRateLimited({resetAt})` 函数 |
| 代码量 | 约 80 行（v0.2 估 100 行减少，复用 broadcastNetworkUp pattern）|
| 依赖 | 第 0 模块 + 第 2 模块 |

### 5.5 第 4 模块·飞书用量面板

| 字段 | 内容 |
|---|---|
| 模块名 | 飞书"用量"命令（直接读共享文件）|
| 边界 | 负责：飞书发"用量"返回卡片含 3 段进度条（5 小时 / 7 天 / 卡住 session 列表）+ reset_at 倒计时。不负责：触发任何唤醒动作（仅查询）|
| 负责人 | 建木项目经理派 Codex |
| 对外接口 | 飞书卡片模板新增「用量看板」；飞书桥接命令解析器加第 8 命令"用量"/"usage"；**不需 Hub 新端点**（直接读 `~/.claude/usage-snapshot.json`）|
| 实施位置 | `lib/feishu-bridge.mjs`（命令解析）+ `lib/console-cards.mjs`（卡片模板）|
| 代码量 | 约 80 行（v0.2 估 200 行节省 60%，因不需 Hub `/usage` endpoint）|
| 依赖 | 第 0 模块（数据源）+ 第 2 模块（挂起分类数据）|

### 5.6 模块协作关系

```
第 0 模块（statusline 写共享文件）
       ↓
       ~/.claude/usage-snapshot.json
       ↓ 三处读
       ├─→ 第 1 模块（看门狗探针 80/90 广播）
       ├─→ 第 2 模块（挂起分类 rate-limited 触发）
       └─→ 第 4 模块（飞书面板渲染）
                ↓
       第 2 模块 → 第 3 模块（reset 后唤醒 rate-limited）
```

= 第 0 模块是数据源中枢，1/2/4 模块是数据消费者，3 模块是 2 模块下游。

---

## 六、消耗估算

### 6.1 总消耗

| 维度 | v0.2 估算 | v0.3 估算 | 节省 |
|---|---|---|---|
| token（含起草 + 模块 Codex 派单 + 审计）| 48 000 | 约 30 000 | 38% |
| 实施时间（设计到完成）| 4–6 小时 | 约 2–3 小时（5 模块串行）或 1.5 小时（部分并行）| 50% |
| 时间（30 天观察期）| 30 天 | 30 天 | - |
| 老板时间 | 拍板 5–30 分钟 + 审阅 30 分钟 | 拍板 5–30 分钟 + 审阅 30 分钟 | - |
| 总代码量 | 440 行 | 约 250 行 | 43% |

### 6.2 分项明细（v0.3）

| 步骤 | token | 时间 |
|---|---|---|
| 步骤 1：起草 v0.1（已完成）| 10 000 | 30 分钟 |
| 步骤 2：v0.2 重写（已完成）| 6 000 | 30 分钟 |
| 步骤 3：v0.3 大修订（本步）| 8 000 | 60 分钟 |
| 步骤 4：拍板 | 1 000 | 5–30 分钟 |
| 步骤 5：第 0 模块（statusline 扩）| 2 000 | 15 分钟 |
| 步骤 6：第 1 模块（看门狗探针）| 4 000 | 30 分钟 |
| 步骤 7：第 2 模块（挂起分类）| 5 000 | 30 分钟 |
| 步骤 8：第 3 模块（感知唤醒）| 5 000 | 30 分钟 |
| 步骤 9：第 4 模块（飞书面板）| 4 000 | 30 分钟 |
| 步骤 10：portfolio 重启 | 0 | 5 分钟 |
| 步骤 11：30 天审计 | 5 000 | 1 小时 |
| 步骤 12：拍板归档 | 2 000 | 30 分钟 |

### 6.3 运行期消耗（每次预警 / 唤醒）

| 项 | token | 时间 |
|---|---|---|
| statusline 写共享文件 | 0（不在主对话）| < 100 毫秒 |
| 看门狗后台读共享文件 | 0（不在主对话）| < 50 毫秒 |
| 80% / 90% 主题广播一次 | < 100 token | < 1 秒 |
| 速率限制感知唤醒 IPC | < 80 token | < 1 秒 |
| session 处理唤醒 IPC 回复 | 100–200 token | < 30 秒 |
| 飞书"用量"查询一次 | 0 portfolio AI session token（飞书命令拦截不进 IPC，飞书 webhook 服务器资源不计入 portfolio token 配额）| < 2 秒 |

### 6.4 节省的消耗（vs 不实施 / vs v0.2 重造轮子）

| 节省项 | v0.3 vs 不实施 | v0.3 vs v0.2 |
|---|---|---|
| 减少误唤醒（HTTP 429 立刻再 429）| 约 200–500 token / 次，按每周 2 次估算 = 800–2000 token / 周 | - |
| 减少老板手动查询切账号准备 | 节省老板 1–2 小时 / 周 | - |
| 减少 portfolio 集体停工风险 | 不可量化，但属于关键收益 | - |
| 省 OAuth API 调用 | - | 看门狗每分钟省 1 次 API 调用 = 60 次/小时 = 1440 次/天 |
| 省凭证管理（access token 读取 + 刷新）| - | 复杂度从中等降到零 |
| 省 Hub 新端点 `/usage` 实施 | - | 200 行代码 → 0（飞书直接读文件）|

---

## 七、多方案对比

| 方案 | 原理 | 优势 | 劣势 | token 消耗 | 时间消耗 | 风险 | 推荐度 |
|---|---|---|---|---|---|---|---|
| **本方案 v0.3（5 模块 + 共享文件）**| statusline 写文件 + 看门狗 / 飞书读文件 | 复用 Claude Code 原生能力、零凭证管理、代码量减半、实施时间减半 | 受 Claude Code v2.1.6+ 版本约束 | 单次预警 ≤ 100 / 单次唤醒 ≤ 280 | 实施 2–3 小时 | Claude Code 升级可能改 stdin schema（保留 claude-hud 缓存兜底）| ⭐⭐⭐⭐⭐ |
| 方案 v0.2（看门狗自跑 OAuth API）| 看门狗 HEAD Anthropic 端点读响应头 | 完全自主 | 重复 claude-hud 工作 + 凭证管理 + rate-limit 风险 + 凭证过期处理 | 48 000（设计阶段）+ 看门狗每分钟 OAuth 调用（运行期）| 4–6 小时 | 凭证管理复杂、Anthropic 响应头字段名变化 | ⭐⭐⭐ |
| 方案 D：周限额到了切账号（当前路径）| 老板手动发现并切账号 | 实施成本 0 | 老板每次手动、缓冲窗口被压缩、是末端方案 | 0 | 0 | 累积 token 用尽风险 | ⭐ |
| 方案 E：限流式 token 预算分配 | 给每 session 分配配额 | 防单 session 失控 | 实施复杂、与"AI 自驱"理念冲突 | 不可估算 | 数天 | session 间转账复杂 | ⭐⭐ |
| 方案 F：Anthropic + OpenAI 双链路 | 周限额触发后切到 OpenAI 等其他后端 | 不消耗 Anthropic 周限额 | 模型能力差异（其他模型 ≠ Claude Opus）、可能影响 session 表现 | 0 | 数天 | session 表现退化 | ⭐⭐⭐（v0.4 候选）|

**推荐方案**：本方案 v0.3（5 模块 + 共享文件）。理由：

1. 老板 15:24 critique 直接指明数据源已现成，不重造轮子是规范遵守
2. 复用 Claude Code 原生 `rate_limits` stdin 字段，零凭证管理、零 API 调用
3. 与 v0.2 比代码量节省 43%、token 节省 38%、实施时间节省 50%
4. statusline 写共享文件 + 看门狗 / 飞书读 = 单数据源中枢，维护简单
5. claude-hud 缓存兜底，Claude Code 改 stdin schema 时不立即破坏
6. 与 ADR-006 Plan B 路径 C（stale-suspend-detector）同源，第 2 模块复用 detector pattern

方案 F 留作 v0.4 升级候选，30 天观察期内若周限额仍频繁触发可升级。

---

## 八、验收方案

### 8.1 验收标准

- [ ] 第 0 模块代码已在 `~/.claude/statusline-account.mjs`（手动审阅，不进 git 仓）
- [ ] 第 1 模块代码已在 origin/master `bin/network-watchdog.mjs`，含红绿双 commit
- [ ] 第 2 模块代码已在 origin/master `lib/network-events.mjs`，含红绿双 commit
- [ ] 第 3 模块代码已在 origin/master `lib/network-events.mjs`，含红绿双 commit
- [ ] 第 4 模块代码已在 origin/master `lib/feishu-bridge.mjs` + `lib/console-cards.mjs`，含红绿双 commit
- [ ] 5 模块单元测试 100% 通过
- [ ] 第 0 模块跑过后 `~/.claude/usage-snapshot.json` 真生成（statusline 触发即写）
- [ ] 看门狗 `GET /health` 返回 `anthropic_rate_limit_pct` 字段
- [ ] 飞书发"用量"返回卡片含 3 段进度条
- [ ] 30 天观察期内 80% 预警准时率 ≥ 90%
- [ ] 30 天内误唤醒次数 ≤ 1 次
- [ ] 30 天内老板手动查询次数 ≤ 5 次

### 8.2 验收步骤

| 阶段 | 谁 | 何时 | 在哪里 | 跑什么命令 |
|---|---|---|---|---|
| 第 0 模块手动审 | 建木项目经理 | 模块落档时 | ~/.claude/statusline-account.mjs | `cat ~/.claude/usage-snapshot.json` 看是否生成（statusline 跑过后） |
| 代码验收 | 建木项目经理 | 模块落档时 | xihe-jianmu-ipc 仓 | `git log origin/master --grep "AC-ADR-009-M<n>"` |
| 单元测试 | 建木项目经理 | 模块落档时 | xihe-jianmu-ipc 仓 | `node --test tests/rate-limit-*.test.mjs` 等 4 组测试 |
| 端点验收 | harness 协调员 | portfolio 重启后 | 本机 | `curl http://127.0.0.1:3179/health` 看 `anthropic_rate_limit_pct` |
| 飞书面板验收 | 老板 | portfolio 重启后 | 飞书机器人 | 发"用量"，看卡片 |
| 30 天审计 | harness 协调员 | 2026-05-26 | 建木项目经理日志 | 审计脚本统计 `rate_limit_warn_hit` / `rate_limit_crit_hit` / `rate_limited_wake_hit` / `rate_limited_wake_miss` |

### 8.3 验收路径

- 代码与测试结果：xihe-jianmu-ipc 仓 git log 与本地 `node --test` 输出
- 第 0 模块输出：`~/.claude/usage-snapshot.json` 文件存在 + schema 正确
- 运行时端点：`http://127.0.0.1:3179/health` 看 `anthropic_rate_limit_pct`
- 飞书面板：老板飞书机器人对话窗口
- 30 天审计报告：建木项目经理生成 PDF 给老板

### 8.4 不通过时的回滚方案

- 任一模块单元测试失败：通过 git revert 回滚到模块落档前 SHA
- 第 0 模块共享文件未生成：手动跑 `~/.claude/statusline-account.mjs` 一次验证；若仍失败检查 stdin `rate_limits` 字段是否在（Claude Code 版本 < v2.1.6 兜底走 claude-hud 缓存）
- 30 天预警准时率 < 90%：调整阈值（80% → 75%）或升级方案 F
- 飞书"用量"卡片误读：手动校对 Anthropic 控制台真值 + 修共享文件解析逻辑

---

## 九、角色分工

| 角色 | 人 / session | 职责 |
|---|---|---|
| 立项负责人 | 建木项目经理 | 起草 v0.1 设计 |
| 文档重写负责人（v0.2）| harness 协调员 | 按《人类可读决策文档规范》v1.0 重写 |
| 文档大修订负责人（v0.3）| 建木项目经理 | 按老板 15:24 critique + harness 15:30 技术调查重写数据源 |
| 实施负责人 | 建木项目经理 | own 5 模块实施，派 Codex、评审、落档 |
| Codex 派单实施 | Codex（建木项目经理派）| 写代码、跑测试、推送 origin |
| 评审人 | 建木项目经理 | 评审 5 模块代码与测试 |
| 评审人（备）| tester-leader | 太微 P0 e2e-coverage-audit 完结后排单元测试覆盖率评审 |
| 文档治理守门人 | harness 协调员 | 按规范评审 v0.3 是否符合《人类可读决策文档规范》v1.0 |
| 拍板人 | 老板 | 拍板综合策略、30 天后转 Accepted |

---

## 十、待办事项

- [x] v0.1 立项落档（2026-04-26T14:18 SHA `cb38bc3`）
- [x] v0.2 按规范重写（2026-04-26T15:10 SHA `1911cbb`）
- [x] v0.3 大修订数据源（2026-04-26T15:48 本文 SHA 待 commit）
- [ ] harness 守门评审 v0.3 是否符合规范
- [ ] 老板拍板综合策略
- [ ] 第 0 模块实施（切账号后）
- [ ] 第 1 模块实施
- [ ] 第 2 模块实施
- [ ] 第 3 模块实施
- [ ] 第 4 模块实施
- [ ] portfolio 重启加载新代码
- [ ] 30 天观察期审计（2026-05-26 完成）
- [ ] 转 ADR-007 portfolio 级正式编号

---

## 十一、与现有 ADR 的关系

| ADR | 关系 | 说明 |
|---|---|---|
| ADR-006（网络断连自动接续）| 互补 + 同源 pattern | ADR-006 处理重试耗尽 / 网络断开；本 ADR 处理 HTTP 429 / 周限额。第 2 模块挂起分类与 ADR-006 Plan B 路径 C `stale-suspend-detector` 同源 pattern（detector 类型字段）|
| ADR-003（建议性钩子）| 共享钩子加载路径 | 第 2 模块的关键字过滤可与 ADR-003 的 checkpoint-refresh.ps1 共享 portfolio 重启窗口加载 |
| ADR-005（commit-msg-validate.ps1）| 共享 PowerShell 钩子加载路径 | install-hooks.mjs v2 模板复用 |
| ADR-004（portfolio 自动交接）| 互补 | 速率限制 reset 后续命可解，不需立即切账号；本 ADR 是切账号前置缓冲 |
| ADR-006 Plan B 路径 C（stale-suspend-detector）| 同源 detector pattern | 第 2 模块复用 lib/stale-suspend-detector.mjs 的工厂模式 |

---

## 十二、参考

- 仓库内规范：`xihe-tianshu-harness/domains/software/knowledge/network-resilience.md` v1.0
- 仓库内规范：`xihe-tianshu-harness/domains/software/knowledge/人类可读决策文档规范.md` v1.0（本 ADR 重写依据）
- 仓库内规范：`xihe-tianshu-harness/domains/software/knowledge/codex-brief-design-sop.md` v1.0（Codex 派单依据）
- 仓库内 ADR：`xihe-tianshu-harness/handover/adr/ADR-006-PORTFOLIO-ECONNRESET-AUTO-RECOVERY.md` v0.2
- 仓库 CLAUDE.md："Watchdog" 段（8 项探针 + 本 ADR 加第 9 项 `anthropic_rate_limit_pct`）
- 仓库 CLAUDE.md："HTTP API" 段（`/suspend` + `/wake-suspended` 端点 · v0.3 不加 `/usage` 端点）
- 仓库 CLAUDE.md："飞书 AI 控制台" 段（7 命令 + 本 ADR 第 4 模块加第 8 命令"用量"）
- 第三方插件：`C:\Users\jolen\.claude\plugins\claude-hud\` v0.0.12（Jarrod Watts，MIT，OAuth 用量 API 缓存兜底）
- 第三方源码：`claude-hud/src/types.ts` L23–32（Claude Code v2.1.6+ statusline stdin `rate_limits` schema 来源）
- 老板自建脚本：`~/.claude/statusline-account.mjs` 47 行（账号显示 + HUD spawn · 第 0 模块扩此脚本）

---

## 十三、版本

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-04-26T14:18+08:00 | 建木项目经理起草，4 SOP 设计 |
| v0.2 | 2026-04-26T15:10+08:00 | harness 协调员按《人类可读决策文档规范》v1.0 重写，九段式结构、消耗估算、角色分工补全 |
| v0.3 | 2026-04-26T15:48+08:00 | 建木项目经理按老板 15:24 critique 大修订数据源：改读 claude-hud 缓存 + Claude Code v2.1.6+ statusline stdin `rate_limits` 字段，新增第 0 模块（statusline 写共享文件），1/2/3/4 模块改读共享文件不重造 OAuth API；总代码 440→250 行（节省 43%）、token 48000→30000（节省 38%）、实施时间 4-6h→2-3h（节省 50%）|
