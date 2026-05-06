# Codex MCP Wrapper Finalize Report

Time: 2026-05-06T21:37+08:00

Continuation: task #21 after `codex bg bu3ckz3oe` ended at 19:21 with `Selected model is at capacity`, token count about 778k, exit 0 but incomplete ship.

Initial brief continued from:

- `reports/codex-runs/codex-mcp-wrapper-autorestart/brief.md`

## Result

Exit status: PASS.

- `~/.codex/config.toml` now launches `jianmu-ipc` through `mcp-wrapper.mjs`.
- `mcp-wrapper.mjs` restarts `mcp-server.mjs` on crash with capped backoff `1s / 5s / 15s / 60s`.
- Restart pre-announce broadcasts to topic `feedback_portfolio_restart_pre_announce` before child restart.
- Plain Codex sessions with no configured `IPC_NAME` now handshake: wrapper injects stable `IPC_DEFAULT_NAME=mcp-wrapper-<wrapperPid>` into the child env.
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

Finalize also found a second startup truth: Codex CLI does not pass the shell's `IPC_NAME` into the MCP server env when the server config has an explicit env table. Before the fallback-name patch, plain `codex exec` hit `MCP startup failed: timed out handshaking with MCP server after 30s` because the child had no stable name and `mcp-server.mjs` rejected PID fallback. The wrapper now assigns `IPC_DEFAULT_NAME=mcp-wrapper-<wrapperPid>` only when neither `IPC_NAME` nor `IPC_DEFAULT_NAME` is present.

## Commits

jianmu-ipc code commit:

- `2dbf3c62a935a0682517c08cdb9ef5c6acacb891`
- message: `fix: harden codex mcp wrapper restart`
- paths: `mcp-wrapper.mjs`, `tests/mcp-wrapper-auto-restart.test.mjs`, `handover/TODO.md`

final Codex CLI handshake fix commit:

- `5ab3e18f83adf5d75190b8b2877cfd4be0c5244c`
- message: `fix: assign wrapper fallback ipc name`
- paths: `mcp-wrapper.mjs`, `tests/mcp-wrapper-auto-restart.test.mjs`, `handover/TODO.md`

harness SOP commit:

- `f25be513ce81576613a3c9a05d958d6c3a9bf8dc`
- message: `docs: add codex mcp recovery sop`
- path: `domains/software/knowledge/codex-mcp-recovery.md`

harness SOP follow-up commit:

- `e61cceb3284db36c708d7afc686ed67c26a7f371`
- message: `docs: note codex wrapper fallback ipc name`
- path: `domains/software/knowledge/codex-mcp-recovery.md`

Report commits: this file, path-limited.

## Diff Truth

Included in task #21 code commit:

- `mcp-wrapper.mjs`
  - replaced exponential `500ms..16s` restart delay with explicit `[1000, 5000, 15000, 60000]`
  - added `sendRestartPreAnnounce()` HTTP `/send` broadcast
  - pre-announces both child crash restart and source mtime restart
  - uses `process.execPath` for child Node instead of bare `node`
  - assigns `IPC_DEFAULT_NAME=mcp-wrapper-<wrapperPid>` when Codex does not pass a session name
- `tests/mcp-wrapper-auto-restart.test.mjs`
  - covers pre-announce payload
  - covers capped backoff sequence `1s / 5s / 15s / 60s / 60s`
  - covers stability-window reset and intentional restart behavior
  - covers fallback child env and explicit-name preservation
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
tests 12
pass 12
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

No-name MCP SDK dogfood, matching plain Codex env shape:

```json
{
  "ok": true,
  "wrapperPid": 149644,
  "assignedName": "mcp-wrapper-149644",
  "hub": "127.0.0.1:48949"
}
```

Plain Codex CLI dogfood after fallback-name fix:

```text
codex exec --json -m gpt-5.4-mini ... "Call the jianmu-ipc MCP tool named ipc_whoami exactly once..."
```

Codex emitted a real MCP tool call and result:

```json
{
  "server": "jianmu-ipc",
  "tool": "ipc_whoami",
  "result": {
    "name": "mcp-wrapper-160824",
    "hub_connected": true,
    "hub": "127.0.0.1:3179",
    "pending_outgoing": 0
  }
}
```

## Push / Sync

Required push targets:

- `xihe-jianmu-ipc`: `origin/master`
- `xihe-tianshu-harness`: `origin/main`

Required IPC sync after push:

- ack to `jianmu-pm` with commit hashes
- portfolio broadcast that Codex MCP wrapper is online and SOP is in portfolio reference
