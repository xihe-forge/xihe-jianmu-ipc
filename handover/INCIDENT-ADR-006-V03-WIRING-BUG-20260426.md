# Incident Report·ADR-006 v0.3 stuck-detector wiring BUG

> **触发**：2026-04-26T22:47+08:00 老板报 Anthropic Server is temporarily limiting requests · ADR-006 v0.3 首次实战验证机会
> **发现**：2026-04-26T23:18:30+08:00 jianmu-pm 实战验证发现 wiring BUG
> **作者**：jianmu-pm（建木项目经理）
> **状态**：root cause 确认·patch ETA 待 ADR-006 v0.3 第二波 codex brief 起 + 派单
> **影响**：ADR-006 v0.3 步骤 6+7 实施（b1d396c）= ship 但不生效·portfolio rate limit 自动接续目标未达成

---

## 一、问题陈述

ADR-006 v0.3 步骤 6+7 设计目标：watchdog 周期检测 portfolio session 是否卡在 Anthropic rate limit / network down 状态·按五信号 AND 判定 stuck → 调 db.suspendSession({reason: 'stuck-rate-limited' / 'stuck-network'}) → wake-reaper 周期扫挂起池 → Anthropic 探针正常 + 冷却到期 → 自动 wake。

实战触发：老板 22:47 报 rate limit·watchdog 23:08:15 restart 加载 b1d396c + d78b339 fresh code·**等 4 个完整 60s tick 后 0 次 stuck-rate-limited 触发**·boss 手动恢复（23:00+）·五信号 AND 检测层未参与。

---

## 二、root cause（源码实证）

### 2.1 stuck-session-detector 期望

`lib/stuck-session-detector.mjs:78-82`：
```js
const sessionState = getSessionState(session.pid);
if (!sessionState) {
  skipped.push({ name, reason: 'no-pid-state' });
  continue;
}
```

= 检测器对每个 session 调 `getSessionState(session.pid)`·要求传入的 session 对象**必须含 pid 字段**。

### 2.2 watchdog 实际提供的 session schema

`bin/network-watchdog.mjs:907-918`：
```js
getSessions: async () => {
  const response = await fetchImpl(`${buildHubUrl(ipcPort)}/sessions`);
  const sessions = await response.json();
  return new Map(sessions.map((s) => [s.name, {
    ...s,
    ws: { readyState: 1 }
  }]));
}
```

Hub `/sessions` 端点响应 schema（实测）：
```json
[{"name":"jianmu-pm","connectedAt":1777201076093,"topics":[]}]
```

= **无 pid 字段**·spread `...s` 后 session 对象只有 name / connectedAt / topics / ws·**session.pid 永远 undefined**。

### 2.3 必然失败路径

```
detector tick
  → for each session in Hub /sessions
    → getSessionState(undefined)   ← session.pid 是 undefined
      → session-state-reader 找不到对应 .json
      → return null
    → skipped.push({ reason: 'no-pid-state' })
    → continue（跳过此 session）
  → 全部 skipped
  → 0 次 suspendSession 调用
  → 实战 0 次自动接续触发
```

### 2.4 为什么测试没发现

`tests/stuck-session-detector.test.mjs` 12 测试 case 全部用 mock session 对象**含 pid 字段**：

```js
const sessions = new Map([['stuck', {
  name: 'stuck',
  pid: 12345,                     // ← mock 显式提供 pid
  ws: { readyState: WS_OPEN }
}]]);
```

= mock 与生产 Hub /sessions 响应 schema 不一致·测试通过但生产无效。

---

## 三、复刻 3 现有 portfolio 硬规矩（治理价值）

### 3.1 复刻 `feedback_ship_acceptance_equivalence`

> "ship 标准 = acceptance 标准·12 测试全过 ≠ ship gate 真过"

ADR-006 v0.3 步骤 6+7 测试 17/17 全过（5 STEP6 + 12 STEP7）·SHA 20ca6b7 + 3580f6b + d7c5c1d + b1d396c·acceptance §一 5 项中 #1 测试通过自验·**但 acceptance #4 真实场景 5min watchdog 实测被 SKIP**（lineage 9 落盘时避影响 portfolio）。如未 SKIP 则会发现 wiring BUG·**ship + 无 acceptance #4 = ship-but-no-real-validation**·`feedback_ship_acceptance_equivalence` 精准实战 case。

### 3.2 复刻 `feedback_mockagent_production_gap`

> "MockAgent 单元测试 ≠ 生产 HTTP 集成·fetcher 必须 canary 源真 HTTP integration"

stuck-session-detector 测试 12 case 全用 mock session（含 pid）·真生产 Hub /sessions 不返 pid·**mock 与生产 schema 漂移**·与 2026-04-19 玄机 dogfood 踩双坑（gzip / IPC dispatch mock 覆盖不到）同源。

### 3.3 复刻 `feedback_ship_then_restart`（lineage 9 23:11 立·harness own）

> "ship 代码后必须验证服务是否 restart 加载新代码·否则 ship ≠ 生效"

watchdog pid 62744 4 天前进程·b1d396c + d78b339 ship 后未 restart 自动加载·**ship + 无 restart = ship-but-not-loaded**·jianmu-pm 23:08 手动 restart 才加载新代码·`feedback_ship_then_restart` 立项当日实战触发的根因之一。

### 3.4 三规矩叠加 = 「ship-but-no-effect」综合反模式

```
ship 代码 (commit + push)
  → feedback_ship_then_restart：ship ≠ loaded（需 restart）
    → restart 后 loaded
      → feedback_mockagent_production_gap：测试 mock ≠ 生产 schema
        → mock pass 但生产 wiring BUG
          → feedback_ship_acceptance_equivalence：ship 标准 ≠ acceptance 标准
            → 12 测试 pass 但 acceptance #4 真实场景被 SKIP
              → 实战发现 wiring BUG
                → ADR-006 v0.3 步骤 6+7 ship 但 0 次自动接续触发
```

= ADR-006 v0.3 实战暴露的不是单一 BUG·**是 portfolio 治理「ship-but-no-effect」综合反模式实证**·case-study 4a §10.7 后续 patch 候选数据。

---

## 四、修复路径（3 选项·推荐 A）

### 4.1 选项 A·改 Hub /sessions 暴露 pid（**推荐**）

**改动范围**：
1. `hub.mjs` /sessions 响应 schema：每条加 `pid` 字段
2. session 注册时（WebSocket connect / ipc_register_session）记录 pid
3. WebSocket 连入时通过 hub-handshake 协议字段或 ipc_register_session 显式声明 pid

**优势**：
- watchdog 不需改 wiring·detector 不变·测试不改
- pid 是 portfolio session 通用元数据·暴露后还可服务于其他诊断（如 session-pid 关联表 / process kill 三维验明正身辅助）

**实施工时**（AI 节奏 one-shot）：
- hub.mjs schema 改：~10 行
- 注册路径加 pid 字段：~15 行（每个 register 入口）
- 测试 case：~30 行
- /sessions 响应测试更新：~10 行
- 累计 ~30 min codex 派单 + 接力 commit（或 0-violation 直 commit）

### 4.2 选项 B·watchdog 加入 name → pid 解析层

**改动范围**：watchdog `getSessions()` 内部拼接 pid

```js
getSessions: async () => {
  const hubSessions = await response.json();
  const allStates = await getAllSessionStates();  // 读全部 ~/.claude/sessions/*.json
  // ❌ 但 name → pid 映射不存在·session-state.json 没 name 字段
  // 需要用 cwd / argv / IPC_NAME 环境变量推 name·跨平台麻烦
}
```

**劣势**：
- session-state.json schema 没 name 字段·只有 sessionId / pid / cwd
- 推 name 需读 process env·Linux /proc/<pid>/environ·Win32 WMI Win32_Process.CommandLine
- 跨平台脆弱·维护成本高

**不推荐**。

### 4.3 选项 C·ipc_register_session 注 pid

**改动范围**：
1. `mcp-tools.mjs` ipc_register_session 调用方携带 `pid: process.pid`
2. Hub /registry/register 端点接收 + 存 sessions-registry.json
3. /sessions 响应从 registry 拼接 pid

**优势**：与 selfsessions-registry 流程一致·非侵入式

**劣势**：依赖 session 主动 register（cold-start 7 步必跑）·若漏跑则无 pid·容错弱于 A

**作为 A 的 fallback 候选保留**·但不主推。

### 4.4 推荐结论

**A**·Hub /sessions schema 加 pid·实施 ~30min·影响面最小·与 ADR-006 v0.3 第二波 brief 自然合并。

---

## 五、5/26 月报抽样 KPI 建议（auditor-portfolio own）

### 5.1 「测试 vs 生产契约一致性」KPI

- 定义：每次 ship 的 mock-only 测试 vs 真实生产端点 schema 字段对照
- 抽样：portfolio 全 watchdog patch + 五信号 AND + Hub HTTP API 全量审计
- 目标：≥ 1 字段不一致 / 月度 = 触发 incident report

### 5.2 「ship 后真实场景验证完成率」KPI

- 定义：每次 ship 的 acceptance 5 项中"真实场景验证"（如 watchdog 5min 实测）实际执行率
- 抽样：portfolio 全 ship-checklist v0.4 §16-§19 acceptance 项
- 目标：≥ 95% 真实场景验证完成（不允许「避影响 portfolio 时 SKIP」习惯化）
- 与 `feedback_ship_then_restart` 同源

### 5.3 「mock 漏 production gap 次数」KPI

- 定义：实战 / 真实场景验证暴露的 mock 与生产 schema / 行为差异次数
- 抽样：每月 portfolio 全实战触发的 incident report
- 目标：累计 ≤ 2 次 / 月（持续优于 portfolio 12 月历史基线·目标 0）

### 5.4 关联现有 KPI（避重复）

- 已有 `feedback_ship_acceptance_equivalence` ship-checklist v0.4 §16-§19 已覆盖 5.2 部分
- 已有 `feedback_codex_sandbox` SOP §preflight 5 项立后 dispatch flag 误用归 0 KPI
- 5.1 + 5.3 是新 KPI·5.2 是已有 KPI 的 sharp 化（不允许 SKIP 习惯化）

---

## 六、incident timeline

| 时刻 | 事件 |
|---|---|
| 2026-04-22T04:55:34 | watchdog pid 62744 启动·OLD CODE（v0.2 stale-suspend-detector）|
| 2026-04-26T18:40 | d78b339 cliProxy probe 修复 ship（GET /healthz）|
| 2026-04-26T18:49 | b1d396c watchdog 接 stuck-session-detector ship·v0.2 模块 revert |
| 2026-04-26T22:47 | **老板报 Anthropic rate limit**·ADR-006 v0.3 实战验证机会 |
| 2026-04-26T23:08:15 | jianmu-pm restart watchdog（fresh pid 861178）·三维验明正身完成·b1d396c + d78b339 加载 |
| 2026-04-26T23:09 | /status state=OK·cliProxy ok·harness state 机 stale 自然修复（fresh init）|
| 2026-04-26T23:11 | 等 60s 第一轮 tick·watchdog log 无 stuck-detector 启动证据·silent by design |
| 2026-04-26T23:18 | jianmu-pm 源码追踪发现 wiring BUG（detector line 78 + watchdog 907-918 schema 不匹配）|
| 2026-04-26T23:20 | harness 批准 A→B 修复路径 |
| 2026-04-27T00:56 | 本 incident report 起草 |

---

## 七、impact assessment

### 7.1 直接影响

- ADR-006 v0.3 步骤 6+7 实施 ship 但 0 次自动接续触发
- portfolio rate limit 仍依赖人类（老板）手动发现 + 接续
- ADR-006 v0.3 acceptance §一 #4 真实场景验证未通过（虽然之前标 SKIP）

### 7.2 间接影响

- 5/26 月报 ADR-006 v0.3 转 Accepted 判定基线偏乐观（认为已生效）·应等 wiring fix ship + 实战二次验证后再下结论
- portfolio 全 watchdog patch 历史 retroactive 审计候选（与 ship-checklist v0.4 §18 同源）
- ADR-007 9 session 试行实证基线含「fresh init 副作用解决 4 天 stale 状态机」正面 + 「ship 后 wiring BUG 未发现」负面双数据点

### 7.3 没有的影响

- portfolio session 没断（Hub WS 正常）
- IPC 路由没断（jianmu-pm + harness + 太微 9 session + auditor 全在线）
- 老板手动恢复后 portfolio 持续干活（无连锁失败）

---

## 八、修复 + 验证计划

### 8.1 立即（本 incident report ship 后）
- 起草 ADR-006 v0.3 第二波 codex brief draft（含 wiring fix A 修法 + 步骤 8/9/10）
- 派 codex 实施（按 SOP §preflight 5 项·按 feedback_ai_pace_not_human_pace AI 节奏估）

### 8.2 实施完成后
- restart watchdog 加载新代码（按 feedback_ship_then_restart）
- 5min watchdog 实测·jianmu-pm + harness + 太微 9 session 不被误 suspend
- 触发 1 次实战 rate limit / network down（如 portfolio 真实下次触发自然验证·不主动模拟）
- 验证 stuck-rate-limited / stuck-network 触发 + wake-reaper 自动唤醒

### 8.3 验证通过后
- 转 ADR-006 v0.3 状态为 Accepted-Validated（与原 Accepted 区分）
- case-study 4a §10.7 后续 patch 加本 incident 数据点
- auditor-portfolio 5/26 月报抽样基线含本 incident 3 KPI 候选

---

## 九、关联文档

- `xihe-tianshu-harness/handover/adr/ADR-006-PORTFOLIO-ECONNRESET-AUTO-RECOVERY.md` v0.3
- `xihe-jianmu-ipc/docs/research/ADR-006-V03-CODEX-BRIEF-DRAFT.md`（第一波 brief·已 ship）
- `xihe-jianmu-ipc/docs/research/ADR-006-V03-WAVE2-CODEX-BRIEF-DRAFT.md`（第二波 brief·待起草·本 incident 触发）
- `xihe-tianshu-harness/handover/case-study/opc-v2.2-emergency-response-20260426.md` §10.7 双 codex AI 节奏实证
- `feedback_ship_acceptance_equivalence.md` / `feedback_mockagent_production_gap.md` / `feedback_ship_then_restart.md`（3 复刻规矩）

---

## 十、版本

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-04-27T00:58+08:00 | jianmu-pm 起草·三维契约不一致根因 + 复刻 3 现有 memory 实证 + 5/26 月报抽样 3 KPI 候选 + 修复 3 选项推荐 A + impact assessment + 验证计划 |
