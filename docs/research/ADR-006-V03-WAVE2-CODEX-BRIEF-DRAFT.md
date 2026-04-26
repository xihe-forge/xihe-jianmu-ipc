# ADR-006 v0.3 第二波实施 Codex Brief（draft v0.1）

> **状态**：draft·INCIDENT-ADR-006-V03-WIRING-BUG-20260426 触发·实战发现 wiring BUG 必修
> **作者**：jianmu-pm（建木项目经理）
> **起草日期**：2026-04-27T01:05+08:00（real wall clock from `date -Iseconds`）
> **触发条件**：incident report ship + harness IPC 通知派单（msg_id 留档激活条件）
> **覆盖**：ADR-006 v0.3 §四步骤 8 + 9 + 10 + **wiring fix（A 修法 Hub /sessions 暴露 pid·incident 触发新增）**

---

## 一、目标

接 ADR-006 v0.3 第一波 ship（b1d396c + 配套 commit）·实战发现 wiring BUG·第二波 brief 完成 v0.3 设计全部模块 + 实战 fix + acceptance 真实场景验证。

判断完成：4 模块 RED+GREEN 双 commit + Hub /sessions schema 改 + 测试覆盖 + restart watchdog 加载 + 5min 真实场景实测·jianmu-pm + harness 不被误 suspend·真触发 1 次（自然 / 模拟二选一）实战验证 stuck-rate-limited 触发 + wake-reaper 自动唤醒成功。

## 二、Scope（**仅本 brief 范围**）

### in
- **wiring fix（最高优先级·incident 触发）**：
  - `hub.mjs`：/sessions 响应 schema 加 `pid` 字段 + WebSocket 注册路径记录 pid
  - `lib/protocol.mjs`：handshake 协议加可选 `pid` 字段
  - `lib/mcp-tools.mjs` / `mcp-server.mjs`：连入 Hub 时携带 `process.pid`
  - 测试：/sessions 响应含 pid 验证 + 注册路径 pid 持久化验证
- **步骤 8 唤醒冷却模块**（共用·B + C 模块均用）：
  - `lib/wake-cooldown.mjs`：按 session 名记录 last_wake_at·查询 + 写入接口
  - 测试 5 case
- **步骤 9 A 模块 v0.3 微调**：
  - `bin/network-watchdog.mjs` broadcastNetworkUp 配合新挂起判定
  - 测试更新
- **步骤 10 C 模块 v0.3 微调**：
  - `lib/wake-reaper.mjs` 接入唤醒冷却模块
  - 测试更新
- ADR-006 v0.3 §六 acceptance 真实场景 #4 验证（5min watchdog 实测）

### out
- ADR-009 第 1 模块（rate-limit 探针·复用 session-state-reader）→ ADR-009 自身 brief 范围
- ADR-010 portfolio 5h 额度自动化基础设施 5 模块 → harness own
- harness state 机 stale 4 天问题 → 已自然解决（fresh init 副作用·incident report §六记录）·不需 brief 范围

---

## 三、preflight 检查（codex 起步前必跑·grep -cE 集合命中模式）

```bash
# 1. 第二波触发条件·incident report 已 ship
test -f handover/INCIDENT-ADR-006-V03-WIRING-BUG-20260426.md
grep -cE 'wiring BUG|getSessionState\(session\.pid\)' handover/INCIDENT-ADR-006-V03-WIRING-BUG-20260426.md
# 必须 ≥ 2

# 2. 第一波模块已 ship + watchdog 接线
grep -cE "createStuckSessionDetector|stuck-session-detector|session-state-reader" bin/network-watchdog.mjs
# 必须 ≥ 3

# 3. Hub /sessions 当前响应不含 pid 字段（确证 wiring BUG 复刻）
grep -cE "pid" hub.mjs | head -1
# 命中数为对照基线·实施后再次 grep 应增加

# 4. node:test framework
grep -cE "from 'node:test'" tests/stuck-session-detector.test.mjs
# 必须 ≥ 1

# 5. dispatch flag 自验（per feedback_codex_sandbox §preflight 5 项）
codex exec --help 2>&1 | grep -E '\-s, \-\-sandbox'
# 必须命中
```

任一不满足 abort。

---

## 四、wiring fix（最高优先级·步骤 0 在步骤 8 之前）

### 4.1 hub.mjs /sessions 响应加 pid

```js
// hub.mjs (current)
function getSessionsList() {
  return Array.from(sessions.values()).map((s) => ({
    name: s.name,
    connectedAt: s.connectedAt,
    topics: Array.from(s.topics),
  }));
}

// hub.mjs (new)
function getSessionsList() {
  return Array.from(sessions.values()).map((s) => ({
    name: s.name,
    connectedAt: s.connectedAt,
    topics: Array.from(s.topics),
    pid: s.pid ?? null,         // ← 加 pid·null 表示 session 未声明
  }));
}
```

### 4.2 WebSocket 连入时记录 pid

option·handshake 协议字段：
```js
// hub.mjs WS handshake handler
ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.type === 'register') {
    session.name = msg.name;
    session.pid = msg.pid ?? null;   // ← 新增
    // ...
  }
});
```

### 4.3 mcp-tools.mjs 连入 Hub 时携带 pid

```js
// mcp-tools.mjs initial register message
ws.send(JSON.stringify({
  type: 'register',
  name: getSessionName(),
  pid: process.pid,                  // ← 新增
}));
```

### 4.4 测试

`tests/hub-sessions-pid.test.mjs` 至少 4 case：
1. 注册不含 pid → /sessions 响应该 session 的 pid 为 null
2. 注册含 pid=12345 → /sessions 响应 pid=12345
3. 多 session 并发注册 → 各自 pid 独立
4. session 断开 → 不影响其他 session pid

---

## 五、步骤 8·wake-cooldown 模块

### 5.1 接口契约

```js
// lib/wake-cooldown.mjs

export function createWakeCooldown({ db, cooldownMs = 5 * 60 * 1000, now = Date.now }) {
  return {
    canWake(sessionName) {
      const record = db.getWakeRecord?.(sessionName);
      if (!record) return true;
      return now() - record.last_wake_at >= cooldownMs;
    },
    recordWake(sessionName) {
      db.upsertWakeRecord?.({ name: sessionName, last_wake_at: now() });
    },
    cooldownRemainingMs(sessionName) {
      const record = db.getWakeRecord?.(sessionName);
      if (!record) return 0;
      return Math.max(0, cooldownMs - (now() - record.last_wake_at));
    },
  };
}
```

### 5.2 db.mjs 加 wake-records 表

```sql
CREATE TABLE IF NOT EXISTS wake_records (
  name TEXT PRIMARY KEY,
  last_wake_at INTEGER NOT NULL
);
```

加 `getWakeRecord(name)` / `upsertWakeRecord({name, last_wake_at})` 接口。

### 5.3 测试 5 case

1. 无记录 → canWake=true
2. 5min+ 前唤醒 → canWake=true
3. 5min 内唤醒 → canWake=false + cooldownRemainingMs > 0
4. recordWake 后立刻 canWake=false
5. 多 session 独立冷却

---

## 六、步骤 9·A 模块 v0.3 微调

### 6.1 现状

`bin/network-watchdog.mjs` 现有 `broadcastNetworkUp` 调 wake-suspended HTTP API → Hub 广播 network-up 事件 + 清空 suspended_sessions。

### 6.2 v0.3 微调

加挂起判定区分：
- `stuck-network` 唤醒条件：网络探针连续 3 次正常 + 5min 冷却外
- `stuck-rate-limited` 唤醒条件：网络探针连续 3 次正常 + Anthropic 探针正常 + 5min 冷却外（双重确认 rate limit 真实解除）

### 6.3 实施

- broadcastNetworkUp 加 reason 参数 → wake-suspended 端点按 reason 区分
- 调用方按 stuck reason 路由
- 测试覆盖 4 case（stuck-network 唤醒 / stuck-rate-limited 唤醒 / 冷却内不唤醒 / 双重确认 rate limit）

---

## 七、步骤 10·C 模块 v0.3 微调

### 7.1 wake-reaper 现状

`lib/wake-reaper.mjs` 周期扫挂起池·Anthropic 探针正常 → 触发唤醒。

### 7.2 v0.3 接入冷却模块

```js
// lib/wake-reaper.mjs (new)
import { createWakeCooldown } from './wake-cooldown.mjs';

export function createWakeReaper({ db, networkProbes, cooldown, ... }) {
  return {
    tick() {
      for (const session of db.listSuspendedSessions()) {
        if (!cooldown.canWake(session.name)) {
          continue;  // 冷却内 skip
        }
        if (networkProbes.allOk()) {
          db.unsuspendSession(session.name);
          cooldown.recordWake(session.name);
          broadcastNetworkUp({ reason: session.reason });  // 区分 reason
        }
      }
    }
  };
}
```

### 7.3 测试更新

现有 wake-reaper 测试加 case：
1. 冷却内不唤醒
2. 冷却外 + 探针正常 → 唤醒 + recordWake
3. stuck-rate-limited 唤醒走双重确认路径

---

## 八、acceptance criteria（真实场景验证·**不允许 SKIP**）

接 incident report §3.1 复刻 `feedback_ship_acceptance_equivalence` 教训·本 brief acceptance 项**全部必须执行**·不得以「避影响 portfolio」为由 SKIP（与 ADR-006 v0.3 第一波 acceptance #4 SKIP 形成对照）。

1. ✅ 全部测试 pass：`pnpm test` 或 `node --test` 跑全部 wiring + step 8/9/10 测试
2. ✅ Hub /sessions 响应包含 pid 字段（grep -cE '"pid":' /sessions response ≥ 1）
3. ✅ stuck-session-detector 不再全 skip 'no-pid-state'（实测·jianmu-pm + harness session 应有 pid）
4. ✅ watchdog restart 加载新代码（feedback_ship_then_restart·三维验明正身 + start time 验）
5. ✅ **5min watchdog 实测**：等 5 个完整 60s tick·jianmu-pm + harness + 太微 9 session 不被误 suspend（已 idle 状态不应触发 stuck）
6. ✅ **真实场景验证（自然触发优先 / 否则模拟）**：触发 1 次 rate limit·验 stuck-rate-limited 触发 + wake-cooldown 记录 + wake-reaper 自动唤醒成功
7. ✅ CLAUDE.md 同步更新（如有 schema 变化）

任一 fail → codex 必须停手 IPC jianmu-pm·**禁止 self-fix 派生新 commit 直至 jianmu-pm 确认**。

---

## 九、5min rollback 计划

acceptance #5 / #6 复刻误 suspend ≥ 2 次 / 误 wake ≥ 2 次：
1. codex 立刻 git revert 自己的 GREEN commits
2. IPC jianmu-pm 报错（含 fixture 数据 + 误触发的 session 名 + 触发的信号组合）
3. jianmu-pm 转 IPC harness 修订 ADR-006 v0.4

---

## 十、commit 规约

- 步骤 0 wiring fix RED: `test(ipc): T-ADR-006-V03-WIRING-FIX Hub /sessions pid · RED`
- 步骤 0 wiring fix GREEN: `feat(ipc): T-ADR-006-V03-WIRING-FIX Hub /sessions pid · GREEN (test from <SHA>)`
- 步骤 8 RED: `test(ipc): T-ADR-006-V03-STEP8 wake-cooldown · RED`
- 步骤 8 GREEN: `feat(ipc): T-ADR-006-V03-STEP8 wake-cooldown · GREEN (test from <SHA>)`
- 步骤 9 RED: `test(watchdog): T-ADR-006-V03-STEP9 broadcastNetworkUp v0.3 · RED`
- 步骤 9 GREEN: `feat(watchdog): T-ADR-006-V03-STEP9 broadcastNetworkUp v0.3 · GREEN (test from <SHA>)`
- 步骤 10 RED: `test(ipc): T-ADR-006-V03-STEP10 wake-reaper 接 cooldown · RED`
- 步骤 10 GREEN: `feat(ipc): T-ADR-006-V03-STEP10 wake-reaper 接 cooldown · GREEN (test from <SHA>)`
- 不加 AI 署名 / 不加 47Liu

可 TDD-collapsed（codex sandbox 不允许多 commit 时）·jianmu-pm 接力时定。

---

## 十一、sandbox 与权限

- codex 派单参数（按 feedback_codex_sandbox §preflight 5 项）：
  ```bash
  codex exec -s danger-full-access "<prompt>" \
    < /dev/null \
    > logs/codex-adr006-v03-wave2-$(date +%Y%m%d-%H%M%S).log 2>&1
  ```
- log + reports 目录预创建：`mkdir -p logs reports/codex-runs`
- **绝不**用 `--full-auto`（覆盖 sandbox）·**绝不**用 `--ask-for-approval`（v0.124+ 已移除）

---

## 十二、token + 时间预估（AI 节奏）

| 步骤 | token | 时间 |
|---|---|---|
| preflight 5 项 | 1 000 | 2 min |
| wiring fix（hub.mjs + protocol + mcp-tools + 测试）| 30 000 | ~25 min |
| 步骤 8 wake-cooldown（lib + db + 测试）| 15 000 | ~15 min |
| 步骤 9 A 模块微调（含测试）| 15 000 | ~15 min |
| 步骤 10 C 模块微调（含测试）| 12 000 | ~12 min |
| watchdog restart 加载 + 三维验 | 1 000 | 3 min |
| acceptance #5 5min 实测 | 0 | 5 min |
| acceptance #6 真实场景验证 | 0 | 等自然触发或模拟 ~5 min |
| 文档同步 | 2 000 | 5 min |
| **累计** | **76 000** | **~85 min** |

= AI 节奏 ~1.5h ship + restart + acceptance·与 cliProxy 17min / ADR-006 第一波 13min / vscode-uri 6min 实证基准对照·体量 5×·复杂度匹配。

---

## 十三、触发条件 checklist（jianmu-pm 派单前自查）

- [ ] incident report 已 ship（grep -cE wiring BUG handover/INCIDENT-...md ≥ 1）
- [ ] harness IPC 拍板（msg_id 留档到 task description）
- [ ] portfolio 当前空闲（committed_pct < 90% 防 V8 commit 爆）
- [ ] log + reports 目录已 mkdir
- [ ] codex sandbox flag = `-s danger-full-access` 单独
- [ ] dispatch 命令 grep --full-auto 0 命中
- [ ] dispatch 命令 grep --ask-for-approval 0 命中
- [ ] dispatch 命令 grep < /dev/null 1 命中
- [ ] codex exec --help 自验 -s --sandbox flag 存在
- [ ] 派单 cwd = `D:/workspace/ai/research/xiheAi/xihe-jianmu-ipc`

全 10 项打勾 → 派单 codex。任一不打勾 → 不许派。

---

## 十四、版本

| 版本 | 日期 | 变更 |
|---|---|---|
| draft v0.1 | 2026-04-27T01:05+08:00 | jianmu-pm 起草·覆盖 wiring fix（incident 触发）+ 步骤 8/9/10·acceptance 真实场景验证不许 SKIP·SOP §preflight 5 项夯实·激活条件 = harness IPC 拍板 |
