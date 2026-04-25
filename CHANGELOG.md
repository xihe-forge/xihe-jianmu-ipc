# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-04-25

> ADR-002 完整 Phase 1 + ADR-005 observation 层 Phase 0 + ADR-008 reclaim + ADR-009 channel race fix + commit 18 watchdog Hub WS keepalive + 第 6/7/8 watchdog probe + hub-daemon 时间盒。50+ commits 自 v0.4.1 累积。

### Added

#### 会话接力 (Phase 1) + IPC 工具 (Phase 2)

- `POST /prepare-rebind` 显式会话接力端点，支持 `topics` + `buffered_messages` 继承（默认宽限期 5s 最大 60s，兼容 `IPC_AUTH_TOKEN` / `auth-tokens.json`）
- `pending_rebind` 表 + `lib/db.mjs` 持久化层 + flushInbox 与 release-rebind 联动（重连时继承宽限期内缓冲消息）
- `ipc_spawn` MCP 工具扩 `host` 参数（`wt` / `vscode-terminal` / `external`，默认 `external`）+ canonical cmdline + `cwd` 透传
- `ipc_spawn` 5 host 路径全注入 `IPC_NAME` 环境变量（替代 `--session-name` / `--resume`）
- `ipc_reclaim_my_name(name)` MCP 工具 + `POST /reclaim-name` Hub endpoint（自助回收同名 zombie 占位，holder 主动 ping 5s 无 pong 才 evict，5 分支状态机：no-holder / pending-rebind / rate-limit 10s / holder-alive / evict）

#### Watchdog 健康监测 (Phase 3 + 后续)

- 第 5 probe `harness-heartbeat`：`probeHarnessHeartbeat` + `createHarnessStateMachine` + watchdog 集成 + `/status` 扩 `harness` 字段（`state` / `contextWarnPct` / `lastTransition` / `lastReason` / `lastProbe`）
- 第 6 probe `committed_pct`：90% WARN 广播 `critique` topic + 95% CRIT 调 `session-guard.ps1 -Action tree-kill` 自动清 vitest 最大子树（三维验明正身保护：Get-Process + 端口 LISTENING 关联 + cmdline 一致）+ 5min dedup per-level
- 第 7 probe `available_ram_mb`：< 10GB WARN / < 5GB CRIT 纯广播（UX 警告 role，与 committed_pct 95% tree-kill 不重叠）
- 第 8 probe `phys_ram_used_pct`：80% WARN / 90% CRIT 物理 RAM 用量百分比 `(1 - avail_mb/total_mb) × 100` 纯广播（vitest-memory-discipline v1.0.3 §3.4 单 gate）
- watchdog 冷启 2min cold-start grace（`WATCHDOG_COLD_START_GRACE_MS` 可覆盖），防误触 self-handover
- watchdog `ingestHeartbeat()` 校验 heartbeat `ts` 鲜度：早于 watchdog `startedAt - 60s` 的历史消息或解析失败的非法 `ts` 一律忽略，不驱动 transition / handover
- watchdog 仅在 probe 返回 `{ ok: true, connected: true }` 时刷新内存 `lastSeenOnlineAt`

#### Self-handover (Phase 4)

- `lib/harness-handover.mjs` schema v2 生成器 + git commit 自动化 + dryRun 模式
- `triggerHarnessSelfHandover()` 仅在 harness `down` 时触发（`degraded` 仅风险态不触发）
- 全链路集成测试 dryRun（harness-state.down → triggerHarnessSelfHandover → ipc_spawn stub）

#### ADR-005 Observation 层 + Registry

- `ipc_recall(project, since?, limit?, ipc_name?, tool_name?, tags?, keyword?)` MCP 工具，跨项目 FTS5 检索（支持 `project="*"` 跨项目合并，文本字段预览截断 500 chars）
- `ipc_observation_detail(project, id)` MCP 工具，拉单条 observation 完整字段不截断 `tool_input` / `tool_output`，含 `jsonl:` 元数据
- `ipc_register_session(name, role?, projects?, access_scope?, cold_start_strategy?, note?)` + `ipc_update_session(name, projects)` MCP 工具
- Hub `POST /registry/register` + `POST /registry/update` 端点（集中维护 `~/.claude/sessions-registry.json` 避免并发竞态）
- `lib/observation-query.mjs` 层（`~/.claude/project-state/<project>/observations.db` + FTS5）
- `lib/lineage.mjs` `createLineageTracker` + SQLite `lineage` 表，session 派生关系追踪

#### Daemon + 守护进程

- `bin/hub-daemon.vbs` 时间盒改造（exit-after-once + `WScript.Quit 0` + ISO-8601 housekeeping log），周期性依赖 schtasks `AtLogOn + Repetition 10min + Indefinitely + MultipleInstances=IgnoreNew` 触发器，根治孤儿 wscript 累积

#### 诊断 audit 三层

- `push_deliver` per-session audit event（区分 Hub send 成功 vs client 真收到，含 `msg_id` / `ws_ready_state` / `send_ok` / `send_err` / `reason`）
- `ack_received` audit event（client 真收到的端到端证据）
- `mcp-trace` 接收端诊断日志 + `server.notification` 调用 trace
- `feedback_ipc_push_vs_hub_delivered.md` 沉淀（Hub `status: delivered` 不等于 AI 看到，pull 诊断三阶法）

#### MCP server 工具化与可测性

- `lib/mcp-tools.mjs` 抽出 `createMcpTools(ctx)` 工厂函数，支持单元测试
- `tests/` 目录重组：单元（`tests/*.test.mjs`）+ 集成（`tests/integration/`）+ E2E（`tests/e2e/`），集成测试占比 4% → 21%
- `npm test` 基线 558 → 587（v0.5.0 收口含 hub-daemon-timebox + phys-ram-used-pct + AC-DAEMON/AC-WATCHDOG-008/AC-HOOKS-001 等新 AC）

### Changed

- watchdog 存活判据从 `lastMsgTs + maxSilentMs=10min`（消息静默判死）改为 `GET /session-alive?name=X → ws.readyState===OPEN` + `wsDisconnectGraceMs=60s`（commit 18，2026-04-21 cutover 4 阶段 0 false positive）
- `flushInbox` 重连时不再自动推 messages 表历史（防 token 轰炸），历史改走 `ipc_recent_messages` pull
- `harness-state.markAliveSignal` 移到 `ingestHeartbeat` 顶部，hard-signal 优先于 cold-start grace
- `wt` spawn 改用 `cmd /c start` 处理 UI session
- `spawnSession` 增 `cwd` 参数 + `triggerHarnessSelfHandover` 透传 `handoverRepoPath`
- canonical cmdline：`bin/claude.exe --dangerously-skip-permissions --dangerously-load-development-channels server:ipc`（删 `--session-name` / `--resume`，靠 `IPC_NAME` env）
- daemon scripts 去 `cmd /c` 外壳（每 10min CMD 闪窗修复）+ 路径指向 CPA 6.9.36（GPT-5.5 支持）

### Fixed

- **ADR-009** channel notification pre-initialize race：`mcp-server.mjs` 通过 `lib/channel-notification.mjs` 工厂维护 pre-init queue，`server.oninitialized` 触发后 FIFO flush（解决 Hub inbox flush 在 initialize 完成前 `notifications/claude/channel` 静默丢失）
- channel-notification 加 5s timeout fallback：抢救 Claude Code 2.1.119 MCP handshake 死锁，5s 无 `oninitialized` 触发即 force flush
- watchdog `onTransition` 只触发 `down` + dryRun 不落盘 + heartbeat ts 过滤（防孤儿 commit）
- watchdog cold-start grace period（默认 2min），冷启不误触 harness self-handover

### Removed

- 死代码清理：`instance_id` / `session_instances`（commit 14 变迁遗留）

### Security

- `POST /reclaim-name` 仅允许 loopback 调用 + 1KB body cap

### Reverted

- 93f94db `--dangerously-load-development-channels server:ipc` → `--channels server:ipc` swap 误改在 7bfbd94 全量 revert 13 处：误读 Claude Code 2.1.119 warning 文案 `approved channels` 当等价新写法，实际两 flag 走完全不同 allowlist 分支（前者 dev=true 绕 allowlist 注册 handler，后者走 Teams/Enterprise allowlist `server:ipc` 不在任何官方 allowlist），导致 ~6h portfolio push 全失灵（feedback_cli_flag_semantics 同步沉淀，详见 retro §8.5 bug 5）

## [0.4.1] - 2026-04-19

### Added

- feat(router): Hub 创 stub session 时立即回发送方 unknown-target 警告（避免消息静默堆积，踩坑案例见 data/hub.log）
- docs(operations): OPERATIONS.md 新增「发版流程」章节——npm whoami 预检 + npm 404 伪装 401 诊断 + 常见错误矩阵 + Trusted Publishing 长期路径

## [0.4.0] - 2026-04-18

### Added

- network resilience probes for CliProxy, Hub, Anthropic, and DNS (`lib/network-probes.mjs`)
- watchdog-oriented state machine with `OK` / `degraded` / `down` transitions plus recovery hysteresis (`lib/network-state.mjs`)
- structured network event helpers for `network-down` / `network-up`, including suspended session fanout payloads (`lib/network-events.mjs`)
- `POST /suspend` session self-report endpoint with `suspended_sessions` SQLite persistence
- loopback-only `POST /internal/network-event` bridge with shared-token authentication and 5-second idempotent dedupe
- standalone `bin/network-watchdog.mjs` process with `/status` health endpoint on `127.0.0.1:3180`
- Windows Task Scheduler daemon bundle for watchdog auto-heal (`network-watchdog-daemon.vbs` + install/uninstall scripts)

### Changed

- `POST /wake-suspended` now routes through `broadcastNetworkUp` helper, broadcasts structured payloads, and consumes `suspended_sessions`

### Security

- internal watchdog bridge now requires `X-Internal-Token`, persists the fallback token in `.ipc-internal-token`, and rejects non-loopback callers
## [0.3.0] - 2026-04-18

### Added

- feat(ops): POST /wake-suspended 临时 endpoint——广播 IPC topic network-up 手动唤醒挂起 session（network-resilience v0.4.0 过渡方案）
- feat(ci-relay): 飞书邮箱轮询 GitHub CI 失败通知，路由到对应 AI session（lib/ci-relay.mjs）
- feat(inbox): offline inbox 持久化到 SQLite，Hub 重启不丢消息（db.mjs inbox 表）
- feat(daemon): Windows Hub 自启自愈守护（bin/hub-daemon.vbs + install-daemon.ps1）
- feat(daemon): CLIProxyAPI 自启自愈守护（bin/cliproxy-daemon.vbs + 拉起失败 IPC 告警）
- feat(daemon): bin/verify-daemons.ps1 手动验证 daemon 自愈能力
- feat(test): Stryker 突变测试配置（8 个 lib 模块，整体 62-99% 区间）
- feat(test): WebSocket E2E 测试 10 个（tests/e2e/websocket.test.mjs）
- feat(test): HTTP API 集成测试 8 个（tests/integration/hub-api.test.mjs）
- feat(test): router 集成测试 30 个，真实 SQLite + 真实 createRouter（tests/integration/router-with-db.test.mjs）
- feat(test): mcp-tools 单元测试 29 个（tests/mcp-tools.test.mjs）
- feat(test): D3 WebSocket ping/pong 心跳集成测试 3 个（tests/integration/heartbeat.test.mjs，总测试 350）
- docs(research): operations.mjs 契约优先设计调研（docs/research/operations-contract-design.md，推荐 shared contract first 渐进式重构）

### Changed

- refactor(hub): 拆分 1174 行 hub.mjs 为五个职责模块（router/http-handlers/feishu-adapter/openclaw-adapter/hub），代码从 D 级升 B 级
- refactor(mcp-server): 抽出 createMcpTools(ctx) 工厂函数到 lib/mcp-tools.mjs，支持单元测试
- refactor(tests): 测试目录重组（tests/*.test.mjs 单元 + tests/integration/ 集成 + tests/e2e/ E2E），集成测试占比从 4% 升到 21%
- chore(deps): npm audit fix 修 4 个漏洞（含 critical protobufjs RCE）
- chore(temp): 测试临时文件统一到 D:/workspace/ai/research/xiheAi/temp/jianmu-ipc/（不污染 C 盘）
- ci: test job 添加 matrix.os 跨 Ubuntu/Windows/macOS

### Fixed

- fix(hub): 文件监控改为仅开发模式（IPC_DEV_WATCH=1），解决代码提交触发 Hub 频繁重启 P0
- fix(router): stub session 未持久化到 SQLite inbox（创建 stub 时直接 inbox:[msg] 丢失持久化）
- fix(router): flushInbox 合并 SQLite+内存消息后按 ts 升序发送（原顺序错）
- fix(docs): POST /send 响应字段名 ok→accepted（文档与代码不一致 P0）
- fix(daemon): install-daemon.ps1 用 cmd /c 包装 wscript 调用，避免 Register-ScheduledTask 参数吞噬（见 ADR-006）
- fix(test): npm test 添加 --test-force-exit，解决 node:test 进程不退出导致 119 秒超时
- fix(test): 移除 --test-isolation=none（性能回归 122 秒→5 秒）

### Docs

- docs(adr): 补齐 5 个 ADR（ADR-002 ~ ADR-006）记录架构决策历史
- docs(readme): 增加 Windows Hub daemon 安装章节（README.md + README.zh-CN.md）
- docs(audit): PRD-Code-Test 对齐审计报告（41 feature，90% 测试覆盖）
- docs: 补齐 ipc_reconnect 工具文档、POST /feishu-reply 等缺失端点文档

## [0.1.0] - 2026-03-28

### Added

- Hub WebSocket server with message routing, offline inbox, topic pub/sub, heartbeat
- MCP Server with 5 tools: ipc_send, ipc_sessions, ipc_whoami, ipc_subscribe, ipc_spawn
- Channel push notifications (claude/channel capability)
- HTTP API: POST /send, GET /health, GET /sessions
- Token authentication (IPC_AUTH_TOKEN)
- OpenClaw adapter
- WSL2 auto-detection
- PowerShell install script

### Fixed

- Duplicate messages, unbounded queue, body size limit, hardcoded paths
- OpenClaw adapter uses HTTP API instead of CLI

[Unreleased]: https://github.com/xihe-forge/xihe-jianmu-ipc/compare/v0.4.1...HEAD
[0.4.1]: https://github.com/xihe-forge/xihe-jianmu-ipc/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/xihe-forge/xihe-jianmu-ipc/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/xihe-forge/xihe-jianmu-ipc/compare/v0.1.0...v0.3.0
[0.1.0]: https://github.com/xihe-forge/xihe-jianmu-ipc/releases/tag/v0.1.0
