# ADR-008: ipc_reclaim_my_name 自助僵尸回收工具

**日期**：2026-04-22
**状态**：Phase 1 DONE（2026-04-24 master 落地）

## Phase 1 实施记录

| 项 | 值 |
|----|-----|
| 合并时点 | 2026-04-24T12:46+08:00 |
| master HEAD | 90590a4（从 4b51f29 → 90590a4，+654/-3，11 files，含 2 new test file） |
| 分支 | `feature/reclaim-my-name` ff-only merge，origin 保留 7 天作证据链 |
| 测试 | `npm test` 545/545 pass，exit 0；unit 7 + integration 3 reclaim-name + mcp-tools 1 `ipc_reclaim_my_name` 全绿 |
| 实现文件 | `lib/session-reclaim.mjs` 93 行 5 分支状态机（no-holder / pending-rebind / rate-limit 10s / 主动 ping+5s pong / evict）、`lib/http-handlers.mjs` `POST /reclaim-name` loopback-only + 1KB body cap + audit log、`hub.mjs` 注入 3 行、`lib/mcp-tools.mjs` + `mcp-server.mjs` `ipc_reclaim_my_name` 工具 |
| grep 自证 | `/reclaim-name` 36 命中 8 文件；`createSessionReclaimHandler` / `ipc_reclaim_my_name` / `reclaim_evict` / `holder-alive` / `pending-rebind-in-progress` / `rate-limited` 92 命中 11 文件；ws isAlive 假信号 0；反向断言 `lastTransitionAt==0` / `IPC_AUTH_TOKEN==0` 全部符合 |
| LGTM 三签 | Codex 2026-04-23T12:26 跑完报告 ✅ / jianmu-pm 2026-04-24T12:46 review+merge ✅ / harness 2026-04-24T12:49 落档 ✅ |
| 存量漏洞 | 9 个 dependabot vuln 是 base 3916bb9 存量，ADR-008 commit 未新增 |
| 规范同步 | `xihe-tianshu-harness/domains/software/knowledge/session-cold-start.md` v1.2 → v1.3 删场景 B "工具未上线时的兜底" 段（工具已上线废止） |

## 设计（原文）

## 背景

`session-cold-start.md` v1.1 场景 B：旧 session 崩溃/冻结但 Hub 侧 `ws.readyState` 还停在 `OPEN`（心跳 isAlive 翻转要等 30s），新同名 session 启动后连 Hub 被拒 `4001 name taken`，陷入"老的没死透、新的进不来"死锁。

现有绕路三条全不理想：

1. **`?force=1` URL 参数**：需要 AI 直接构造 WS URL，这是 MCP 协议层下沉到传输层细节，AI 没有也不该有这种权限。
2. **Hub 自动 isAlive 检测**：`hub.mjs` L350-368 的 zombie 判据依赖 `ws.isAlive === false + staleMs > 2*HEARTBEAT_INTERVAL`，但 `isAlive` 由 pong 回包翻转，zombie 的 ws 可能 pong 还没超时，检测要等 30-60s。
3. **IPC jianmu-pm 手动 evict**：人肉介入，违背"AI 自主恢复"目标，且 jianmu-pm 本身也可能 zombie。

需要给所有 session 一个 AI 可调的自助回收工具，完成"我是 X，有个老的 X 卡着，请帮我把它踢了让我上"。

## 决策

新增 MCP 工具 `ipc_reclaim_my_name(name)`，走 Hub HTTP endpoint `POST /reclaim-name`，仅接受 `127.0.0.1` 访问。Hub 对目标 session 主动 ping + 5s 等 pong，zombie 判定则 evict 并回放 inbox（复用现有 force-rebind 路径）。

### 接口

**MCP 工具签名**（`mcp-server.mjs` + `lib/mcp-tools.mjs`）：

```
ipc_reclaim_my_name(name: string) → { ok: boolean, evicted?: boolean, reason?: string, lastAliveAt?: number }
```

`name` 必须是调用方将要占用的 session 名（通常等于 `process.env.IPC_NAME`）。

**Hub endpoint**（`lib/http-handlers.mjs` + `hub.mjs`）：

```
POST http://127.0.0.1:3179/reclaim-name
Content-Type: application/json
Body: { "name": "harness" }

Responses:
  200 { ok: true, evicted: true, previousConnectedAt }
  200 { ok: false, reason: "holder-alive", lastAliveAt }
  200 { ok: false, reason: "no-holder" }        // 名字本来就空，直接连 WS 即可
  400 { ok: false, reason: "name required" }
  403 { ok: false, reason: "non-loopback" }     // 非 127.0.0.1 直接拒
```

**端点级 auth**：只校验 `req.socket.remoteAddress === '127.0.0.1'`，**不走** `IPC_AUTH_TOKEN`/`auth-tokens.json` 全局网关。理由见"威胁模型"段。

### Zombie 判据

Hub 收到 `/reclaim-name { name }` 后：

1. `existing = sessions.get(name)`
   - 不存在 → 回 `{ok:false, reason:"no-holder"}`
   - 存在但 `ws.readyState !== OPEN` → 直接视为 zombie，跳 4
2. **主动 ping 探测**：给 `existing.ws` 发 ping，挂 5 秒 timer
   - 5s 内收到 pong → `{ok:false, reason:"holder-alive", lastAliveAt: now()}`，不 evict
   - 5s 内没收到 pong → 视为 zombie，继续 3
3. （safeguard）查 `findPendingRebind(name)`，若存在 release-rebind 挂起 → `{ok:false, reason:"pending-rebind-in-progress"}`。`/prepare-rebind` 显式接力优先于 reclaim
4. **Evict**：
   - `audit('reclaim_evict', { name, previousConnectedAt, remoteAddress })`
   - `existing.ws.terminate()`
   - 不清 inbox、不清 pendingRebind 之外的状态（下一次 WS 连入会走现有 L350-404 zombie/正常分支，inbox 自动回放）
   - 回 `{ok:true, evicted:true, previousConnectedAt}`

**5 秒 ping 超时的选择**：commit 18 `wsDisconnectGraceMs` 默认 60s 是防误判被动 grace，本场景是显式调用者等待，**5s 足够一往返**且对调用方不过慢。`HEARTBEAT_INTERVAL` 当前 30s，pong 往返一般 < 1s，5s 有 5× 冗余。

### 调用方流程

```
mcp-server 冷启：
  ipc_sessions()               // 查当前注册
  → 发现 "harness" 已有连接，但本进程 IPC_NAME=harness
  ipc_reclaim_my_name("harness")
  → ok:true evicted:true  → WS connect 作为 harness（走现有 force-rebind 代码，inbox 回放）
  → ok:false holder-alive → 老的还活着，停工 + IPC jianmu-pm 报 "name conflict"
  → ok:false pending-rebind-in-progress → 等 release-rebind 宽限期到（≤ 60s）后重试
  → ok:false no-holder    → 直接 WS connect 作为 harness
```

`session-cold-start.md` v1.2 场景 B 标准路径：把原来的"IPC jianmu-pm 求手工 evict"替换为 `ipc_reclaim_my_name()`。

## 威胁模型

选 "localhost 绑定" 而非 "self-only via WS context"（方案 A）：

| 维度 | 方案 B（选中）| 方案 A |
|------|--------------|--------|
| 调用前置 | 无需 WS 连接 | 需要先用 fallback name 连 WS |
| 安全边界 | 127.0.0.1 | WS session 身份 + IPC_NAME env 对比 |
| 调用方实现 | mcp-server HTTP 直调 | mcp-server fallback-connect 逻辑 + WS query param 传意图 |
| Hub 实现 | +40 行 | +~80 行（解析 WS connect intent + 身份对比） |
| scenario B 流程 | zombie → reclaim → 直接连 | zombie → fallback 连 → reclaim → rename/重连 |

**安全性等价**：方案 A 的 WS 身份验证在 localhost 之上不增加实际保护——同机攻击者已经可以 `taskkill` Hub、直接改 SQLite inbox、读 `.ipc-internal-token`。在 localhost 信任边界之上再叠一层 WS 身份是**工程复杂度成本**而非安全收益。

**localhost 攻击面分析**：
- 恶意进程在本机伪造 `/reclaim-name` 调用 → 能踢任意在线 session
- 但同进程已可 `taskkill` 所有 node.exe（feedback_no_kill_node 反面）、读写 `~/.claude/sessions-registry.json`、直接 inject MCP 工具
- reclaim 工具不引入新攻击向量，只是把原本"127.0.0.1 可做"的事情 API 化

**限频兜底**：防循环调用 / 脚本误用：同 name 每 10 秒最多 1 次 reclaim（Hub 内存 Map），超频回 `{ok:false, reason:"rate-limited", retryAfterMs}`。

## 实现分解

1. **`lib/http-handlers.mjs`**：`POST /reclaim-name` handler（localhost 检查 + body 解析 + 调 reclaim 服务）
2. **`lib/session-reclaim.mjs`**（新建）：核心逻辑——zombie 判据、ping+5s 超时、audit、evict
3. **`hub.mjs`**：注册 handler，注入 sessions + audit + findPendingRebind 依赖
4. **`lib/mcp-tools.mjs`**：`ipc_reclaim_my_name` 工具定义 + dispatcher
5. **`mcp-server.mjs`**：工具 export（跟随 `mcp-tools.mjs` 自动生效，检查一次清单即可）
6. **测试**：
   - `tests/session-reclaim.test.mjs`（单元）：zombie 判定、pong 收到、pending-rebind 冲突、non-loopback 拒绝、rate-limit
   - `tests/integration/reclaim-name.test.mjs`（集成）：端到端 zombie 踢 + inbox 回放 + holder-alive 拒绝
   - `tests/mcp-tools.test.mjs`：新增 `ipc_reclaim_my_name` 调用单测
7. **文档**：`CLAUDE.md` MCP Tools 清单 + HTTP API 清单更新、`README.md` + `README.zh-CN.md` 同步、`SKILL.md`（OpenClaw）同步

## 关键原则

1. **自助优先**：AI 不需要也不应该碰 `?force=1` URL。MCP 层对 AI 暴露的永远是工具，不是协议细节
2. **localhost 即信任边界**：不叠额外 auth，和 ADR-005 `/internal/network-event` 的 `127.0.0.1-only` 设计一致
3. **现有 force-rebind 路径复用**：reclaim 只负责"让新连接进得来"，inbox 回放/topics 不恢复完全走 hub.mjs L350-404 老代码
4. **显式接力优先**：`POST /prepare-rebind` 发起的 release-rebind 期间禁止 reclaim（避免显式接力被 reclaim 截胡）
5. **限频防脚本误用**：10 秒 1 次同 name 硬性上限

## 后果

**正面**：
- Scenario B cold-start 死锁 AI 自助解除，不再需要 jianmu-pm 人工介入
- `session-cold-start.md` v1.2 标准路径单一，无"工具未上线兜底"分支
- 为未来"session 启动自检 + 自动清理"（冷启 skill 延展）留出接口

**负面**：
- Hub 对外端点 +1（已有 11+ 个，增量可接受）
- 限频 Map 额外内存占用（< 1KB）

**风险**：
- Ping+5s 误判：极端网络下 pong 往返 > 5s 会错杀活连接。缓解：rate-limit 10s 内只允许 1 次，即使错杀单次也可接受（原 session 断后立即 force-rebind 重连，最多 inbox 回放一次）
- 被恶意调用循环踢：localhost 攻击者已可 taskkill，reclaim 不增加额外向量；rate-limit 作为 defense-in-depth
- 和 commit 18 watchdog 的 `/session-alive` 判据不一致：watchdog 用 `readyState === OPEN`（被动），reclaim 用主动 ping+pong（显式）。两者用途不同可并存——watchdog 是观察者、reclaim 是行动者

## 相关

- ADR-003: offline inbox SQLite 持久化（reclaim 后 inbox 回放走这条）
- ADR-005: Hub 模块化分层（新 `lib/session-reclaim.mjs` 延续 lib 分层）
- ADR-006: Register-ScheduledTask 参数转义（本 ADR 不涉及 daemon，参考无关）
- 规范：`xihe-tianshu-harness/` `session-cold-start.md` v1.2 场景 B
- 复用代码：`hub.mjs` L350-404 force-rebind/zombie-rebind 分支、`lib/rebind-state.mjs` pendingRebind helper
- Commit 18 相关：`/session-alive` 端点（观察）vs `/reclaim-name`（行动），语义明确分离
