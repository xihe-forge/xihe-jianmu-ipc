Phase 2 K.S implementation report
=================================

Codex CLI PTY truth evidence
----------------------------
1. Probe command: real `codex --dangerously-bypass-approvals-and-sandbox`
   in a real `@lydell/node-pty` PTY, no synthetic key input.
2. Codex CLI version: `codex-cli 0.125.0`.
3. Codex process tree when cwd=`D:\workspace\ai\research\xiheAi`:
   `powershell.exe -> node.exe codex.js -> codex.exe -> node.exe mcp-server.mjs`.
4. Codex process tree when cwd=`C:\Users\jolen` has the same MCP child:
   `node.exe mcp-server.mjs`.
5. `codex mcp list` from `D:\workspace\ai\research\xiheAi` reports
   `jianmu-ipc` enabled from user config.
6. `codex mcp list` from `C:\Users\jolen` also reports `jianmu-ipc` enabled.
7. Adding `-c 'mcp_servers.jianmu-ipc.env.IPC_NAME="test-ks-list"'`
   preserves the configured command/args and adds `IPC_NAME` to env.
8. Root PTY capture had 17 OSC title sequences.
9. Root OSC titles were `powershell.exe`, then `xiheAi`, then repeated spinner
   titles such as `<spinner> xiheAi`, ending at `xiheAi`.
10. Home PTY capture had 17 OSC title sequences.
11. Home OSC titles were `powershell.exe`, then `jolen`, then repeated spinner
    titles such as `<spinner> jolen`, ending at `jolen`.
12. Neither raw capture contained the requested IPC names
    `test-ks-pty-root` or `test-ks-pty-home` in OSC title output.
13. Therefore a one-shot PowerShell title write before launching Codex would
    be overwritten by Codex's own repeated title OSC output.
14. Root capture UI displayed directory `D:\workspace\ai\research\xiheAi`.
15. Home capture UI displayed directory `~`.
16. Both captures displayed `Booting MCP server: jianmu-ipc`.
17. Neither capture displayed `no MCP server configured`.
18. Selected fix: keep `ipcx` in the project root and add a Codex-specific PTY
    wrapper that rewrites child OSC 0/1/2 titles to `IPC_NAME`.
19. Reusing `claude-stdin-auto-accept.mjs` was rejected because it schedules
    Claude-specific Enter auto-accept behavior.
20. New wrapper is intentionally narrow: spawn child in PTY, rewrite title OSC,
    forward stdin/stdout/resize, and preserve child exit code.
21. Generated `ipcx` now sets `$env:IPC_NAME = $Name`.
22. Generated `ipcx` now `Push-Location`s to `D:\workspace\ai\research\xiheAi`.
23. Generated `ipcx` uses `try/finally` with `Pop-Location`.
24. Generated `ipcx` runs `codex.cmd` through `bin/codex-title-wrapper.mjs`.
25. Generated `ipcx` still passes `-c mcp_servers.jianmu-ipc.env.IPC_NAME`.
26. Existing `ipc` function and Claude helper flow were not changed.
27. Live PS5 profile was patched after confirming `.bak.20260430T0208` exists.
28. Live PS7 profile was patched after confirming `.bak.20260430T0208` exists.
29. Profile dot-source parse checks passed for both PowerShell 5 and PowerShell 7.
30. Manual WT/VSCode visual verification remains owner-facing and should be run
    after reloading the profile.

Implementation
--------------
- RED commit: `0e11a58 test(install): cover K.S ipcx codex title and cwd`.
- Added `bin/codex-title-wrapper.mjs`.
- Updated `bin/install.ps1` ipcx generation.
- Updated `package.json` package file list.
- Patched live profiles:
  `C:\Users\jolen\Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1`
  and `C:\Users\jolen\Documents\PowerShell\Microsoft.PowerShell_profile.ps1`.

Verification
------------
- RED `node tests\install-ps1.test.mjs`: EXIT=1, 12/15 pass, 3 expected fail.
- RED `node tests\codex-title-wrapper.test.mjs`: EXIT=1, wrapper file missing.
- GREEN `node tests\install-ps1.test.mjs`: EXIT=0, 15/15 pass.
- GREEN `node tests\codex-title-wrapper.test.mjs`: EXIT=0, 4/4 pass.
- Related regression:
  `node tests\claude-stdin-auto-accept-q1q2-fix.test.mjs`: EXIT=0, 5/5 pass.
- Related regression:
  `node tests\claude-stdin-auto-accept-tab-title.test.mjs`: EXIT=0, 5/5 pass.
- Related regression:
  `node tests\spawn-stdin-auto-accept.test.mjs`: EXIT=0, 3/3 pass.
- Related regression:
  `node tests\ipc-spawn-codex.test.mjs`: EXIT=0, 9/9 pass.
- Full `pnpm test`: EXIT=0.
- Automated PS5/PS7 generated-function PTY smoke artifact:
  `reports/codex-runs/phase2-ks-codex-cli-tab-title-cwd/smoke-pty-summary.json`.
- Automated PS5/PS7 live-profile PTY smoke artifact:
  `reports/codex-runs/phase2-ks-codex-cli-tab-title-cwd/smoke-profile-summary.json`.
- In live-profile smoke, running phase for PS5 and PS7 had `badTitleCount=0`,
  `containsProjectDirectory=true`, `containsBootingMcp=true`, and
  `containsNoMcpConfigured=false`.
