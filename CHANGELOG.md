# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.1] - 2026-04-19

### Added

- feat(router): Hub 创 stub session 时立即回发送方 unknown-target 警告（避免消息静默堆积，踩坑案例见 data/hub.log）

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
