# ADR-006 v0.3 实施 Codex Brief（draft v0.1）

> **状态**：draft·等老板拍板 ADR-006 v0.3 转 Accepted 后由 jianmu-pm 派 codex 触发
> **作者**：jianmu-pm（建木项目经理）
> **起草日期**：2026-04-26T18:48+08:00
> **触发条件**：老板 IPC 老板拍板 ADR-006 v0.3 转 Accepted（当前 v0.3 状态：设计待拍板）
> **覆盖**：ADR-006 v0.3 §四步骤 6 + 7（第一波：session-state-reader + 五信号 AND 卡住判定）。步骤 8/9/10 在第一波 ship 后再起第二份 brief

---

## 一、目标

实现 ADR-006 v0.3 §五.1 第 0 模块（session 状态读取层）+ §五.2 B 模块（五信号 AND 卡住判定）。**完全替换** v0.2 `lib/stale-suspend-detector.mjs` 单信号判定，解决：
- 不能区分 idle vs stuck（feedback_idle_not_standby）
- 单 session 网络抖时全局探针看一切正常
- 历史错误关键字误判被唤醒后又干活的 session

判断完成：步骤 6+7 RED+GREEN 双 commit + v0.2 模块 git revert + watchdog 接线 + 真实 session 实测验证（用 jianmu-pm 自己 + harness 当 fixture）。

## 二、Scope（**仅本 brief 范围**）

### in
- 新建 `lib/session-state-reader.mjs`（约 80 行）+ 测试
- 新建 `lib/stuck-session-detector.mjs`（约 150 行，五信号 AND）+ 测试
- `bin/network-watchdog.mjs` 接线 stuck-session-detector，移除 stale-suspend-detector 调用
- `git revert` v0.2 stale-suspend-detector 实施 commit `e98a070` + `84c0994`（保留 git 历史）
- `CLAUDE.md` 同步更新（移除 lastAliveProbe stale 判定描述，加五信号 AND 描述）

### out
- 步骤 8（唤醒冷却模块）、步骤 9（A 模块微调）、步骤 10（C 模块微调）→ 第一波 ship 后另起 brief
- ADR-009 第 1 模块（rate-limit 探针，复用 session-state-reader）→ 不在本 brief 范围

---

## 三、preflight 检查（codex 起步前必跑·grep 模式 per feedback_codex_brief_preflight_relax.md）

```bash
# 1. ADR-006 v0.3 已 ship 且 v0.3 状态明确
grep -E "状态.*v0\.3|status.*Accepted" xihe-tianshu-harness/handover/adr/ADR-006-PORTFOLIO-ECONNRESET-AUTO-RECOVERY.md
# 命中预期：包含 "v0.3" 字符 ≥ 1 + 必须看到 "Accepted"（否则 brief 触发条件未到，立刻 abort 报 jianmu-pm）

# 2. v0.2 stale-suspend-detector 当前还在 git 仓
grep -E "createStaleSuspendDetector|stale-suspend-detector" lib/stale-suspend-detector.mjs bin/network-watchdog.mjs
# 命中预期：≥ 2 处（lib 定义 + watchdog 接线）

# 3. 测试 framework 是 node:test（不是 vitest）
grep -E "from ['\"]node:test['\"]" tests/stale-suspend-detector.test.mjs
# 命中预期：1 处

# 4. claude session-state 路径存在
test -d ~/.claude/sessions && ls ~/.claude/sessions/*.json | head -3
# 命中预期：≥ 1 个 .json 文件

# 5. 五信号 AND 矩阵存在 ADR 文档（避免 codex 自己编 spec）
grep -E "五信号 AND|status.*busy|updatedAt|transcript|错误关键字|冷却" xihe-tianshu-harness/handover/adr/ADR-006-PORTFOLIO-ECONNRESET-AUTO-RECOVERY.md
# 命中预期：≥ 5 处（5 个信号关键字各命中一次）
```

任一 preflight 不通过 → codex 必须 abort 报回 jianmu-pm，不得猜测继续。

---

## 四、步骤 6·session-state-reader 实施 spec

### 4.1 接口契约

```js
// lib/session-state-reader.mjs

export function getAllSessionStates(opts = {}) {
  // opts.dir: 默认 ~/.claude/sessions
  // opts.now: () => Date.now()，可注入测试
  // 返回 Array<{pid, sessionId, status, updatedAt, transcriptPath, idleMs, busyMs}>
  // 静默跳过：无法解析的 .json / 无 pid 字段的 / status 不在 ['busy', 'idle'] 集合
  // 不抛错：目录不存在返回 []
}

export function getSessionState(pid, opts = {}) {
  // 单条查询，未找到返回 null
}
```

### 4.2 schema 字段定义

| 字段 | 来源 | 含义 |
|---|---|---|
| pid | `session.json` `pid` | OS 进程 ID |
| sessionId | `session.json` `sessionId` | UUID |
| status | `session.json` `status` | `busy` / `idle` |
| updatedAt | `session.json` `updatedAt` ms | 状态切换 ts |
| transcriptPath | 推算：`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` | transcript 文件路径 |
| idleMs | `now() - updatedAt`（status=idle 时）| 待机时长 |
| busyMs | `now() - updatedAt`（status=busy 时）| 干活时长 |

**注意**：transcriptPath 推算逻辑需查现有 Claude Code 习惯（参考 `~/.claude/projects/` 目录命名规则）。如不能可靠推算，schema 可省 transcriptPath，由 stuck-session-detector 自行查找。

### 4.3 测试（RED first）

`tests/session-state-reader.test.mjs` 至少 5 case：
1. 目录不存在 → 返回 []
2. 单条 valid session.json → 返回 1 条 schema 完整
3. 多条混合（valid + 损坏 + 无 pid）→ 返回 valid 那条（其余静默跳过）
4. status=idle 时 idleMs 计算正确，busyMs=0
5. status=busy 时 busyMs 计算正确，idleMs=0

测试 fixture 用 `os.tmpdir()` + 临时 .json 文件，不用 mock fs。

### 4.4 commit 规约
- RED commit: `test(ipc): T-ADR-006-V03-STEP6 session-state-reader · RED`
- GREEN commit: `feat(ipc): T-ADR-006-V03-STEP6 session-state-reader · GREEN (test from <RED-SHA>)`

---

## 五、步骤 7·stuck-session-detector 实施 spec

### 5.1 接口契约

```js
// lib/stuck-session-detector.mjs

export function createStuckSessionDetector({
  db,                    // 同 v0.2，复用 db.suspendSession / db.listSuspendedSessions
  getSessions,           // 同 v0.2，返回 Map<name, sessionRecord>
  getSessionState,       // 注入 from session-state-reader
  readTranscriptTail,    // 注入 (path, lines=20) => string，可测试 mock
  now = Date.now,
  cooldownMs = 5 * 60 * 1000,
  stuckThresholdMs = 5 * 60 * 1000,
  errorKeywords = ['ECONNRESET', '429', 'Unable to connect', /attempt \d+\/10/, 'rate limit'],
}) {
  return {
    tick() {
      // 返回 { detected: string[], skipped: Array<{name, reason}> }
    }
  }
}
```

### 5.2 五信号 AND 判定矩阵（按 ADR §5.2.1 严格实现）

```
session.name → 是否标 stuck？

1. 信号 1·status busy
   sessionState = getSessionState(session.pid)
   if (!sessionState || sessionState.status !== 'busy') → skip 'not-busy'

2. 信号 2·updatedAt 老
   if (now - sessionState.updatedAt < stuckThresholdMs) → skip 'fresh-update'

3. 信号 3·transcript mtime 老
   stat = fs.statSync(sessionState.transcriptPath)
   if (now - stat.mtimeMs < stuckThresholdMs) → skip 'fresh-transcript'

4. 信号 4·错误关键字命中
   tail = readTranscriptTail(sessionState.transcriptPath, 20)
   hit = errorKeywords.some(kw => kw instanceof RegExp ? kw.test(tail) : tail.includes(kw))
   if (!hit) → skip 'no-error-keyword'

5. 信号 5·冷却期外
   last = recentlyDetected.get(session.name) || 0
   if (now - last < cooldownMs) → skip 'cooldown'

# 全 5 信号 AND 命中 → 调 db.suspendSession({
#   name: session.name,
#   reason: tail.match(/429|rate limit/i) ? 'stuck-rate-limited' : 'stuck-network',
#   task_description: `stuck detected by 5-signal AND · keyword=<matched>`,
#   suspended_by: 'watchdog',
# })
# 同时 recentlyDetected.set(session.name, now)
```

### 5.3 边界 case

- session.pid 不在 session-state-reader 结果里 → skip 'no-pid-state'（可能是 reader 未覆盖到的进程）
- transcriptPath 文件不存在 → skip 'no-transcript'
- transcriptPath 文件读失败 → skip 'transcript-read-failed'（不抛错）
- 已在 suspendedSessions 列表里 → skip 'already-suspended'
- WS 不 OPEN → skip 'ws-not-open'

### 5.4 测试（RED first）

`tests/stuck-session-detector.test.mjs` 至少 12 case：

#### 五信号 AND 全命中 → suspend
1. 全 5 信号命中（status=busy + updatedAt 老 + transcript 老 + 命中 ECONNRESET + 冷却外） → `detected: ['name']` + db.suspendSession 调一次

#### 单信号 fail → skip
2. 信号 1 fail（status=idle）
3. 信号 2 fail（updatedAt 鲜）
4. 信号 3 fail（transcript mtime 鲜）
5. 信号 4 fail（无错误关键字）
6. 信号 5 fail（冷却内）

#### 边界 case
7. session.pid 不在 reader 结果 → skip
8. transcriptPath 文件不存在 → skip
9. WS not OPEN → skip
10. 已 suspended → skip

#### reason 区分
11. 命中 'rate limit' → reason='stuck-rate-limited'
12. 命中 'ECONNRESET' → reason='stuck-network'

### 5.5 watchdog 接线

`bin/network-watchdog.mjs`:
```js
// 移除：
import { createStaleSuspendDetector } from '../lib/stale-suspend-detector.mjs';
const staleDetector = createStaleSuspendDetector({ ... });
setInterval(() => staleDetector.tick(), 60_000);

// 替换为：
import { createStuckSessionDetector } from '../lib/stuck-session-detector.mjs';
import { getSessionState } from '../lib/session-state-reader.mjs';
import { readFileSync } from 'node:fs';

function readTranscriptTail(path, lines = 20) {
  try {
    const data = readFileSync(path, 'utf8');
    return data.split('\n').slice(-lines).join('\n');
  } catch { return ''; }
}

const stuckDetector = createStuckSessionDetector({
  db,
  getSessions: () => /* hub.sessions or HTTP fetch */,
  getSessionState,
  readTranscriptTail,
});
setInterval(() => stuckDetector.tick(), 60_000);
```

### 5.6 v0.2 revert

```bash
git revert --no-edit e98a070 84c0994
```

revert 后 `lib/stale-suspend-detector.mjs` + 其测试文件应被删除。如未删除（revert 仅恢复 commit 时点状态），手工 `git rm`。

### 5.7 commit 规约

- RED commit: `test(ipc): T-ADR-006-V03-STEP7 stuck-session-detector 5-signal AND · RED`
- GREEN commit: `feat(ipc): T-ADR-006-V03-STEP7 stuck-session-detector 5-signal AND · GREEN (test from <RED-SHA>)`
- revert commit: `revert(ipc): v0.2 stale-suspend-detector · 被 v0.3 五信号 AND 替换`
- watchdog 接线 commit: `feat(watchdog): 接 stuck-session-detector · ADR-006 v0.3 · 移除 stale-suspend-detector`

---

## 六、acceptance criteria（codex 收尾自验）

1. 全部测试通过：`pnpm test tests/session-state-reader.test.mjs tests/stuck-session-detector.test.mjs`
2. v0.2 模块 git revert + 文件删除：`ls lib/stale-suspend-detector.mjs` 应失败
3. watchdog 接线：`grep -E "createStuckSessionDetector" bin/network-watchdog.mjs` ≥ 1
4. 真实 session 实测：watchdog 跑 5 分钟，jianmu-pm + harness 都不会被 false positive 误 suspend（status=busy 但 transcript 在动）
5. CLAUDE.md 同步更新：移除 lastAliveProbe stale 描述，加五信号 AND 描述

任一 fail → codex 必须停手 IPC jianmu-pm，**禁止 self-fix 派生新 commit 直至 jianmu-pm 确认**。

---

## 七、sandbox 与权限

- codex 派单参数：`-s danger-full-access`（per feedback_codex_sandbox + feedback_codex_deps_install）
- log 目录预创建：`mkdir -p reports/codex-runs logs/`（per feedback_codex_log_dir_mkdir）
- 不允许：跳过 hook、--no-verify、修改 .gitignore 隐藏 log

## 八、rollback 计划

如 5 分钟实测出现误 suspend ≥ 2 次：
1. codex 立刻 git revert 自己的 GREEN + 接线 commits
2. IPC jianmu-pm 报错（含 fixture 数据 + 误 suspend 的 session 名 + 触发的信号组合）
3. jianmu-pm 转 IPC harness 修订 ADR-006 v0.4

---

## 九、token + 时间预估

| 步骤 | token | 时间 |
|---|---|---|
| preflight | 1 000 | 2 分钟 |
| 步骤 6 RED+GREEN | 5 000 | 25 分钟 |
| 步骤 7 RED+GREEN | 12 000 | 60 分钟 |
| revert + watchdog 接线 | 3 000 | 15 分钟 |
| 真实 session 实测 | 2 000 | 10 分钟 |
| 文档同步 | 2 000 | 10 分钟 |
| **累计** | **25 000** | **~2 小时** |

与 ADR-006 §四步骤 6+7 预算（5 000 + 10 000 = 15 000）偏高 1.7×，因 brief 加了完整测试矩阵 + 实测验证，比 ADR 预算更稳。

---

## 十、触发条件 checklist（jianmu-pm 派单前自查）

- [ ] ADR-006 v0.3 状态 == Accepted（grep handover/adr/ADR-006-...md 看到）
- [ ] 老板 IPC 拍板（msg_id 留档到 task description）
- [ ] portfolio 当前空闲（无 in-flight 大 codex 派单避免 V8 commit 爆 → 查 `committed_pct`）
- [ ] log 目录已 mkdir
- [ ] codex sandbox flag = danger-full-access
- [ ] 派单 cwd = `D:/workspace/ai/research/xiheAi/xihe-jianmu-ipc`

全 6 项打勾 → 派单 codex。任一不打勾 → 不许派。

---

## 十一、版本

| 版本 | 日期 | 变更 |
|---|---|---|
| draft v0.1 | 2026-04-26T18:48+08:00 | jianmu-pm 起草·覆盖步骤 6+7（第一波）·等老板拍板 ADR-006 v0.3 转 Accepted 后激活 |
