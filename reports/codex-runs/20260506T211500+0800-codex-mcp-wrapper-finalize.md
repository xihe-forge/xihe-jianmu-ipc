# Codex MCP Wrapper Finalize Report

Time: 2026-05-06T21:23+08:00

Continuation: task #21 after `codex bg bu3ckz3oe` ended at 19:21 with `Selected model is at capacity`, token count about 778k, exit 0 but incomplete ship.

Initial brief continued from:

- `reports/codex-runs/codex-mcp-wrapper-autorestart/brief.md`

## Result

Exit status: PASS.

- `~/.codex/config.toml` now launches `jianmu-ipc` through `mcp-wrapper.mjs`.
- `mcp-wrapper.mjs` restarts `mcp-server.mjs` on crash with capped backoff `1s / 5s / 15s / 60s`.
- Restart pre-announce broadcasts to topic `feedback_portfolio_restart_pre_announce` before child restart.
- Portfolio SOP landed in harness at `domains/software/knowledge/codex-mcp-recovery.md`.
- Task #19 half-finished files were left out of commits.

## Config Truth

Observed `~/.codex/config.toml` during this continuation:

```toml
[mcp_servers.jianmu-ipc]
command = "D:/software/ide/nodejs/node.exe"
args = ["D:/workspace/ai/research/xiheAi/xihe-jianmu-ipc/mcp-wrapper.mjs"]
```

`codex mcp get jianmu-ipc` also reported:

```text
command: D:/software/ide/nodejs/node.exe
args: D:/workspace/ai/research/xiheAi/xihe-jianmu-ipc/mcp-wrapper.mjs
```

This means the stale RCA state "direct mcp-server launch" was no longer present by the time finalize ran. No extra config rewrite was needed in this continuation; the critical check passed.

## Commits

jianmu-ipc code commit:

- `2dbf3c62a935a0682517c08cdb9ef5c6acacb891`
- message: `fix: harden codex mcp wrapper restart`
- paths: `mcp-wrapper.mjs`, `tests/mcp-wrapper-auto-restart.test.mjs`, `handover/TODO.md`

harness SOP commit:

- `f25be513ce81576613a3c9a05d958d6c3a9bf8dc`
- message: `docs: add codex mcp recovery sop`
- path: `domains/software/knowledge/codex-mcp-recovery.md`

Report commit: this file, path-limited after report creation.

## Diff Truth

Included in task #21 code commit:

- `mcp-wrapper.mjs`
  - replaced exponential `500ms..16s` restart delay with explicit `[1000, 5000, 15000, 60000]`
  - added `sendRestartPreAnnounce()` HTTP `/send` broadcast
  - pre-announces both child crash restart and source mtime restart
  - uses `process.execPath` for child Node instead of bare `node`
- `tests/mcp-wrapper-auto-restart.test.mjs`
  - covers pre-announce payload
  - covers capped backoff sequence `1s / 5s / 15s / 60s / 60s`
  - covers stability-window reset and intentional restart behavior
- `handover/TODO.md`
  - appended task #21 finalize entry with config, dogfood, SOP, and report pointer

Excluded and still uncommitted by design:

- `bin/codex-title-wrapper.mjs`
- `lib/codex-pty-bridge.mjs`
- `mcp-server.mjs`
- `tests/codex-pty-bridge.test.mjs`

These belong to task #19 typing-conflict proposal work and were not included.

## Verification

Targeted wrapper tests:

```text
node --test tests\mcp-wrapper-lifecycle.test.mjs tests\mcp-wrapper-auto-restart.test.mjs
tests 10
pass 10
fail 0
```

Config read:

```text
codex mcp get jianmu-ipc
args: D:/workspace/ai/research/xiheAi/xihe-jianmu-ipc/mcp-wrapper.mjs
```

Real MCP SDK dogfood:

- started temporary Hub on `127.0.0.1:46379`
- started `mcp-wrapper.mjs` through stdio transport with `IPC_RUNTIME=codex`
- initialized MCP client and verified `ipc_whoami`
- killed wrapper-owned `mcp-server.mjs` child pid `153388`
- wrapper logged `scheduling restart in 1000ms`
- wrapper started new child pid `53800`
- Hub re-registered session `codex-wrapper-dogfood-193080`
- the same MCP client transport successfully called `ipc_whoami` after restart
- Hub backlog contained restart pre-announce:
  - id: `msg_1778073686174_4da190`
  - topic: `feedback_portfolio_restart_pre_announce`
  - content included `delay_ms=1000`

Dogfood JSON summary:

```json
{
  "ok": true,
  "ipcName": "codex-wrapper-dogfood-193080",
  "port": 46379,
  "firstPid": 153388,
  "secondPid": 53800,
  "restartDelayMs": 1000,
  "registeredBefore": true,
  "registeredAfter": true,
  "toolAfterRestart": "ipc_whoami ok",
  "preannounceMessageId": "msg_1778073686174_4da190",
  "preannounceTopic": "feedback_portfolio_restart_pre_announce"
}
```

## Push / Sync

Required push targets:

- `xihe-jianmu-ipc`: `origin/master`
- `xihe-tianshu-harness`: `origin/main`

Required IPC sync after push:

- ack to `jianmu-pm` with commit hashes
- portfolio broadcast that Codex MCP wrapper is online and SOP is in portfolio reference

