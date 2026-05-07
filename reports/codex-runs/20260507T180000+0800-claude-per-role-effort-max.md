# Claude IPC per-role effort max ship report

Time: 2026-05-07T19:12+08:00
Repo: `D:\workspace\ai\research\xiheAi\xihe-jianmu-ipc`

## Scope

- Implemented `ipc -Role <role>` in `bin/install.ps1`.
- Governance roles default to Claude Code `--effort max`: `harness`, `director`, `architect`, `jianmu-pm`, `taiwei-pm`, `taiwei-architect`, `taiwei-director`.
- All other roles default to `--effort high`.
- `ipc -Role harness` is supported with omitted name; it uses role as name.
- Existing `ipc <name>` and `ipc <name> -resume ...` behavior remains intact; `--effort` is appended before the existing Claude launch args.

## Launch Diagnosis

- Current helper path remains `D:\workspace\ai\research\xiheAi\xihe-jianmu-ipc\bin\claude-stdin-auto-accept.mjs`.
- Current Claude binary path remains `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`.
- Current canonical launch args are now:
  - governance: `--effort max --dangerously-skip-permissions --dangerously-load-development-channels server:ipc`
  - default: `--effort high --dangerously-skip-permissions --dangerously-load-development-channels server:ipc`
- Local `claude.exe --help` confirms `--effort <level>` supports `low, medium, high, xhigh, max`.
- Local changelog evidence:
  - `~\.claude\cache\changelog.md:439`: `/effort`, `--effort`, and model picker support.
  - `~\.claude\cache\changelog.md:1361`: fixed `--effort` CLI flag reset.
  - `~\.claude\cache\changelog.md:339`: OpenTelemetry usage/API events include `effort`.

## Dogfood

Fresh sessions launched through the installed profile:

- `dogfood-telem-harness-20260507185507 -Role harness`
  - process cmdline: `claude.exe --effort max ... server:ipc`
  - stdout banner: `with max effort`, status bar `max · /effort`
  - reply: `OK_TELEM_MAX`
  - session id: `265bfa3f-7e2e-450f-8dc6-392d53bec838`
  - local OTLP capture:
    - `claude_code.api_request effort=max request=req_011Cao65RfTHr4cXiz3xCGCR`
    - `claude_code.cost.usage effort=max`
    - `claude_code.token.usage effort=max`

- `dogfood-telem-designer-20260507185507 -Role designer`
  - process cmdline: `claude.exe --effort high ... server:ipc`
  - stdout banner: `with high effort`, status bar `high · /effort`
  - reply: `OK_TELEM_HIGH`
  - session id: `ac75e5f7-628f-4256-b936-debec2500a56`
  - local OTLP capture:
    - `claude_code.api_request effort=high request=req_011Cao694VLzfwKYPgbGBQAB`
    - `claude_code.cost.usage effort=high`
    - `claude_code.token.usage effort=high`

Note: current Claude Code 2.1.132 OTLP uses attribute key `effort`; older first-party failed-event payloads use `additional_metadata.effortValue`. No Anthropic profile API call was used.

## Tests

- PASS: `node --test tests/install-ps1.test.mjs` - 23/23
- PASS: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests\ipc-resume-ps.test.ps1 -ShellName PS5 -ShellExe powershell.exe`
- PASS: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests\ipc-resume-ps.test.ps1 -ShellName PS7 -ShellExe "C:\Program Files\PowerShell\7\pwsh.exe"`
- Residual, unrelated full-suite failure: `npm test` still fails `tests/integration/phase3-ac-suite.test.mjs` AC-3/AC-6/AC-7 Codex App Server timeouts. Standalone rerun of that suite reproduces the same three timeouts.

## Files

- `bin/install.ps1`
- `tests/install-ps1.test.mjs`
- `tests/ipc-resume-ps.test.ps1`
- `reports/codex-runs/20260507T180000+0800-claude-per-role-effort-max.md`

Raw dogfood stdout and OTLP capture remain local under `reports/codex-runs/claude-effort-per-role/`; they are not committed because the OTLP capture includes account telemetry attributes.

## Sync

- TODO appended: `handover/TODO.md`
- `jianmu-pm` ack: `msg_1778152713152_ecf786`
- portfolio broadcast: `msg_1778152743988_b366a1`
