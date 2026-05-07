# codex MCP startup + PTY deferred stderr silence

Time: 2026-05-07T21:15+08:00

## Scope

- Fix Codex `jianmu-ipc` MCP startup interruption risk.
- Silence periodic PTY bridge `deferred` diagnostics from stderr by default while preserving file diagnostics.
- Keep true drop / spawn / queue failures visible on stderr.

## Diagnosis

- `codex --help` cold start measured 217ms.
- Stdio MCP handshake measured:
  - direct `mcp-server.mjs`: 651ms
  - `mcp-wrapper.mjs`: 712ms
- Wrapper overhead was ~61ms in this run, so the wrapper layer alone was not the 10s startup-window root cause.
- Hub connection is not a handshake blocker: MCP responds before waiting on the Hub connection path.
- Codex supports MCP startup timeout config:
  - `codex mcp get jianmu-ipc` reports `startup_timeout_sec: 30`
  - local Codex binary contains `startup_timeout_sec` and the timeout guidance string.
- Real risk verified from wrapper behavior: if the child exits during Codex startup, the existing auto-restart path could enter 1s/5s/15s backoff inside Codex's startup window.
- `bin/codex-title-wrapper.mjs` stderr calls were classified:
  - keep visible: usage, PTY spawn failure, session-map write failure, onDrop, queue failure, bridge unavailable
  - silence by default: periodic `pty bridge deferred`

## Fix

- `mcp-wrapper.mjs`
  - Added a 10s startup retry window and one immediate retry for the first unintentional child exit.
  - The immediate retry does not advance the long-run restart backoff.
- Codex startup timeout
  - `~/.codex/config.toml` set to `startup_timeout_sec = 30`.
  - `bin/install.ps1` generated `ipcx` command now passes `-c mcp_servers.jianmu-ipc.startup_timeout_sec=30`.
  - Installer upgrade detection now refreshes existing `ipcx` profile functions if they lack `startup_timeout_sec`.
  - README samples updated.
- `bin/codex-title-wrapper.mjs`
  - Deferred logs now append to `~/.claude/jianmu-ipc-hooks/codex-pty-bridge-{ipcName}.log`.
  - Stderr deferred diagnostics require `IPC_CODEX_PTY_DEBUG_USER_INPUT=1` or existing `IPC_CODEX_PTY_DEBUG_INPUT=1`.
  - onDrop and error-chain stderr paths remain visible.

## Verification

- `powershell -NoProfile -ExecutionPolicy Bypass -File bin\install.ps1` PASS.
- PS5 and PS7 profiles both contain `mcp_servers.jianmu-ipc.startup_timeout_sec=30`.
- `codex mcp get jianmu-ipc` reports `startup_timeout_sec: 30`.
- `node --test tests\mcp-wrapper-auto-restart.test.mjs tests\mcp-wrapper-lifecycle.test.mjs` PASS: 13/13.
- `node --test tests\codex-title-wrapper.test.mjs tests\codex-pty-bridge.test.mjs` PASS: 24/24.
- `node bin\run-tests.mjs tests` PASS.
- Dogfood `ipcx test-silent`:
  - no `MCP startup interrupted` in captured stdout/stderr
  - while typing, no `pty bridge deferred` stderr/banner
  - default log file generated deferred history:
    `C:\Users\jolen\.claude\jianmu-ipc-hooks\codex-pty-bridge-test-silent.log`
  - tail contained `reason=user-input-buffer draft_chars=5 pending=1`
- onDrop retained stderr is covered by `Codex PTY bridge drop remains visible on stderr`.

## Result

Both bugs are closed: startup now has a verified timeout cushion plus startup-crash immediate retry, and deferred PTY diagnostics are quiet by default with a durable log-file trail.
