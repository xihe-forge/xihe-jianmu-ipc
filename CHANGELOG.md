# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- deliverToOpenClaw changed from /v1/chat/completions to /hooks/wake for real-time push
- OpenClaw messages always route through /hooks/wake, not WebSocket (even if openclaw session is online)
- patch-channels.mjs supports both old and new trust dialog patterns
- WSL2 interactive spawn uses temp .ps1 file with UTF-8 BOM (fixes encoding issues)
- MCP config changed to ~/.mcp.json auto-load (instead of --mcp-config flag timing issues)
- WSL2 spawn prefers wt.exe (Windows Terminal), falls back to powershell.exe
- Inject --mcp-config with ipc server into spawned CC session
- Patch trust dialog (C2) so spawn does not require manual confirmation

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

[Unreleased]: https://github.com/xihe-forge/xihe-jianmu-ipc/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/xihe-forge/xihe-jianmu-ipc/releases/tag/v0.1.0
