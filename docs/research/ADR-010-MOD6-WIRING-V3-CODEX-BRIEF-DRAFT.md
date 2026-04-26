# ADR-010 mod 6 wiring 第四波 Codex Brief（draft v0.1）

> **状态**：draft·等 RAM 警戒回升 02:53+ 后派 codex
> **作者**：jianmu-pm
> **起草日期**：2026-04-27T02:42+08:00
> **触发条件**：harness 02:39 拍板修复方案 A·INCIDENT v2 已 ship
> **覆盖**：watchdog estimateContextPct 改用 cwd → transcripts 目录·绕开 ~/.claude/sessions/<pid>.json 依赖

---

## 一、目标

修 ADR-010 mod 6 wiring v2（5c5d495）的 ship-but-no-effect 第 3 次复刻。让 watchdog 真正读到 active session transcript·estimateContextPct 返实际 pct 值·triggerHandover 真触发 atomic handoff lineage 9→10。

---

## 二、Scope

### in
- `mcp-server.mjs` register message 加 cwd 字段（process.cwd() 推送）
- `hub.mjs` /sessions schema 加 cwd 字段（pid + contextUsagePct 同模式）
- `lib/protocol.mjs` register 协议加 cwd 可选字段
- `bin/network-watchdog.mjs` estimateContextPct 改用 cwd → 扫 transcripts 目录·按 mtime 最新 .jsonl 估算
- 测试：tests/hub-sessions-pid.test.mjs 加 cwd persist case + tests/watchdog-main.test.mjs handover 实际生产路径 case（不用 mock state）

### out
- ADR-010 其他模块 1-5（harness own）
- ADR-008 三层模板（harness own）
- VSCode 扩展 xihe-portfolio-spawn（独立 brief）

---

## 三、preflight 检查（codex 起步前必跑·SOP §preflight 5 项）

```bash
# 1. INCIDENT v2 已 ship
test -f handover/INCIDENT-ADR-010-MOD6-WIRING-BUG-V2-20260427.md
grep -cE 'session-state-reader 返 null|active session' handover/INCIDENT-ADR-010-MOD6-WIRING-BUG-V2-20260427.md
# ≥ 2

# 2. 第二波 wiring fix 已 ship
grep -cE 'estimateContextPctFromTranscript|transcriptPath' bin/network-watchdog.mjs
# ≥ 2

# 3. encodeProjectPath 已存在（复用）
grep -cE 'encodeProjectPath' lib/session-state-reader.mjs
# ≥ 1

# 4. register 路径
grep -cE 'createRegisterMessage|process.pid' mcp-server.mjs lib/mcp-tools.mjs
# ≥ 2

# 5. dispatch flag 自验
codex exec --help 2>&1 | grep -E '\-s, \-\-sandbox'
# 命中
```

任一不满足 abort。

---

## 四、实施

### 4.1 mcp-server.mjs register 加 cwd

```js
// 改前
socket.send(JSON.stringify(createRegisterMessage({ name: IPC_NAME, pid: process.pid })));

// 改后
socket.send(JSON.stringify(createRegisterMessage({
  name: IPC_NAME,
  pid: process.pid,
  cwd: process.cwd(),
})));
```

### 4.2 hub.mjs /sessions schema 加 cwd

`hub.mjs` register handler 接收 cwd + 存 session.cwd：
```js
session.pid = msg.pid ?? null;
session.cwd = msg.cwd ?? null;            // ← 新增
```

`hub.mjs` getSessionsList 加 cwd 字段：
```js
return {
  name: s.name,
  connectedAt: s.connectedAt,
  topics: Array.from(s.topics),
  pid: s.pid ?? null,
  cwd: s.cwd ?? null,                      // ← 新增
  contextUsagePct: s.contextUsagePct ?? null,
};
```

### 4.3 lib/protocol.mjs register schema

```js
// createRegisterMessage 加 cwd 可选字段
export function createRegisterMessage({ name, pid = null, cwd = null, contextUsagePct = null }) {
  return { type: 'register', name, pid, cwd, contextUsagePct };
}
```

### 4.4 bin/network-watchdog.mjs estimateContextPct 改造

```js
// 改前 line 991
estimateContextPct: async (sessionRecord = entry.sessionRecord) => {
  const state = getSessionStateImpl(sessionRecord?.pid);
  if (!state?.transcriptPath) return 0;
  const pct = estimateContextPctFromTranscript(state.transcriptPath);
  stderr(`[network-watchdog] estimateContextPct transcript session=${sessionName} pid=${sessionRecord?.pid ?? 'unknown'} pct=${pct}`);
  return pct;
}

// 改后
estimateContextPct: async (sessionRecord = entry.sessionRecord) => {
  // 优先 cwd（v3 fix·不依赖 ~/.claude/sessions/<pid>.json）
  const cwd = sessionRecord?.cwd;
  if (!cwd) {
    stderr(`[network-watchdog] estimateContextPct no cwd for session=${sessionName} pid=${sessionRecord?.pid ?? 'unknown'}`);
    return 0;
  }
  const transcriptPath = findLatestTranscriptByCwd(cwd);  // 新工具函数
  if (!transcriptPath) {
    stderr(`[network-watchdog] estimateContextPct no transcript for session=${sessionName} cwd=${cwd}`);
    return 0;
  }
  const pct = estimateContextPctFromTranscript(transcriptPath);
  stderr(`[network-watchdog] estimateContextPct transcript session=${sessionName} cwd=${cwd} transcript=${transcriptPath} pct=${pct}`);
  return pct;
}
```

### 4.5 新工具 findLatestTranscriptByCwd

`lib/session-state-reader.mjs` 加 export（复用 encodeProjectPath）：
```js
export function findLatestTranscriptByCwd(cwd, opts = {}) {
  if (!cwd || typeof cwd !== 'string') return null;
  const projectDir = encodeProjectPath(cwd);
  if (!projectDir) return null;
  const transcriptsDir = join(getClaudeDir(opts), 'projects', projectDir);
  if (!existsSync(transcriptsDir)) return null;
  let entries;
  try {
    entries = readdirSync(transcriptsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const jsonlFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => {
      const path = join(transcriptsDir, e.name);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {}
      return { path, mtimeMs };
    });
  if (jsonlFiles.length === 0) return null;
  jsonlFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return jsonlFiles[0].path;  // 最新 mtime
}
```

---

## 五、测试覆盖

### 5.1 tests/hub-sessions-pid.test.mjs 加 case
- T-ADR-010-MOD6-WIRING-V3 /sessions persists cwd from register
- T-ADR-010-MOD6-WIRING-V3 cwd null when not provided

### 5.2 tests/session-state-reader.test.mjs 加 case
- findLatestTranscriptByCwd: cwd 不存在 → null
- findLatestTranscriptByCwd: 多 .jsonl 取 mtime 最新
- findLatestTranscriptByCwd: 目录无 .jsonl → null

### 5.3 tests/watchdog-main.test.mjs 改造
- 修改现有 handover focused test：用 cwd-driven path（不用 mock getSessionStateImpl）
- mock createTempDir + 创建 mock transcript file·测试 handover 真实读取路径

---

## 六、acceptance 7 项·**不许 SKIP**

1. ✅ 全部测试 pass（不破坏 632/632 现有 + 新增 cwd-driven 测试）
2. ✅ Hub /sessions 响应含 cwd 字段（grep '"cwd":' ≥ 1）
3. ✅ register 推送 cwd（curl /sessions 后看 jianmu-pm cwd 不为 null）
4. ✅ findLatestTranscriptByCwd 工具实测（手工调 + node REPL 验证）
5. ⏳ **5min watchdog 实测·jianmu-pm 主动跑·不被动等**·**实战触发 atomic handoff lineage 9→10·见到新 spawn**
6. ✅ cooldown 5min 防抖
7. ✅ CLAUDE.md schema sync（cwd 字段说明）

---

## 七、commit 规约

- 单 commit: `feat(ipc): T-ADR-010-MOD6-WIRING-V3 watchdog 用 cwd 扫 transcripts 绕 session-state 依赖`
- 不加 AI 署名 / 不加 47Liu

---

## 八、sandbox 与权限（SOP §preflight 5 项·目标 7 连续 0-violation）

```bash
codex exec -s danger-full-access \
  < /dev/null \
  > logs/codex-adr010-mod6-wiring-v3-$(date +%Y%m%d-%H%M%S).log 2>&1 \
  "<prompt>"
```

不用 `--full-auto` / 不用 `--ask-for-approval` / 关 stdin / log 落 logs/。

---

## 九、token + 时间预估

| 步骤 | token | 时间 |
|---|---|---|
| preflight 5 | 1 000 | 2 min |
| mcp-server + Hub schema cwd 字段 | 5 000 | 10 min |
| watchdog estimateContextPct 改 + findLatestTranscriptByCwd | 8 000 | 15 min |
| 测试覆盖 | 6 000 | 10 min |
| acceptance #5 实测·jianmu-pm 接力 | 0 | 5 min |
| **累计** | **20 000** | **~42 min** |

= AI 节奏·与 cliProxy 17min / ADR-006 第一波 13min / ADR-010 mod 6 ~10min / wiring v1 ~10min / wiring v2 ~10min 实证基准对照·体量类似 wiring v2。

---

## 十、派单触发 checklist（jianmu-pm 派单前自查·SOP §preflight 5 项）

- [ ] INCIDENT v2 ship（grep 命中）
- [ ] harness 拍板 msg_id 留档（msg_1777228772823_157330）
- [ ] **RAM 警戒回升**（available_ram_mb > 12GB·当前 < 10GB·等 02:53+ 观察）
- [ ] log + reports 目录已 mkdir
- [ ] codex sandbox flag = -s danger-full-access 单独
- [ ] dispatch grep --full-auto = 0
- [ ] dispatch grep --ask-for-approval = 0
- [ ] dispatch grep < /dev/null = 1
- [ ] codex exec --help 自验 -s --sandbox flag 存在
- [ ] cwd = xihe-jianmu-ipc

全 10 项打勾 → 派单。

---

## 十一、实战验证计划（acceptance #5）

ship + restart watchdog 后：
- jianmu-pm **主动监测 watchdog log + Hub /sessions + ipc_sessions**·5min 内透明实测
- 见到 estimateContextPct stderr 含 cwd + transcript + pct（lineage 9 应 70%+ 真值）
- 见到 lineage 9 → lineage 10 atomic handoff 实际触发（rename → spawn → cold start）
- 实战 atomic handoff 触发 = ADR-010 mod 6 完整闭环实证

如 5min 内仍 0 触发 → 第 4 次 ship-but-no-effect 调查（候选 2/3/4）。

---

## 十二、版本

| 版本 | 日期 | 变更 |
|---|---|---|
| draft v0.1 | 2026-04-27T02:42+08:00 | jianmu-pm 起草·修 wiring v2 ship-but-no-effect 第 3 次复刻·A 路径 cwd-driven 不依赖 session-state file·派单 checklist 10 项·acceptance 7 项 #5 实战不许 SKIP |
