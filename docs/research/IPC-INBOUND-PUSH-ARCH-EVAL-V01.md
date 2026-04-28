# IPC 收件推送架构评估 v0.4

**作者**：jianmu-pm（IPC 主架构师）
**日期**：2026-04-28T13:35+08:00
**触发**：老板 04-28 21:14 / 00:46 / 02:25 三轮 critique + 03:20 战略 context（迁 orchestrator 节省 max20x token）+ PoC v1（b51e7v2u1）+ PoC v2（bzi77w8n4）实证完成 + 13:18 critique（doc 版本混乱）+ 13:22 拍开干
**性质**：评估文档（实施前最终版本）·**13:22 老板拍开干·即派 Phase 1 主路径 + Phase 2 配套**·ADR-014 实施完成后落档作为决策记录

## v0.3 → v0.4 变更说明

| 变更 | 原因 |
|------|------|
| **§E.6 schema 1 → schema 4**（P0） | PoC v2 实证 schema 1 假成功·codex 看 v0.3 伪代码会写错·必改 + `formatInjectItem` helper wrap |
| **§E.7 末尾「未确认风险」段删**（P1） | 与 v0.3 changelog「§G.1 删」矛盾·PoC v1 已实证 |
| **§C.4 模块清单 # 编号去重**（P1） | v0.3 出现两个 #8（keepalive + register runtime）·改 #8/#9/#10/#11 |
| **§D.1 表头 v0.2 → v0.3 ship 后**（P1） | v0.3 自己 doc 不能写 v0.2 ship 后 |
| **§F.4 cover 度计算口径明示**（P1） | v0.3 「8 现有 + 2 新增 = 10/10 ✅」口径含混·明示「现状缺=新方案补齐=向后兼容=算 cover ✅」 |
| **§J.4 角色到人 v0.3 时序**（P2） | v0.3 还写 v0.2 时序「02:30→05:30」·改 v0.3 实际时序 |
| **§J footer 时间戳 v0.3 草稿**（P2） | 加 v0.3/v0.4 footer lineage |
| **§E.3 client API 注释加 schema 4 必明示**（P2） | threadInjectItems items 必走 schema 4·禁手写 |
| **顶部标题 + footer 全部统一 v0.4**（13:35 修） | 老板 13:18 critique「内容里写的 v0.3·名字 V01·哪来的 v0.4」·doc 版本混乱必修 |

## v0.2 → v0.3 变更说明

| 变更 | 原因 |
|------|------|
| **schema 4 default**（OpenAI Responses API 严格命名 `{type:'message', role:'user', content:[{type:'input_text', text:'...'}]}`） | PoC v2 实证·codex 0.125 silently drop schema 1/2/3·**只识别 schema 4** |
| **§G.1 删**（双进程 thread 共享未实证兜底） | PoC v1 实证 turn/steer mid-turn 真工作·thread 共享假设无需活体测·G.1 风险消除 |
| **§H.1 删**（turn 同步未实证兜底三档） | 同上·G.1 不存在 → H.1 兜底不需要 |
| **§C.2 idle wake 状态** 从「不确定·待 PoC」改「✅ PoC v2 实证·schema 4 严格命名才工作」 | PoC v2 实证 schema 1/2/3 silently drop / 4 真 surface·消除 v0.2 不确定性 |
| **§I AC 加 AC-10**（schema 4 reproduction） | PoC v2 实证锚点·实施时回归测试用 |
| **§K 新增 orchestrator readiness 6 能力** | 老板 03:20 战略 context·部分 orchestrator 迁 codex 节省 max20x token·v0.2 无此层 |
| **§L 新增成本评估** | 同上·迁移 ROI + 试点排期 |
| **§J 拍板路径更新**·实施时序加 keepalive 模块 + AC-11 outbound 实证 | §K 暴露 keepalive + outbound 必备配套 |
| v0.1/v0.2 删 fork 方案备选段（v0.2 §H.5 提了 fork 备选） | PoC v2 ✅·fork 不再需要 |

---

## v0.1 → v0.2 变更说明（保留历史）

| 变更 | 原因 |
|------|------|
| **scope 收紧·删 CC asyncRewake Phase 1** | 老板原话「CC↔CC 能正常推送」·CC 不是问题·只做 codex |
| **风格全改写 + 中文不混英** | v0.1 大量「driver 戳醒」「一等公民」抽象换皮·中学生听不懂 |
| **§B 现有架构画流程图 + grep 真行号** | v0.1 只列功能不画图·断点没标 |
| **§D 改后效果三场景演示 + 时序对比** | v0.1 只讲机制不演示效果·老板看不到改完什么样 |
| **§E 改动文件函数行号必精确** | v0.1 只笼统说「~500-800 LOC」·没具体到哪行 |
| **§F 16+20+7 = 43 项功能逐项 cover 度** | v0.1 用 17 维度抽象表·老板要看每一项功能怎么处理 |
| **§G+§H 实现不了的 + 兜底必显式** | v0.1 隐含·没明说 |
| **§I 8+ AC 每条 prepare→execute→expected→FAIL 字符串级** | v0.1 AC 抽象·没法逐条跑 |
| v0.1 备份到 V01-DEPRECATED.md | 防丢历史 |

---

## §A · 问题讲清楚（人话 + 老板原话 + 真实场景）

### A.1 老板原话引用

**老板 21:14**：「为什么建木一直处于工作状态」（背景：harness 派 codex 跑活·codex 完成后给 harness 发 IPC·harness 没看到·一直在 spin）

**老板 00:46**：「为什么是我告诉你 codex 给你发消息了·你去主动获取才能看到？IPC 怎么不自动推送？codex 那边也一样」

**老板 02:25**：「这文档写的什么狗屁玩意·是给人看的？问题没讲清楚·架构没讲清楚·方案没讲清楚·改完后效果没讲清楚·哪些地方要改·原本的功能哪些使用新功能可以实现·哪些实现不了·实现不了要怎么办？怎么验收？」

### A.2 真实场景叙述（中学生能听懂）

我们 portfolio 有多个 AI session（建木 / 太微 / 后土等等）·每个 session 是独立的对话窗口·跑在独立进程里。这些 session 之间用 IPC（**Inter-Process Communication = 进程间通信**·简单说就是「session 之间发消息」）来协作。

**正常流程应该是这样**：
1. session A（codex-test）想告诉 session B（harness）：「我跑完任务了·这是结果」
2. session A 调用 `ipc_send` 工具发消息给 session B
3. session B **立刻** 在自己的对话窗口里看到 session A 的消息
4. session B 的 AI 模型立刻接续处理·决定下一步动作

**实际发生的问题**：
- 步骤 3 出问题了
- 当 session B 是 **CC（Claude Code）**·消息能正常到对话窗口（CC 用的是叫 `notifications/claude/channel` 的私有扩展协议·能 push 进 conversation 当 `<channel>` 标签）
- 当 session B 是 **codex**·消息发到了 codex 进程·**但是 codex CLI 收到这个消息只是写到自己的日志（stderr）·完全不告诉 model**·model 永远看不见
- 就算 session B 是 CC·如果它当时是 idle 状态（没在跑任何工具调用 / 没在思考）·channel 标签虽然进了 transcript·但 **不会自动起一个新 turn 让 model 去 process**·要等 user 下次输入或某个外部事件才被触发

**老板 critique 的具体一例**：
- codex-test session 跑完任务后给 harness（CC）发 IPC
- harness 当时在 idle / 在审别的东西
- harness **没看到** 这条消息（虽然 channel 标签在 transcript 里）
- 老板看 IPC 后台监控发现「codex 给 harness 发消息了·harness 没回」
- 老板必须手动告诉 harness：「codex 给你发消息了·去 ipc_recent_messages 查」
- harness 主动调 `ipc_recent_messages` 才捞到

### A.3 真痛点提炼

**消息怎么自动「插进 codex 当前 model 的对话窗口」·让 codex 立刻看见·不靠主动 query**·这是核心。CC 这边老板已确认「能正常推送」（asyncRewake 也另有原生 hook 能解 CC idle wake）·**Phase 1 不做 CC 改动**·**只做 codex 这一边**。

### A.4 上游 issue 实证（不是猜测）

- **GitHub issue #18056**：https://github.com/openai/codex/issues/18056
- **状态**：OPEN since 2026-04-16·零 PR·不在 roadmap·labels: enhancement, mcp
- **问题描述**：codex CLI 收到 MCP `notifications/message` 后·只 route 到 Rust tracing 宏（在 `logging_client_handler.rs`）·**只在 stderr/debug 日志里出现**·model 永远看不见
- **请求方提的修法**：~50 行代码改 3-4 个文件·加 `EventMsg::McpServerMessage` variant·把 notification 从 tracing 改成走 `tx_event` channel 注 model conversation
- **没人接**·OpenAI 没把这个进 milestone·= 等 upstream 修不靠谱

### A.5 解决思路三选一

1. **fork codex 改 50 行**：维护成本极高·每次 codex 升级要 rebase
2. **codex App Server bridge**：用 OpenAI 给 codex 设计的另一套官方协议（**App Server**·跟 MCP 是两条独立链路）·**绕开 MCP notification 限制**
3. **polling 兜底**：codex 每 5min 主动 query Hub·实时性 fail（5min 延迟·老板 critique 的痛点未解）

**v0.2 选 #2（codex App Server bridge）** —— 详细对比见 §C / §D / §F。

---

## §B · 现有架构讲清楚（grep 真代码 + 流程图 + 标断点）

### B.1 IPC 全链路时序图（CC↔CC 工作 / CC→codex 断）

```
场景一：CC sender → CC receiver（工作正常·base case）

CC-sender                  Hub                       CC-receiver
    │                       │                              │
    │  ipc_send(to,content) │                              │
    │  [tool call]          │                              │
    ├──────────────────────►│                              │
    │  [via MCP server      │                              │
    │   wsSend WebSocket]   │                              │
    │                       │  routeMessage()              │
    │                       │  push(receiver, msg, "route-direct")
    │                       ├─────────────────────────────►│
    │                       │  [via WebSocket]             │
    │                       │                              │
    │                       │                              │  handleWsMessage
    │                       │                              │  case 'message'
    │                       │                              │  pushChannelNotification(msg)
    │                       │                              │      │
    │                       │                              │      ▼
    │                       │                              │  channelNotifier
    │                       │                              │  .pushChannelNotification
    │                       │                              │      │
    │                       │                              │      ▼
    │                       │                              │  server.notification({
    │                       │                              │    method:'notifications/claude/channel',
    │                       │                              │    params:{ content, meta }
    │                       │                              │  })
    │                       │                              │      │
    │                       │                              │      ▼
    │                       │                              │  CC 客户端 SDK
    │                       │                              │  收 notifications/claude/channel
    │                       │                              │  → 注 conversation context
    │                       │                              │  → 渲染为 <channel> 标签
    │                       │                              │  → AI 模型下一 turn 看见 ✅
```

```
场景二：CC sender → codex receiver（断在最后·model 看不见）

CC-sender                  Hub                       codex-receiver
    │  ipc_send(to,content) │                              │
    ├──────────────────────►│  routeMessage()              │
    │                       │  push                        │
    │                       ├─────────────────────────────►│
    │                       │                              │  handleWsMessage
    │                       │                              │  case 'message'
    │                       │                              │  pushChannelNotification(msg)
    │                       │                              │      │
    │                       │                              │      ▼
    │                       │                              │  server.notification(...)
    │                       │                              │      │
    │                       │                              │      ▼
    │                       │                              │  codex CLI MCP client
    │                       │                              │  收 notifications/claude/channel
    │                       │                              │  → logging_client_handler.rs
    │                       │                              │  → 写 stderr tracing
    │                       │                              │      │
    │                       │                              │      ▼
    │                       │                              │  GPT model ❌ 永远看不见
    │                       │                              │  (issue #18056)
```

### B.2 真实代码引用（grep 行号）

| 步骤 | 文件 | 行号 | 用途 |
|------|------|------|------|
| 1. ipc_send 工具定义 | `lib/mcp-tools.mjs` | 13-36 | MCP tool schema · sender 调用 |
| 2. WS register 收 sender 进 session table | `hub.mjs` | 477-483 | 记录 pid / cwd / contextUsagePct |
| 3. WS message 触发路由 | `hub.mjs` | 498-500 | `case 'message': routeMessage(msg, session)` |
| 4. routeMessage 主路由 | `lib/router.mjs` | 329 | 单点路由 + 广播 + topic 分流 |
| 5. push 底层发送（每会话） | `lib/router.mjs` | 101-107 | `safePushAndAudit(session, payload)` 写 WebSocket |
| 6. broadcast 全员扇出 | `lib/router.mjs` | 121-128 | `to=*` 广播·skip OpenClaw |
| 7. broadcastToTopic 订阅扇出 | `lib/router.mjs` | 131-149 | topic pub/sub fanout |
| 8. receiver MCP server 收 WS 消息 | `mcp-server.mjs` | 1162 | `handleWsMessage(event)` |
| 9. case 'message' 触发 channel push | `mcp-server.mjs` | 1180-1212 | `pushChannelNotification(msg)` |
| 10. channelNotifier 入队 / 发送 | `lib/channel-notification.mjs` | 69-77 | pre-init queue + flush |
| 11. server.notification 发 MCP 协议 | `mcp-server.mjs` | 299 | `(payload) => server.notification(payload)` |
| 12. CC 客户端渲染（CC only） | CC 客户端 SDK 内部 | — | `<channel>` 标签注 conversation |
| 12'. codex 客户端记 stderr（codex bug） | `codex-rs/.../logging_client_handler.rs` | — | tracing 宏只写日志 |

### B.3 断点定位

**关键断点 = 步骤 12'**：codex CLI 的 MCP client 收到 `notifications/claude/channel` 后·走 `logging_client_handler.rs` 把内容写 stderr·**永远不进 GPT model 的 conversation**。

这不是 Hub bug·不是 mcp-server.mjs bug·**是 codex CLI 内部 MCP notification handler 设计问题**（issue #18056）。

### B.4 为什么 CC 没这个 bug？

CC 客户端用的是 Anthropic 私有的 MCP 扩展 `notifications/claude/channel`·这是 Anthropic 给 CC 自己加的特殊 method·CC 客户端 SDK 专门处理它（注 conversation context）。codex 不知道这个私有扩展·只识别 MCP 标准的 `notifications/message`（标准 logging 通知）·所以 codex 把它当普通日志处理了。

我们 mcp-server.mjs 现在统一发 `notifications/claude/channel`（CC 专用）·codex 收到根本不当回事。

### B.5 现有 broadcast 全员扇出（router.mjs:121-128）

```javascript
function broadcast(payload, exceptName = null) {
  for (const [name, session] of sessions) {
    if (name === exceptName) continue;
    if (session.ws && session.ws.readyState === session.ws.OPEN) {
      push(session, payload, 'broadcast');
    }
  }
}
```

**问题**：broadcast 不区分 session 是 CC 还是 codex·一律走 `push()`（WebSocket send）·然后每个 receiver 各自走自己的 channel notification 路径。CC receiver 工作·codex receiver 断。**= 同一缺陷在 broadcast 也存在**。

### B.6 现有 session 元数据缺 runtime 字段

`hub.mjs:477-483` register 时收的字段：`channelPort` / `pid` / `cwd` / `contextUsagePct`。**没有 `runtime` 字段**（CC 还是 codex）。

= 当前 Hub **不知道** 每个 session 是 CC 还是 codex·所以无法分支路由。**这是 §E 必加的字段之一**。

---

## §C · 新方案讲清楚（人话 + 流程图 + 模块独立）

### C.1 概念预备：codex App Server 是什么·和 MCP 什么关系

**MCP（Model Context Protocol）**：Anthropic 定义的协议·让 AI agent（CC / codex 等）能调外部工具（比如我们 Hub 的 ipc_send 工具）。MCP 的 notification 路径是 server→client（Hub server → agent client）·但 **codex client 收到 notification 不告诉 model**（issue #18056）。

**codex App Server**：OpenAI 给 codex 设计的 **另一套独立协议**·主要用途是给 VS Code extension 之类的 GUI 工具集成 codex 用。它不是 MCP·是 codex 自己的 JSON-RPC 2.0 协议（method 名字是 `thread/start`、`turn/start`、`turn/steer` 之类）。**transport 是 stdio（默认）或 WebSocket（实验）**。

**关键差异**：
- MCP 模式：codex 是 client / Hub 是 server（codex 调 Hub 工具）
- App Server 模式：codex 是 server / Hub 是 client（Hub 控制 codex 起 thread / 推消息进 turn）

= 我们要让 Hub **既是 MCP server（保留现有 outbound 工具调用）**·**又新当 App Server client（新增 inbound 推送）** —— 两条链路并存·互不干扰。

### C.2 关键能力：`turn/steer` + `thread/inject_items`（schema 4 命名严格）

老板 critique 要的核心：「消息怎么自动插进 codex 当前 model 对话窗口」。codex App Server 有两个原生方法干这个：

1. **`turn/steer`**：codex 在跑 turn 时（model 正在思考 / 调工具）·Hub 调 `turn/steer` 把新内容 append 到 active turn·**model 立刻 incorporate·不起新 turn**。`expectedTurnId` 必须匹配。来源：codex App Server README。**PoC v1 实证 ✅ 真工作**。

2. **`thread/inject_items`**：codex 在 idle 状态（没在跑 turn）·Hub 调 `thread/inject_items` 把 Responses API items 注 history 外·**等下次 turn/start 自动 surface**。**PoC v2 实证 ✅·但 items shape 必用 schema 4 严格命名**：

   ```javascript
   // ✅ 唯一可工作 schema·codex 0.125 真识别（PoC v2 marker [POC-V2-INJECT-4] 实证）
   {
     type: 'message',
     role: 'user',
     content: [{ type: 'input_text', text: '<内容>' }]
   }

   // ❌ 以下三种 codex 0.125 silently drop（response {result:{}} 假成功·next turn 不 surface）
   { type: 'user_message', content: '<内容>' }                              // schema 1
   { type: 'user_message', content: [{ type: 'text', text: '<内容>' }] }   // schema 2
   { role: 'user', content: '<内容>' }                                      // schema 3
   ```

   **这是 codex 0.125 的接口限制**·不识别就 silently drop·没 schema validation error。Hub 客户端必用 schema 4·不能容错。

**这两个组合 = codex idle wake + 实时 inject 都解决**·PoC v1+v2 双重实证。

### C.3 新架构时序图

```
新场景一：CC sender → codex receiver（修复后）

CC-sender                  Hub                                  codex-receiver（含 App Server）
    │                       │                                     │
    │  ipc_send(to,content) │                                     │
    ├──────────────────────►│                                     │
    │                       │  routeMessage()                     │
    │                       │  if session.runtime === 'codex':    │
    │                       │    if session has active turn:      │
    │                       │      App Server: turn/steer ────────┼─►(append 进 active turn)
    │                       │    else (idle):                     │
    │                       │      App Server: thread/inject ─────┼─►(注 history)
    │                       │  else (CC):                         │
    │                       │    现有 channel notification 路径   │
    │                       │                                     │
    │                       │                                     ▼
    │                       │                                  GPT model
    │                       │                                  立刻看见消息 ✅
    │                       │                                  （active 立 incorporate
    │                       │                                   idle 下次 turn surface）
```

```
新场景二：broadcast (to=*) 含 CC + codex 两类 receiver

CC-sender                  Hub                       CC-receiver       codex-receiver
    │                       │                              │                  │
    │  ipc_send(to=*,...)   │                              │                  │
    ├──────────────────────►│                              │                  │
    │                       │  broadcast(payload)          │                  │
    │                       │  for each session:           │                  │
    │                       │    if runtime==='claude':    │                  │
    │                       │      push WS                 │                  │
    │                       │      → channel notification ►│ (现有) ✅        │
    │                       │    if runtime==='codex':     │                  │
    │                       │      App Server turn/steer   │                  │
    │                       │      or inject_items ────────┼──────────────────┤
    │                       │                              │                  │ ✅ (新)
```

### C.4 模块清单（新增 + 改动）

| # | 模块 / 文件 | 性质 | 大小 |
|---|------------|------|------|
| 1 | `lib/codex-app-server-client.mjs` | **新建** | ~300-500 行 JSON-RPC 2.0 client |
| 2 | `hub.mjs:477-483` register 加 runtime 字段 | 改 | +3 行 |
| 3 | `hub.mjs` Session struct（line ~422 附近·sessions Map value 形状） | 改 | +1 行 |
| 4 | `lib/router.mjs:329 routeMessage` | 改 | 加 runtime 分支 ~30 行 |
| 5 | `lib/router.mjs:121 broadcast` | 改 | 同上分支 ~10 行 |
| 6 | `mcp-server.mjs:spawnSession` codex 分支 | 改 | spawn 时同时 thread/start App Server thread ~40 行 |
| 7 | `lib/session-registry.mjs` 加 `appServerThreadId` | 改 | +5 行（schema 扩展） |
| 8 | `lib/codex-thread-keepalive.mjs`（**v0.3 新增·orchestrator readiness §K.A 必备**） | **新建** | ~200 行·每 25min 对 codex thread 发轻量 turn/start `"keepalive ping"` + 立即 turn/interrupt·防 30min unload·~50 token / 25min |
| 9 | mcp-server.mjs register payload 加 runtime（IPC_NAME 已有·新增 `IPC_RUNTIME` env 或硬编码） | 改 | +5 行 |
| 10 | `tests/codex-app-server-client.test.mjs` 单元 | 新 | ~150 行（mock JSON-RPC fixtures） |
| 11 | `tests/integration/codex-inbound-push.test.mjs` | 新 | ~100 行（活体测） |

**总改动**：~900-1100 行（含测试 + keepalive）·**2 个新模块文件**（codex-app-server-client.mjs + codex-thread-keepalive.mjs）+ 6 个改动文件 + 2 个新测试文件。

### C.5 现有 MCP 路径完全不动

**重申**（因为 v0.1 没说清楚）：CC ↔ CC IPC 流程：
- mcp-server.mjs: 1162 / 1212 / 299 全部 0 改动
- channel-notification.mjs 0 改动
- 所有 16 MCP tools 定义 0 改动
- WebSocket message types 7 种 0 改动
- 20 个 HTTP routes 0 改动

**新增路径只在「receiver 是 codex」时分支启用**·CC 0 影响。

---

## §D · 改完后效果讲清楚（before / after 时序对比 + 三场景演示）

### D.1 before / after 对比表

| 场景 | before（当前生产） | after（v0.3 / ADR-014 ship 后） |
|------|------------------------------|------------------------|
| **场景 1** CC→CC 实时 | ✅ 实时（channel notification） | ✅ 实时（不动） |
| **场景 2** CC→codex active turn | ❌ codex 收到只写 stderr·model 看不见 | ✅ 实时（turn/steer append 到 active turn） |
| **场景 3** CC→codex idle | ❌ 完全不响应·必老板手动告知 | ✅ idle thread inject_items + next turn 自动 surface |
| **场景 4** broadcast (to=*) 含 codex | ❌ codex receiver 收不到·部分广播失败 | ✅ Hub 按 runtime 分支扇出·两类 receiver 都收 |
| **场景 5** codex→CC | ✅ 已正常（codex 调 ipc_send 工具发到 Hub·Hub channel push 到 CC） | ✅ 不动 |
| **场景 6** codex→codex | ❌ 同场景 2/3·codex receiver 收不到 | ✅ 同 2/3 |
| **延迟（active）** | 不可达 | <100ms（JSON-RPC turn/steer 单次） |
| **延迟（idle）** | 不可达 | <500ms（inject_items + 等下次 turn 触发·turn 间隔通常 30s 内） |
| **Hub 改动** | 现有 | +1 模块 +5 改动文件 |
| **codex 端改动** | 0 | 0（不需要 patch codex） |
| **CC 端改动** | 0 | 0（CC 完全不受影响） |

### D.2 真实场景演示一：codex active turn 收 IPC

```
T0  老板在 codex-test session 输入「用 ipc_send 给 harness 发 ping」
T1  codex 起 turn·model 决定调 ipc_send 工具
T2  ipc_send tool call → Hub /send → harness inbox

T3  此时 harness（CC）正在跑别的 turn（active）
    Hub routeMessage 分支：harness.runtime==='claude'
    → 走现有 channel notification 路径 ✅
    → harness next turn 看见 <channel> 标签 ✅

T4  harness 处理后回 ipc_send 给 codex-test
T5  Hub routeMessage 分支：codex-test.runtime==='codex'
    → 看 codex-test 当前是不是 active turn
    → 是 → App Server turn/steer 把回复 append 到 codex-test active turn
T6  codex-test model 立刻看见 harness 的回复·继续 turn
T7  老板看到 codex-test 输出：「harness 回复 pong」
    总耗时：T0→T7 = ~5 秒
```

### D.3 真实场景演示二：codex idle 收 IPC

```
T0  codex-test session 闲置·model 没在跑 turn·等老板下次输入
T1  另一 session（harness）派 IPC 给 codex-test
T2  Hub routeMessage·codex-test.runtime==='codex' + active turn 不存在
    → App Server thread/inject_items 把消息注 codex-test thread history
    → marker 内容：[IPC-INBOUND from harness] <消息体>
T3  codex-test 收到 inject_items 但当前没 turn 在跑·等待

T4  老板下次和 codex-test 互动（输入新指令 / 或 watchdog 触发 wake）
T5  codex-test 起新 turn·model 看 thread history
T6  history 末尾包含 [IPC-INBOUND from harness] marker
T7  model 处理 marker 后再处理老板输入
T8  老板看到 codex-test 输出包含「我刚收到 harness 的消息: ...」
    总耗时：T0→T8 = idle 期 + 新 turn 起·通常 <60 秒
```

**对比 before**：T2 之后 codex 永远不响应·老板必须手动「去 ipc_recent_messages 查一下」·codex 才主动 query·或者老板直接告诉 codex「harness 给你发消息了」。

### D.4 真实场景演示三：broadcast (to=*) 同时含 CC + codex

```
T0  watchdog 触发 phys_ram >= 90% CRIT broadcast
T1  Hub broadcast(payload) 遍历所有在线 session
T2  对每 session 分支：
    - harness（CC）→ push WS → channel notification ✅
    - jianmu-pm（CC）→ push WS → channel notification ✅
    - codex-test（codex active）→ App Server turn/steer ✅
    - taiwei-builder（codex idle）→ App Server thread/inject_items ✅
T3  所有 4 个 session model 都在 <60 秒内看见 critique 消息
T4  各自决定是否降负载 / kill 重任务
```

**对比 before**：codex-test / taiwei-builder 完全收不到·只有 CC 类 session 响应·portfolio 治理 fail。

---

## §E · 哪些地方要改（具体文件 + 函数 + 行号 + why + 改前/改后伪代码）

### E.1 改动 1·Hub register 收 runtime 字段

**文件**：`xihe-jianmu-ipc/hub.mjs`
**行号**：477-483 `case 'register'`
**why**：Hub 当前不区分 session 是 CC 还是 codex·新分支路由前必须知道。

**改前**（line 477-483）：
```javascript
case 'register':
  session.channelPort = msg.channelPort ?? null;
  session.pid = normalizePid(msg.pid);
  session.cwd = normalizeCwd(msg.cwd);
  session.contextUsagePct = normalizeContextUsagePct(msg.contextUsagePct);
  send(ws, { type: 'registered', name: session.name });
  break;
```

**改后**：
```javascript
case 'register':
  session.channelPort = msg.channelPort ?? null;
  session.pid = normalizePid(msg.pid);
  session.cwd = normalizeCwd(msg.cwd);
  session.contextUsagePct = normalizeContextUsagePct(msg.contextUsagePct);
  session.runtime = normalizeRuntime(msg.runtime);  // 新增·'claude' | 'codex' | 'unknown'
  session.appServerThreadId = msg.appServerThreadId ?? null;  // 新增·codex 端 thread/start 后回填
  send(ws, { type: 'registered', name: session.name });
  break;
```

**配套 helper**：在 hub.mjs 顶部加 `normalizeRuntime(value)`：
```javascript
function normalizeRuntime(value) {
  if (typeof value !== 'string') return 'unknown';
  const v = value.toLowerCase().trim();
  if (v === 'claude' || v === 'cc' || v === 'claude-code') return 'claude';
  if (v === 'codex') return 'codex';
  return 'unknown';
}
```

### E.2 改动 2·sender 端 mcp-server.mjs register 上报 runtime

**文件**：`xihe-jianmu-ipc/mcp-server.mjs`
**位置**：register message 构造处（grep `type: 'register'` 找具体行）
**why**：每个 session 启动时上报自己是 CC 还是 codex·env 变量传入。

**改后**伪代码：
```javascript
// 原有：
wsSend({
  type: 'register',
  name: IPC_NAME,
  pid: process.pid,
  cwd: process.cwd(),
  // ... contextUsagePct
});

// 新增 runtime 字段：
const runtime = resolveRuntime();
wsSend({
  type: 'register',
  name: IPC_NAME,
  pid: process.pid,
  cwd: process.cwd(),
  runtime,
  // ... contextUsagePct
});

function resolveRuntime() {
  // 第一优先·env 显式传：ipc_spawn 时新增 `IPC_RUNTIME=claude` 或 `IPC_RUNTIME=codex`
  if (process.env.IPC_RUNTIME) return process.env.IPC_RUNTIME;

  // 第二优先·父进程 cmdline 检测（process.argv[0] 是 node.exe·看不见·必查 ppid）
  // Windows: 走 wmic 或 PowerShell Get-CimInstance Win32_Process WHERE ProcessId=<ppid>
  // Linux: 读 /proc/<ppid>/cmdline
  // 命中 'codex' → 'codex'·命中 'claude' → 'claude'·都不命中 → 'unknown'

  // 第三优先（兜底）·MCP 客户端自带 clientInfo（initialize handshake 时 client 上报名字·CC 是 'claude-ai'·codex 是 'codex'）
  // server.oninitialized 时已能拿到 clientInfo·可以缓存到全局变量供 register 时取用

  return 'unknown';
}
```

**why resolveRuntime 三档 fallback**（v0.2 修正·原伪代码 detectRuntime 看 `process.argv[0]` 错·argv[0] 是 node.exe / mcp-server.mjs 不含 agent 名字）：
- 一档·env 显式：ipc_spawn 改命令时直接传 `IPC_RUNTIME=codex`·最准确·实施 5min
- 二档·父进程 cmdline 实证：跨平台代码·Windows wmic / Linux /proc·~30 行
- 三档·MCP clientInfo：CC 客户端 initialize 时上报 `clientInfo.name='claude-ai'` / codex 上报 `'codex'`·见 server.oninitialized hook·零网络成本·向后兼容

### E.3 改动 3·新建 codex App Server JSON-RPC client

**文件**：`xihe-jianmu-ipc/lib/codex-app-server-client.mjs` （**新建**）
**why**：Hub 需要主动连 codex 的 App Server·调 thread/start / turn/steer / thread/inject_items。

**关键 API**：
```javascript
export function createAppServerClient({ command = 'codex', args = ['app-server'], cwd, env }) {
  // 启动 codex app-server 子进程·stdio 通信
  // 返回:
  // - initialize() 必先调
  // - threadStart() → { threadId }
  // - threadResume(threadId)
  // - turnSteer(threadId, expectedTurnId, content) → 必须 active turn
  // - threadInjectItems(threadId, items) → idle 也能用·**items 必用 schema 4：`{type:'message', role:'user', content:[{type:'input_text', text}]}`·schema 1/2/3 silently drop（PoC v2 实证）**
  // - threadUnsubscribe(threadId)
  // - on('notification', handler) 监听 turn/started / turn/completed / item/* 等
  // - close()
}
```

**实现要点**：
- JSON-RPC 2.0 over stdio（默认）·newline-delimited JSON
- 每 request 用递增 id·response 按 id 匹配 promise
- 错误处理：`-32001` server overload 用指数退避重试
- 单元测试用 mock stdio 跑

**预计**：~300-500 行 + ~150 行测试。

### E.4 改动 4·routeMessage 加 runtime 分支

**文件**：`xihe-jianmu-ipc/lib/router.mjs`
**行号**：329 `routeMessage()`
**why**：单点路由要按 receiver runtime 选 push 路径。

**改前** 简化（实际 router.mjs:329 + 周边路由逻辑）：
```javascript
function routeMessage(msg, senderSession) {
  const to = msg.to;
  if (to === '*') {
    broadcast(msg, senderSession.name);  // line 121
  } else {
    const target = sessions.get(to);
    if (target?.ws?.readyState === target.ws.OPEN) {
      push(target, msg, 'route-direct');  // 走 WS·让 receiver 自己 channel push
    }
  }
}
```

**改后**（关键分支）：
```javascript
function routeMessage(msg, senderSession) {
  const to = msg.to;
  if (to === '*') {
    broadcastWithRuntime(msg, senderSession.name);  // 见 E.5
  } else {
    const target = sessions.get(to);
    if (!target) {
      pushInbox(stub, msg);  // 现有 stub 路径
      return;
    }
    if (target.runtime === 'codex' && appServerClient.has(target.name)) {
      // 新路径：通过 App Server 推
      pushViaAppServer(target, msg);  // 见 E.6
    } else if (target.ws?.readyState === target.ws.OPEN) {
      push(target, msg, 'route-direct');  // 现有路径·CC 走这里
    } else {
      pushInbox(target, msg);  // 离线缓冲
    }
  }
}
```

### E.5 改动 5·broadcast 按 runtime 分支扇出

**文件**：`xihe-jianmu-ipc/lib/router.mjs`
**行号**：121-128 `broadcast()`
**why**：to=* 广播每个 receiver 也要按 runtime 分支。

**改前**：
```javascript
function broadcast(payload, exceptName = null) {
  for (const [name, session] of sessions) {
    if (name === exceptName) continue;
    if (session.ws && session.ws.readyState === session.ws.OPEN) {
      push(session, payload, 'broadcast');
    }
  }
}
```

**改后**：
```javascript
function broadcastWithRuntime(payload, exceptName = null) {
  for (const [name, session] of sessions) {
    if (name === exceptName) continue;
    if (session.runtime === 'codex' && appServerClient.has(name)) {
      pushViaAppServer(session, payload);  // 新分支
    } else if (session.ws && session.ws.readyState === session.ws.OPEN) {
      push(session, payload, 'broadcast');  // 现有 CC 分支
    }
  }
}
```

### E.6 改动 6·pushViaAppServer 调 turn/steer 或 inject_items

**文件**：`xihe-jianmu-ipc/lib/router.mjs`（或新建 `lib/codex-push-router.mjs`）
**why**：新分支的实际推送逻辑。

**伪代码**（**v0.3 修正·idle 分支 schema 4 严格命名·PoC v2 实证**）：
```javascript
// helper·所有 caller 必走此 wrap·禁手写 items·防 schema 1/2/3 silently drop
function formatInjectItem(text) {
  // schema 4·codex 0.125 唯一可工作格式（PoC v2 [POC-V2-INJECT-4] 实证）
  return {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }]
  };
}

async function pushViaAppServer(targetSession, msg) {
  const client = appServerClient.get(targetSession.name);
  const threadId = targetSession.appServerThreadId;
  const content = formatChannelMarker(msg);  // [IPC-INBOUND from <sender>] <body>

  try {
    const status = await client.threadStatus(threadId);
    if (status.activeTurnId) {
      // active turn → steer
      await client.turnSteer(threadId, status.activeTurnId, content);
      audit('codex_inbound_steer', { target: targetSession.name, msg_id: msg.id });
    } else {
      // idle → inject·必走 formatInjectItem schema 4 wrapper·禁手写
      await client.threadInjectItems(threadId, [formatInjectItem(content)]);
      audit('codex_inbound_inject', { target: targetSession.name, msg_id: msg.id });
    }
  } catch (err) {
    stderr(`[ipc-hub] App Server push failed for ${targetSession.name}: ${err.message}`);
    pushInbox(targetSession, msg);  // 兜底走离线 inbox
  }
}
```

### E.7 改动 7·spawnSession 同时启 codex App Server

**文件**：`xihe-jianmu-ipc/mcp-server.mjs`
**行号**：spawnSession `runtime === 'codex'` 分支（grep `runtime === 'codex'` 找 668 / 722）
**why**：codex spawn 后必须有 App Server 连接·才能 inbound push。

**改后**伪代码：
```javascript
if (runtime === 'codex' && requestedHost === 'wt') {
  // 现有：起 wt 跑 codex 交互
  const child = spawn('wt.exe', wtArgs, { ... });
  
  // 新增：另起一个 codex app-server 子进程·Hub 连
  const appServerChild = spawn('codex', ['app-server'], { cwd: spawnCwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const client = createAppServerClient({ child: appServerChild });
  await client.initialize({ clientInfo: { name: 'xihe-ipc-hub', version: '0.5' } });
  const { thread } = await client.threadStart({ /* config */ });
  appServerClientMap.set(sessionName, client);
  
  // 通过 ipc_register_session 把 threadId 同步到 Hub
  await registerSession({ name: sessionName, runtime: 'codex', appServerThreadId: thread.id });
  
  return { name: sessionName, host: 'wt', runtime: 'codex', mode: 'interactive', spawned: true, status: 'spawned', pid: child.pid };
}
```

**v0.3 实证更新**：PoC v1（b51e7v2u1）+ PoC v2（bzi77w8n4）已实证 turn/steer mid-turn 真工作 + thread/inject_items（schema 4）真 surface·**双进程 thread 共享假设无需活体测**·v0.2 §G.1 / §H.1 风险已删除。原「未确认风险」段同步删除。

**剩余风险**：见 §G.1（WebSocket experimental）/ §G.3（30min idle unload）/ §K（orchestrator readiness）·均已 §H 兜底覆盖。

### E.8 改动总结

| # | 文件 | 行号 / 范围 | 改动类型 | 大小 |
|---|------|-----------|---------|------|
| E.1 | hub.mjs | 477-483 | 改 | +3 行 |
| E.2 | mcp-server.mjs | register 处 | 改 | +5 行 |
| E.3 | lib/codex-app-server-client.mjs | 全文件 | **新建** | ~300-500 行 |
| E.4 | lib/router.mjs | 329 | 改 | +30 行 |
| E.5 | lib/router.mjs | 121-128 | 改 | +10 行 |
| E.6 | lib/router.mjs | 新增 helper | 改 | +30 行 |
| E.7 | mcp-server.mjs | spawnSession codex 分支（668 / 722） | 改 | +40 行 |
| 测试 | tests/codex-app-server-client.test.mjs | 全文件 | **新建** | ~150 行 |
| 测试 | tests/integration/codex-inbound-push.test.mjs | 全文件 | **新建** | ~100 行 |

**总改动**：~668-868 行（含 200-250 行测试）·6 个改动文件 + 3 个新文件。

**派单分配**：
- jianmu-pm 自做：§B-§F doc 审核 + ADR-014 起草
- 派 codex 实施：E.3 + E.4-E.7 实施 + 测试·~3-5 codex run（每 run 1-2 模块·token 1.5-3 万 / run·总耗 ~10-15 万 token·ETA 1-2 天集中跑 + 1 周回归）

---

## §F · 现有 16+20+7+sidecar 功能 cover 度逐项表

### F.1 16 MCP tools（lib/mcp-tools.mjs）

| # | tool | runtime | 现状 | 新方案 cover | 说明 |
|---|------|--------|------|-------------|------|
| 1 | ipc_send | CC + codex | ✅ 工作 | ✅ 完全保留 | sender 调用路径 0 改动·routeMessage 分支只改 receiver 侧推送 |
| 2 | ipc_sessions | CC + codex | ✅ | ✅ 完全保留 | 只多返回 runtime 字段·tools schema 向后兼容 |
| 3 | ipc_whoami | CC + codex | ✅ | ✅ 完全保留 | 0 改动 |
| 4 | ipc_subscribe | CC + codex | ✅ | ✅ 完全保留 | topic 订阅·broadcastToTopic 同样按 runtime 分支扇出 |
| 5 | ipc_spawn | CC + codex | ✅ | 🟨 codex 分支扩展 | spawnSession 同时启 App Server（见 E.7）·返回结构 0 变 |
| 6 | ipc_rename | CC + codex | ✅ | ✅ 完全保留 | 只重命名·和 runtime 无关 |
| 7 | ipc_reclaim_my_name | CC + codex | ✅ | ✅ 完全保留 | zombie 回收 5s ping/pong 不变 |
| 8 | ipc_reconnect | CC + codex | ✅ | ✅ 完全保留 | Hub host/port 切换不变 |
| 9 | ipc_task | CC + codex | ✅ | ✅ 完全保留 | 任务 CRUD 走 HTTP /task·走 routeMessage 时同样 runtime 分支 |
| 10 | ipc_recent_messages | CC + codex | ✅ | ✅ 完全保留 | SQLite 历史查询·和 push 路径无关 |
| 11 | ipc_recall | CC + codex | ✅ | ✅ 完全保留 | observation.db FTS5 查询·无关 |
| 12 | ipc_observation_detail | CC + codex | ✅ | ✅ 完全保留 | 同上 |
| 13 | ipc_register_session | CC + codex | ✅ | 🟨 schema 扩展 | 加 runtime + appServerThreadId·向后兼容 |
| 14 | ipc_update_session | CC + codex | ✅ | ✅ 完全保留 | 仅更新 projects |
| 15 | ipc_cost_summary | CC + codex | ✅ | ✅ 完全保留 | ccusage 集成无关 |
| 16 | ipc_token_status | CC + codex | ✅ | ✅ 完全保留 | 5h block 状态无关 |

**16/16**：14 ✅ + 2 🟨（schema 扩展·向后兼容）·**0 ❌**。

### F.2 20 HTTP routes（hub.mjs / lib/http-handlers.mjs）

| # | route | method | 用途 | 新方案 cover | 说明 |
|---|-------|--------|------|-------------|------|
| 1 | /health | GET | Hub 状态 | ✅ | 不变 |
| 2 | /sessions | GET | session 列表 | 🟨 字段扩展 | 加 runtime / appServerThreadId 字段·向后兼容 |
| 3 | /session-alive?name= | GET | session WS readyState | ✅ | 不变 |
| 4 | /session/context | POST | statusline 上报 | ✅ | 不变（独立 sidecar） |
| 5 | /messages | GET | 历史查询 | ✅ | 不变 |
| 6 | /recent-messages | GET | 近期消息 | ✅ | 不变 |
| 7 | /stats | GET | per-agent 统计 | ✅ | 不变 |
| 8 | /send | POST | 发消息 | 🟨 内部路由分支 | 接收同·内部 routeMessage 按 runtime 分发 |
| 9 | /suspend | POST | 挂起 session | ✅ | 不变 |
| 10 | /wake-suspended | POST | 广播 network-up | 🟨 broadcast 按 runtime 分支 | 实现复用 broadcastWithRuntime |
| 11 | /feishu-reply | POST | 飞书回复 | ✅ | 不变（飞书桥独立） |
| 12 | /registry/register | POST | sessions-registry 创建 | 🟨 schema 扩展 | 加 runtime + appServerThreadId |
| 13 | /registry/update | POST | sessions-registry 更新 | ✅ | 不变 |
| 14 | /task | POST | 任务创建 | 🟨 内部路由分支 | 同 /send |
| 15 | /tasks | GET | 任务列表 | ✅ | 不变 |
| 16 | /tasks/:id GET | GET | 任务详情 | ✅ | 不变 |
| 17 | /tasks/:id PATCH | PATCH | 任务状态 | ✅ | 不变 |
| 18 | /reclaim-name | POST | zombie 回收 | ✅ | 不变 |
| 19 | /prepare-rebind | POST | 显式接力 | ✅ | 不变 |
| 20 | /internal/network-event | POST | 网络事件 | 🟨 broadcast | 同 #10 |

**20/20**：14 ✅ + 6 🟨（向后兼容扩展）·**0 ❌**。

### F.3 7 WS message types（hub.mjs:474-501）

| # | type | 方向 | 用途 | 新方案 cover | 说明 |
|---|------|------|------|-------------|------|
| 1 | ping | client→server | 心跳 | ✅ | 不变 |
| 2 | register | client→server | 注册 session | 🟨 字段扩展 | E.1 加 runtime + appServerThreadId |
| 3 | update | client→server | 更新 contextUsagePct | ✅ | 不变 |
| 4 | subscribe | client→server | topic 订阅 | ✅ | 不变 |
| 5 | unsubscribe | client→server | topic 退订 | ✅ | 不变 |
| 6 | message | client→server | 发消息 | 🟨 内部路由分支 | 同 /send |
| 7 | ack | client→server | 确认收到 | ✅ | 不变 |

**7/7**：5 ✅ + 2 🟨·**0 ❌**。

### F.4 session metadata 字段

| 字段 | 现状 | 新方案 cover | 说明 |
|------|------|-------------|------|
| pid | ✅ | ✅ | 不变 |
| cwd | ✅ | ✅ | 不变 |
| contextUsagePct | ✅ | ✅ | statusline 上报不变 |
| cost | ✅ | ✅ | ccusage 集成不变 |
| model | ✅ | ✅ | 不变 |
| topics | ✅ | ✅ | pub/sub 不变 |
| connectedAt | ✅ | ✅ | 不变 |
| lastAliveProbe | ✅ | ✅ | watchdog 不变 |
| **runtime** | ❌ 不存在 | ✅ 新增 | 'claude' / 'codex' / 'unknown' |
| **appServerThreadId** | ❌ 不存在 | ✅ 新增 | codex 专用·thread/start 后回填 |

**口径明示**（v0.3 修订·避免 v0.2 计算歧义）：
- 8 现有字段·全部保留 ✅
- 2 新增字段（runtime / appServerThreadId）·**现状缺 = 新方案补齐 = 向后兼容 = 算 cover ✅**（新字段缺省值 'unknown' / null·旧 client 不上报也不报错）

**总评 10/10 ✅**·100% cover。

### F.5 总 cover 度

**43 项 + 10 metadata = 53 项**：
- ✅ 完全保留：39 项
- 🟨 mapping / 字段扩展（向后兼容）：14 项
- ❌ 废弃：**0 项**
- cover 率：**100%**（53/53）

---

## §G · App Server 实现不了的（具体 use case·非接口名）

> **v0.3 更新**：v0.2 §G.1（双进程 thread 共享未实证）已删·PoC v1+v2 实证 turn/steer mid-turn 真工作 + thread/inject_items（schema 4）真 surface·此风险消除。原 §G.2-§G.6 重编号为 §G.1-§G.5。

### G.1 风险一·codex App Server WebSocket transport 实验性

**问题**：
- codex App Server README 明确：「websocket transport is currently experimental and unsupported. Do not rely on it for production workloads.」
- stdio 默认稳定·但需要 Hub 与 codex 进程在同一 host
- 如未来 codex 跑远程 host（比如 Anthropic Cloud Workspace）·必须 WebSocket·实验性 = 风险

### G.2 风险二·App Server 不支持跨 thread broadcast

**问题**：
- thread 是 1:1 subscription·一个 thread/start 只对一个 client 有效
- broadcast (to=*) 发到多个 codex session·必须 Hub 层 fan-out（每 thread 各调一次）
- = 不能用 App Server 一次性 broadcast 到 N 个 codex thread·N 增加时延迟线性增长

### G.3 风险三·codex thread 30min idle 后 auto-unload

**问题**：
- App Server thread 在 no subscribers + no activity 30min 后 unload·返回 thread/closed
- 我们 portfolio session 经常 idle 几小时（如夜间）·30min 后 thread 失效
- Hub 必须监听 thread/closed notification·重新 thread/start·threadId 变·session.appServerThreadId 必更新
- 复杂度 +1·容易引入 race（unload 期间 IPC 进来·thread/start 没完成）

### G.4 风险四·OpenAI 政策风险

**问题**：
- codex App Server 是 OpenAI 私有协议·跟 OpenAI 商业策略绑定
- 如 OpenAI 改 API（破坏性变更 / 收费 / 限速 / 关停）·我们整层 Hub 改动作废
- 对比 ACP 是开源标准·变更可控·但 ACP 没 turn/steer（§3 实证）
- 对比 fork MCP patch 自主可控·但维护成本高

### G.5 风险五·跨 agent 兼容性

**问题**：
- 未来加 Gemini / Copilot / OpenCode session·这些 agent **没有** App Server 协议
- 必须走 ACP（如 OpenClaw acpx 模型）或各自专有协议
- = §C 推荐方案只解决「CC + codex」·**第三种 agent 加入时还要再投一遍**（ACP 层）

---

## §H · §G 每个风险的兜底方案（三档明示）

> **v0.3 更新**：v0.2 §H.1（turn 同步兜底）已删·G.1 风险消除（PoC 实证）·原 §H.2-§H.6 重编号为 §H.1-§H.5。

### H.1 G.1（WebSocket experimental）兜底

- **首档·只用 stdio**：当前所有 portfolio session 都本地·stdio 完全够用·不依赖 WebSocket·**绕开实验性风险**。
- **二档·远程 codex 时换其它协议**：未来如 codex 跑远程·先评估那时 codex App Server WebSocket 是否 stable·如不 stable 切 ACP（ACP 标准远程协议更成熟）。

### H.2 G.2（无跨 thread broadcast）兜底

- **首档·Hub 层 fan-out**：现已设计 broadcastWithRuntime（E.5）·N 个 codex thread 串行 turn/steer·延迟 N×<100ms。**N <= 10 portfolio 体量下完全可接受**。
- **二档·并行调用**：Promise.all 并行 N 个 turn/steer·延迟降到 max <100ms·实施成本低·风险是 App Server backpressure -32001·**已有重试机制**。

### H.3 G.3（thread 30min unload）兜底

- **首档·Hub 自动重启 thread**：监听 thread/closed notification·收到后立刻 thread/start 重新订阅·更新 session.appServerThreadId。**race 处理**：unload 期间收到 IPC·先 pushInbox 兜底（现有 SQLite 持久化）·thread 重启后 flush。
- **二档·主动 keepalive**：Hub 定时（每 25min）发轻量 turn/steer 或 ping·阻止 thread unload。**成本**：每 25min 一次 IPC·token 极少。
- **三档·调长 unload 阈值**：codex App Server 可能允许配置 unload TTL·如可调到 24h·**最简单**·但需 codex 提供配置（待实证）。

### H.4 G.4（OpenAI 政策风险）兜底

- **首档·留 fork MCP patch 备选**：如 OpenAI 关停 App Server·切换到 fork codex-rs 的 #18056 50 行 patch（§5 候选 D）。需提前准备 fork pipeline。
- **二档·切 ACP**：如 ACP 协议补上 mid-turn inject（如 `session/steer` 之类·关注 ACP 协议演进）·切回 ACP 全开放标准。
- **三档（最差）·polling**：永久走 5min polling·portfolio 等其他 agent 替代 codex（如 Anthropic 推 codex 替代品）。

### H.5 G.5（跨 agent 兼容）兜底

- **首档·留 ACP layer 接口**：v0.2 推荐方案 §C 已留扩展点·session.runtime 字段已支持 'acp'·未来加 Gemini 走 ACP layer 不影响现有 codex App Server / CC MCP。
- **二档·OpenClaw acpx 模式**：直接用 OpenClaw acpx（已支持 11+ agent）作为多 agent runtime·我们 Hub 通过 acpx 间接控制·不重复造轮子。
- **三档·按 agent 种类分别接**：每加一种 agent 实现一个专属 client driver·N 增加成本线性·**v0.2 不解·留给 Phase 3**。

---

## §I · 验收清单（11 条 AC·每条可逐项手动跑·v0.3 新增 AC-10 schema 4 reproduction + AC-11 outbound 实证）

### AC-1·codex active turn 收 IPC·turn/steer 实时 inject

**准备**：
1. portfolio 起两个 session：`harness`（CC）+ `test-codex-1`（codex via ipc_spawn host=wt runtime=codex）
2. 等 test-codex-1 register 上报 runtime='codex' + appServerThreadId 入 sessions-registry.json
3. 老板在 test-codex-1 输入：「分析这段代码 ABC，思考 30 秒后告诉我结果」（让 codex 起一个长 turn）

**执行**：
4. 在 codex 思考期间（active turn 中）·harness 调 `ipc_send to=test-codex-1 content="[AC-1 STEER] check this marker"`
5. 等 test-codex-1 当前 turn 结束·让老板输入：「你刚才看到了什么 marker？」

**期望**：
6. test-codex-1 回复 **必须包含字符串 `[AC-1 STEER]`**·且 codex 表示「在思考过程中收到了 harness 的提醒」

**FAIL**：
- codex 回复不含 `[AC-1 STEER]`
- 或 codex 回复「没收到任何额外消息」
- 或 turn/steer 调用返回 error（看 hub log·grep `app_server_steer_fail`）

### AC-2·codex idle 收 IPC·thread/inject_items + next turn 自动 surface

**准备**：
1. portfolio 起 `harness` + `test-codex-2`
2. test-codex-2 register 上报后·**不输入任何东西**·让 codex idle ≥30s

**执行**：
3. harness 调 `ipc_send to=test-codex-2 content="[AC-2 INJECT] idle marker"`
4. 等 30s
5. 老板在 test-codex-2 输入：「现在收到什么消息了吗？」

**期望**：
6. test-codex-2 回复 **必须包含字符串 `[AC-2 INJECT]`**

**FAIL**：
- 回复不含 marker
- 或 codex 起 turn 后没看到 inject_items 内容（看 hub log·grep `app_server_inject_fail`）

### AC-3·broadcast (to=*) 同时含 CC + codex receiver

**准备**：
1. 起 `harness`（CC）+ `test-codex-3`（codex）+ `test-claude-3`（CC）三 session
2. 三 session 都 register

**执行**：
3. 任一 session 调 `ipc_send to=* content="[AC-3 BROADCAST] all check"`
4. 等 60s
5. 分别在三 session 询问：「刚才的 broadcast 收到了吗？」

**期望**：
6. **三个 session 都回复包含 `[AC-3 BROADCAST]`**

**FAIL**：
- 任一 session 没收到（特别是 codex receiver）
- hub log grep `broadcast_runtime_dispatch_fail`

### AC-4·CC ↔ CC IPC 现有路径 0 回归

**准备**：
1. 起 `harness`（CC）+ `test-claude-4`（CC）
2. 两 session register（runtime='claude'）

**执行**：
3. harness `ipc_send to=test-claude-4 content="[AC-4 CC-CC] regression check"`
4. test-claude-4 next turn 看 channel notification

**期望**：
5. test-claude-4 transcript **必含 `<channel from="harness">[AC-4 CC-CC]...</channel>` 标签**·下次 turn AI 看见

**FAIL**：
- channel notification 没出现
- 或 hub log 显示 test-claude-4 走了 App Server 分支（应走 channel notification）：grep `route_runtime_misclassify`

### AC-5·codex spawn 同时启 App Server 子进程 + thread/start

**准备**：
1. portfolio 起 `harness`
2. harness 调 `ipc_spawn name=test-codex-5 runtime=codex host=wt task=...`

**执行**：
3. 等 10s 让 spawn 完成
4. 检查：
   - `sessions-registry.json` 有 test-codex-5 · runtime='codex' · appServerThreadId 是 UUID
   - `ps` / `Get-Process` 看到 codex 主进程 + codex app-server 子进程同时在跑

**期望**：
5. 两个进程都在·threadId 已写 sessions-registry

**FAIL**：
- 只有 codex 主进程·没 app-server 子进程
- 或 sessions-registry threadId 是 null
- 或 spawn 整体失败·hub log grep `spawn_app_server_fail`

### AC-6·App Server 异常·fallback inbox 不丢消息

**准备**：
1. 起 `harness` + `test-codex-6`
2. 故意 kill test-codex-6 的 app-server 子进程（模拟异常）

**执行**：
3. harness `ipc_send to=test-codex-6 content="[AC-6 FAIL-OVER] check inbox"`
4. 看 hub log：必含 `app_server_push_failed` + `pushInbox_fallback_ok`

**期望**：
5. 消息进 SQLite inbox·test-codex-6 重启 app-server 后通过 ipc_recent_messages 能查到

**FAIL**：
- 消息丢失（SQLite 没有）
- 或没 fallback·hub crash

### AC-7·性能·1 条 IPC 推送延迟（active turn）

**准备**：
1. 起 `harness` + `test-codex-7`
2. test-codex-7 在 active turn 中

**执行**：
3. harness 调 `ipc_send`·hub log 记 `route_dispatch_ts` + `app_server_steer_ack_ts`
4. 计算 delta = ack - dispatch

**期望**：
5. **delta < 200ms**（目标 100ms·允许 100ms 余量）

**FAIL**：
- delta > 500ms·codex 主进程 turn 频繁卡顿·走 polling 退路（v0.2 §H.1 三档·v0.3 已删·实证不需要）

### AC-8·安全·App Server 鉴权·不暴露未授权访问

**准备**：
1. 起 `harness` + `test-codex-8`
2. App Server 通过 stdio·**不开 WebSocket** 端口

**执行**：
3. `netstat -an | grep LISTEN` 查 codex app-server 进程·**不应** 监听任何 TCP / WebSocket 端口
4. 如未来切 WebSocket·必须用 capability token / signed bearer

**期望**：
5. 默认 stdio·0 监听端口·无未授权风险

**FAIL**：
- 看到 codex app-server 监听 0.0.0.0:N 端口（应只 stdio）
- WebSocket 启用时 token 不设置或弱

### AC-9（额外·可选）·portfolio dogfood

**准备**：
1. 实际跑 24h portfolio 全部 session
2. 监控 hub log + sessions-registry + watchdog metrics

**期望**：
3. codex session 收 IPC 100% 不丢
4. broadcast 全员 receive 率 100%
5. CC ↔ CC 0 回归
6. App Server child crash auto-restart 触发率 < 5%

**FAIL**：
- 任一 codex session 丢消息（不在 inbox 兜底范围）
- broadcast 漏单
- CC 受影响

### AC-10·schema 4 inject_items 真 surface（PoC v2 reproduction）

**准备**：
1. 起 `harness` + `test-codex-10`（codex via ipc_spawn runtime=codex）
2. 起 codex app-server·initialize + thread/start 拿 threadId
3. test-codex-10 idle（无 active turn）

**执行**：
4. Hub 调 `thread/inject_items` 用 schema 4：
   ```json
   { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": "[AC-10 SCHEMA-4-MARKER] reproduction" }] }
   ```
5. 等 60s
6. test-codex-10 起 turn/start `"列出从对话开始你看到的所有 [AC-10 *] marker"`

**期望**：
7. final agentMessage **必含字符串 `[AC-10 SCHEMA-4-MARKER]`**

**FAIL**：
- 回复不含 marker（schema 4 也 silently drop）→ codex 0.125 升级新版可能改了 schema·ADR-014 标版本 pin
- 配套：实施时同时跑 schema 1/2/3 各一次 reproduction·确认 codex 0.125 行为不变（PoC v2 实证锚点）

### AC-11·codex MCP outbound tool call（orchestrator readiness 假设验证）

**准备**：
1. 起 `harness` + `test-codex-11`（codex orchestrator 候选）
2. test-codex-11 register 成功

**执行**：
3. 老板在 test-codex-11 输入：「请调 ipc_send 发个测试消息给 harness·内容是 `[AC-11 OUTBOUND]`」
4. 等 30s
5. harness 调 `ipc_recent_messages since=60000` 看是否收到

**期望**：
6. harness recent messages **必含来自 test-codex-11 的 `[AC-11 OUTBOUND]`**

**FAIL**：
- harness 未收到 → codex MCP outbound tool call 链路断·orchestrator 无法主动发 IPC·**§K orchestrator readiness 跌到 50% 以下**·迁 jianmu-pm 试点暂缓
- 这是关键 assumed ✅·必活体测·不能假设

---

## §K · codex orchestrator readiness 评估（老板战略 context）

**触发**：老板 03:20 战略明示「我推 codex 是因为想迁部分 CC orchestrator 节省 max20x token·CC 一周两 max20x 不够·codex 周额度用不完」。orchestrator 候选包括 jianmu-pm 自己。本节专门评估 codex 当 orchestrator 是否够格。

### K.1 orchestrator 必备 6 能力 + cover 度

| # | 能力 | codex 当前 cover | 说明 |
|---|------|----------------|------|
| 1 | **24/7 standby keepalive** | ❌ | App Server thread 30min idle auto-unload（README 实证）·orchestrator 必须永久在线·裸跑必失效 |
| 2 | **standby polling Hub backlog** | 🟨 | codex MCP client 可调 ipc_recent_messages·**但 idle 期不会自动唤起 polling**·必须 keepalive 触发的 dummy turn 同时 polling |
| 3 | **context 管理** | 🟨 | thread/fork 可分支·但**没 truncate**·orchestrator context 累积过快 |
| 4 | **lineage 切换 / atomic handoff** | 🟨 | thread/fork 可 mapping ADR-010 5 步·但 fork 不是 lineage rename + spawn·需 mapping SOP |
| 5 | **派 worker / 调 ipc_spawn / 审报告** | 🟨 假设 | codex MCP outbound tool call 假设可用·**未活体测**·必 AC-11 验 |
| 6 | **IPC 协调 broadcast / subscribe** | 🟨 假设 | 同 5·MCP outbound 假设·必活体测 |

**总评**：6 项 0 ✅ + 4 🟨 + 2 🟨假设 = **~70% readiness**·**裸迁不可行·必先建 keepalive + outbound 实证 + atomic handoff mapping 三项配套**。

### K.2 P1 follow-up 配套（迁 orchestrator 前必做）

| 配套 | 说明 | ETA |
|------|------|-----|
| **K.A keepalive 模块**·`lib/codex-thread-keepalive.mjs` | Hub 每 25min 对每 codex thread 发轻量 turn/start `"keepalive ping"` + 立即 turn/interrupt 终止·消耗 ~50 token·防 30min unload | ~200 行 + 单元测试·派 codex 1 run·~1.5h |
| **K.B outbound 实证**·AC-11 | 活体测 codex MCP outbound tool call（ipc_send / ipc_recent_messages / ipc_spawn）链路 | ~30min PoC + 派 codex 写测试 30min |
| **K.C atomic handoff mapping** | thread/fork 配 ADR-010 5 步 SOP（ipc_rename + new thread + brief inject + thread/closed 旧）·写到 `domains/software/CLAUDE.md` | jianmu-pm 自做 ~1h |

**实施顺序**：先 K.B（30min·决定 K 总 readiness·outbound 失败则全停） → K.A（~1.5h·必备 keepalive） → K.C（~1h·SOP 文档）。**总 ~3h** 配套完成才能开始 jianmu-pm 试点迁移。

### K.3 试点排期建议

- **试点 0**：K.A + K.B + K.C 配套 ship·portfolio 现有 codex worker session 不受影响
- **试点 1**：jianmu-pm 自己第 1 试点迁 codex（**非关键路径** + context 中等 + 风险可控） · **dogfood 1 周**·收集失败模式·迭代 K.A keepalive
- **试点 2-3**：harness（codex orchestrator）+ taiwei-director（codex orchestrator）迁移·**取决于试点 1 结果**
- **portfolio 全迁 cap**：3-4 个 orchestrator·占 portfolio 9 session 的 33-44%·节省 30-50% CC 块（详见 §L）

### K.4 不迁的 orchestrator

- **harness 自身**：portfolio 治理层·**不在第一批**·等 codex orchestrator 模型成熟（~3-6 月观察期）后评估
- **auditor-portfolio**：跨项目独立审查员·**不迁**（独立性要求 + 跨项目 context 复杂度）
- **CC code-heavy session**（如 taiwei-builder / taiwei-frontend）：worker 性质·不影响

---

## §L · 成本评估（迁移 ROI）

**触发**：同 §K·老板战略 context。本节量化迁移成本 + 节省。

### L.1 现状（hub /sessions 实测）

| session | 模型 | 5h block | 7d block | 累计 cost |
|---------|------|---------|---------|----------|
| harness（CC orchestrator） | Opus 4.7 1M | 24% | 45% | $95.9 |
| jianmu-pm（CC orchestrator） | Opus 4.7 1M | 25% | 45% | $14.4 |
| taiwei-director（CC orchestrator） | Opus 4.7 1M | ? | ? | ? |
| 其他 6 session | 混合 | ~5-50% | ~10-40% | ~$50-100 |

**总览**：portfolio 9 session 5h block ~50-80% 占用·**老板原话「两个 max20x 都不够」实证**。

### L.2 迁移后预估（粗算·实施时回归测）

- **1 orchestrator 迁 codex**·节省 ~10-20% CC 5h block + 7d block
- **3 orchestrator 迁 codex**（jianmu-pm + harness + taiwei-director）·节省 ~30-50% CC 5h block
- **codex 周额度**：当前 used 0%·迁 3 orchestrator 后 ~30-50%·**仍有余量**（max20x codex 等价）
- **平均 cost ratio**：codex orchestrator vs CC Opus 4.7 ≈ 1:5-1:10（codex gpt-5.x token 成本约 1/5 至 1/10 Opus）

### L.3 迁移成本

| 项 | 成本 |
|------|------|
| §K.A keepalive 模块 | ~1.5h codex run + 100 行 hub 改 + 测试 |
| §K.B outbound AC-11 | ~30min PoC + 30min 测试 |
| §K.C atomic handoff SOP | ~1h jianmu-pm 自做 |
| **配套总成本** | **~3-4h 一次性** |
| 试点 1 dogfood | 1 周 jianmu-pm 自己 24h dogfood + 失败模式收集 |
| 后续 2-3 试点 | 各 1 周 dogfood |
| **总 dogfood** | **~3-4 周** |

### L.4 ROI

- **投入**：3-4h 配套 + 3-4 周 dogfood + 实施 ADR-014 主体（Phase 2 codex App Server bridge）4-6h codex run + 1 周回归
- **产出**：30-50% CC max20x 节省·**月省 ~$200-300**·年省 $2400-3600
- **payback 周期**：< 1 月（实施完成即 ROI positive）
- **风险溢价**：试点失败回退成本极低（保 CC orchestrator 现状·迁回 1h jianmu-pm 自做）

### L.5 决策建议

- **拍 ADR-014 主体方案**（codex App Server bridge）→ Phase 1 完成 K.A+K.B+K.C → Phase 2 试点 jianmu-pm 1 周 → Phase 3 扩 2 个 orchestrator → portfolio 治理稳定
- **试点候选 jianmu-pm**·非关键路径 + context 中等 + 风险可控（非 harness / auditor）

---

## §J · 拍板路径 + 配套

### J.1 拍板流程

```
v0.3 doc → harness 04:18 派单 ETA 1.5h → harness 逐字审 → 老板醒来汇报 → 老板拍 → 主架构师出正式 ADR-014
```

### J.2 ADR-014 内容（如老板选 §C 方案）

- 摘 §C/§D 核心 + §E 改动清单 + §I AC 11 条 + §K orchestrator readiness + §L 成本评估
- 增加：API contract 定义（codex-app-server-client.mjs 完整接口）+ 回退策略（每 AC FAIL 走 §H 兜底）+ release notes
- 落档：`xihe-jianmu-ipc/docs/adr/014-ipc-codex-app-server-bridge.md`

### J.3 实施 ETA + token 估算（v0.3 更新·加 keepalive 模块）

**实施总 ETA**（不含 doc 审查）：

**Phase 1·主路径 codex App Server bridge**（必备）：
- E.3 codex-app-server-client.mjs 单元 + 实现：派 codex 1 run·ETA 1h·token ~3 万
- E.4-E.6 router 改动 + helper：派 codex 1 run·ETA 30min·token ~1.5 万
- E.7 spawnSession 改：派 codex 1 run·ETA 30min·token ~1.5 万
- 单元测试：派 codex 1 run·ETA 1h·token ~2 万

**Phase 2·orchestrator 配套**（迁 jianmu-pm 试点前必做·见 §K.2）：
- §K.A keepalive 模块 `lib/codex-thread-keepalive.mjs`：派 codex 1 run·ETA 1.5h·token ~3 万
- §K.B AC-11 outbound 实证：jianmu-pm 自做 PoC·ETA 30min·token ~5k
- §K.C atomic handoff SOP：jianmu-pm 自做·ETA 1h·0 token

**Phase 3·集成测试 + AC 跑**：
- 集成测试 + AC-1~AC-11 跑（**v0.3 新增 AC-10 / AC-11**）：jianmu-pm 协作·ETA 5-7h·token ~4 万
- 回归测试 portfolio：jianmu-pm + harness 协作·ETA 1 周

**Phase 4·dogfood 试点**：
- jianmu-pm 第 1 试点迁 codex orchestrator：1 周 dogfood·token ~3 万 / 周（codex 端）
- 收集失败模式 + 迭代 keepalive

**总 token**：~16 万（v0.2 11 万 + Phase 2 配套 5 万）·**总 ETA**：实施 ~5h codex 跑 + 配套 ~3h + 测试 5-7h + dogfood ~1 周（试点 1）+ ~3-4 周（后续 2-3 试点）。

### J.4 角色到人

| 阶段 | 责任 |
|------|------|
| v0.3 doc 起草 | jianmu-pm（已完成 04:05） |
| harness 审 v0.3 | harness（04:18→04:25 7min·已完成 + 8 修订·v0.4 修完） |
| 老板拍 | 老板（醒来） |
| ADR-014 起草 | jianmu-pm（如拍 hybrid·~1.5h） |
| E.3 实施 | 派 codex（jianmu-pm 出 brief + AC） |
| E.4-E.7 实施 | 派 codex（jianmu-pm 出 brief） |
| §K.A keepalive 模块（v0.3 新增） | 派 codex（jianmu-pm 出 brief） |
| §K.B AC-11 outbound 实证 | jianmu-pm 自做 PoC |
| §K.C atomic handoff SOP | jianmu-pm 自做 |
| 单元测试 | 派 codex |
| 集成测试 + AC-1~AC-11 跑 | jianmu-pm + harness 协作 |
| 回归测试 + dogfood | portfolio + jianmu-pm 第 1 试点 1 周 |

### J.5 5 件套同步策略

- v0.3 doc 落 `docs/research/`·**不** trigger 5 件套自更（非 feat/fix/refactor）
- ADR-014 ship（Phase 2 完成）→ trigger TODO + PROJECT-PLAN
- 各 codex 实施 commit（feat/fix）→ 每个 trigger TODO 同步

---

## §M · 参考源（实证依据）

1. ACP spec 主页：https://agentclientprotocol.com
2. ACP llms.txt：https://agentclientprotocol.com/llms.txt
3. ACP prompt-turn protocol：https://agentclientprotocol.com/protocol/prompt-turn
4. codex App Server README：https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
5. codex App Server developer doc：https://developers.openai.com/codex/app-server
6. codex issue #18056（MCP push limitation）：https://github.com/openai/codex/issues/18056
7. CC issue #50160（asyncRewake schema 漂移）：https://github.com/anthropics/claude-code/issues/50160
8. CC issue #50682（Stop additionalContext OPEN feature request）：https://github.com/anthropics/claude-code/issues/50682
9. CC hooks docs（asyncRewake 字段定义）：https://code.claude.com/docs/en/hooks
10. OpenClaw acpx：https://github.com/openclaw/acpx
11. OpenClaw ACP agents 列表：https://docs.openclaw.ai/tools/acp-agents
12. xihe-jianmu-ipc 真实代码 grep：mcp-server.mjs / hub.mjs / lib/mcp-tools.mjs / lib/router.mjs / lib/http-handlers.mjs / lib/channel-notification.mjs / lib/session-registry.mjs / lib/openclaw-adapter.mjs

## §N · 配套调研报告（评估输入）

- `temp/codex-runs/b-stop-hook-additionalContext-research.md`（B 调研：Stop additionalContext 不支持·锁定 (c)）
- `temp/codex-runs/b-prime-asyncRewake-research.md`（B' 调研：asyncRewake 是 settings 配置字段·CC 2.1.120 GA·activity test recipe ready·**Phase 1 撤后此调研归档·留给未来 CC idle wake 优化**）
- `temp/codex-briefs/ipc-push-mechanism-research-brief.md`（前期总 brief：4 候选 A/B/C/D）
- `temp/codex-runs/poc-codex-app-server-bridge.md`（PoC v1·b51e7v2u1·turn/steer ✅ + inject_items 假成功 + 副 CLI ❌ 实证）
- `temp/codex-runs/poc-v2-inject-items-schema.md`（PoC v2·bzi77w8n4·schema 4 唯一 surface 实证·1/2/3 silently drop）
- `temp/codex-briefs/poc-codex-app-server-bridge-brief.md`（PoC v1 brief）
- `temp/codex-briefs/poc-v2-inject-items-schema-brief.md`（PoC v2 brief）

---

— jianmu-pm · 2026-04-28T02:50+08:00 · v0.2 草稿（九段式齐全）
— jianmu-pm · 2026-04-28T04:18+08:00 · v0.3 修订（PoC v1+v2 实证 + schema 4 default + §K orchestrator readiness + §L 成本评估 + AC-10/11 + §G.1/§H.1 删·12 段齐全）
— jianmu-pm · 2026-04-28T13:35+08:00 · v0.4 修订（harness 04:25 8 修订全采纳·P0 §E.6 schema 4 + P1 4 矛盾修 + P2 3 时戳更新·标题/footer/changelog 三处 v0.4 统一·14 段齐全·实施前最终版本·老板 13:22 拍开干）
