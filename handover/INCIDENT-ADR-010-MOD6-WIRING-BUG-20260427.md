# Incident Report·ADR-010 mod 6 wiring BUG·estimateContextPct 数据源链路断

> **触发**：2026-04-27T02:17+08:00 老板「都过去多久了触发了吗」+ harness 实测 11min 未触发自动 atomic handoff
> **发现**：2026-04-27T02:19:13+08:00 jianmu-pm root cause 候选 1 命中
> **作者**：jianmu-pm（建木项目经理）
> **状态**：root cause 确认·patch ETA 待第三波 codex brief + 派单
> **影响**：ADR-010 mod 6 wiring（1763283）+ 模块（177abb6）= ship 但不生效·acceptance #4 lineage 9→10 自动 atomic handoff 0 次触发

---

## 一、问题陈述

ADR-010 mod 6 设计：watchdog 周期检测 portfolio session 上下文使用率·>50% + 最小任务单元完成 → 自动 atomic handoff。

实际：1763283 ship + watchdog restart 02:06:08 → 11min 36s 后 02:17·**0 次自动 atomic handoff 触发**·lineage 9 harness（70%+）+ jianmu-pm（65%+）应该被触发都没。

---

## 二、root cause（实测）

### 2.1 候选 1 命中：contextUsagePct = MISSING

Hub /sessions 实测 02:19：
```
network-watchdog·pid=38696·ctxUsagePct=MISSING
taiwei-frontend·pid=81028·ctxUsagePct=MISSING
auditor-portfolio·pid=80384·ctxUsagePct=MISSING
... 全 14 session 都 MISSING
```

= **estimateContextPct 推送链路从未跑通**。Hub schema 加了 contextUsagePct 字段（177abb6 ff835da 模式·与 pid 同样），但客户端从未推送实际值。

### 2.2 链路断点定位

`mcp-server.mjs` register message：
```js
socket.send(JSON.stringify(createRegisterMessage({ name: IPC_NAME, pid: process.pid })));
```

= **只推 pid·没推 contextUsagePct**。register message 是 session 连接 Hub 时一次性发·后续无更新机制。

### 2.3 设计 gap

ADR-010 mod 6 实施漏掉两步：
1. register message 含 contextUsagePct 初始值（at connect 时）
2. 周期更新机制（每 60s session 自报 contextUsagePct 给 Hub）

context 是动态变化的（每条 IPC / 每个 commit / 每条 user 输入都增长）·一次性 register 不够·必须周期推送。

---

## 三、复刻 ship-but-no-effect 综合反模式（第 2 次复刻）

### 3.1 与 ADR-006 v0.3 wiring BUG 同源

第 1 次复刻（INCIDENT-ADR-006-V03-WIRING-BUG-20260426）：
- detector 期望 session.pid·Hub /sessions 不返 pid·全 skip 'no-pid-state'

第 2 次复刻（本 incident）：
- handover module 期望 contextUsagePct·Hub /sessions 不返 contextUsagePct·永不超阈值·永不触发

= 两次都是「**生产 schema 不匹配 module 期望·测试用 mock 漏过**」相同 pattern。

### 3.2 测试 mock 漏 production gap（feedback_mockagent_production_gap 第 3 次复刻）

ADR-010 mod 6 测试 12 case + watchdog wiring 测试 5 case·全部用 **mock fetchImpl** 注入 contextUsagePct 真值·**生产 mcp-tools 从未推送真值**·测试通过但生产无效。

### 3.3 ship 后真实场景验证缺失（feedback_ship_acceptance_equivalence 第 2 次复刻）

ADR-010 mod 6 acceptance #4 实战验证 PENDING·codex 按 brief 停手等 jianmu-pm 接力·jianmu-pm restart watchdog 后**未主动验证 5min 内是否真触发**·只 IPC harness 报「等触发」·= ship-but-no-real-validation 复刻。

---

## 四、修复方案（推荐 A）

### 4.1 选项 A·watchdog 直接读 transcript 估算（**推荐**）

**改动**：
- bin/network-watchdog.mjs 接 estimateContextPct 时·**不依赖 Hub /sessions 推送的 contextUsagePct**
- 直接调 `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` transcript 文件·估算 token / 200000 × 100
- 复用 ADR-006 v0.3 第一波的 session-state-reader（已有 sessionId + transcriptPath 推算）

**优势**：
- 单点改动（仅 watchdog 端）·不需 portfolio 全 session 改 register / 周期推送
- 复用现有 session-state-reader（DRY）
- 数据是实时的（每次 tick 重新估算）·不依赖客户端推送频率

**实施 ETA**：~30min AI 节奏

### 4.2 选项 B·客户端周期推送

**改动**：
- mcp-server.mjs 加周期推送（setInterval 每 60s 调 estimateContextPct + send update message to Hub）
- Hub /update-context-usage 端点接收 + 持久化 session.contextUsagePct
- /sessions 响应从 session 内存读取

**劣势**：
- portfolio 全 session 改造（含历史 spawn 出来的 12 太微 session）·需要 session 重启加载新代码
- 新增 Hub 端点 + protocol 字段
- 推送延迟 ≤ 60s（时间窗口内不准）

### 4.3 选项 C·Hub 主动查询

**改动**：
- Hub /sessions 每次响应时主动 ping 客户端 fetch context usage
- 客户端实时返回当前 contextUsagePct

**劣势**：
- 增加 Hub 调用开销
- 要求所有客户端立即响应（不可靠）

### 4.4 推荐 A

最直接·影响面最小·复用 session-state-reader·与 ADR-006 v0.3 第一波 session-state-reader 模式一致。

---

## 五、修复 + 验证计划

### 5.1 立即（本 incident report ship 后）
- 起草 ADR-010 mod 6 wiring 第二波 codex brief draft
- 派 codex 实施（~30min AI 节奏）

### 5.2 实施完成后
- restart watchdog 加载新代码
- 5min 内验证自动 atomic handoff 触发·**不许 SKIP**·不许「等触发」被动·**主动查 watchdog log + Hub /sessions + 透明实测**

### 5.3 验证通过后
- 转 ADR-010 mod 6 状态为 wiring-fixed-validated
- 5/26 月报抽样：ship-but-no-effect 综合反模式 KPI 第 2 次复刻数据点

---

## 六、5/26 月报抽样 KPI（重申·feedback_ship_acceptance_equivalence 同源）

ADR-006 v0.3 INCIDENT 提的 3 KPI：
1. 测试 vs 生产契约一致性
2. ship 后真实场景验证完成率
3. mock 漏 production gap 次数

本 incident 第 2 次复刻数据点：
- KPI 1：ADR-010 mod 6 测试用 mock fetchImpl 推送 contextUsagePct·生产从未推送·**第 2 次** mock vs 生产 schema 漂移
- KPI 2：ADR-010 mod 6 acceptance #4 ship 后未真实验证·**第 1 次** post-restart 跳过 5min 实测窗口
- KPI 3：mock 漏 production gap·**第 2 次**（同 ADR-006 v0.3 wiring BUG 同源）

= 5/26 月报抽样 portfolio 治理重大警报·12-30 天观察期可能新增 N 次 ship-but-no-effect 复刻·必须立硬规矩防御。

---

## 七、版本

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-04-27T02:20+08:00 | jianmu-pm 起草·候选 1 root cause 实测 + 复刻第 2 次 ship-but-no-effect 综合反模式 + 修复 3 选项推荐 A + 验证计划 + KPI 数据点 |
