Phase 2 K.Q implementation report
=================================

Q1 classification: fatal cwd-dependent MCP lookup
-------------------------------------------------
1. Installed Claude Code is `@anthropic-ai/claude-code` version `2.1.123`.
2. The npm package exposes `bin/claude.exe`; `cli-wrapper.cjs` is only a
   fallback launcher, so there is no readable JS source path for the channel
   lookup implementation.
3. Text probing `claude.exe` finds the strings
   `--dangerously-load-development-channels`,
   `server:<name>`, and `no MCP server configured`, confirming the warning is
   emitted inside the native binary.
4. `claude mcp list` from `D:\workspace\ai\research\xiheAi` sees both local MCP
   servers and reports `ipc` connected.
5. `claude mcp list` from `C:\Users\jolen` reports no MCP servers configured.
6. Real helper spawn from home cwd reproduced the boss-visible warning:
   `server:ipc ... no MCP server configured with that name`.
7. Real helper spawn from the xiheAi project cwd showed
   `D:\workspace\ai\research\xiheAi` and
   `Listening for channel messages from: server:ipc` with no missing-MCP row.
8. Therefore Q1 is not cosmetic. The channel UI can render from home, but the
   MCP server lookup is missing because project-local `.mcp.json` is not in
   scope.
9. Selected fix: make the installed `ipc` profile function launch the helper
   from `D:\workspace\ai\research\xiheAi` with `Push-Location`/`Pop-Location`.
10. The helper does not filter the warning; it prevents the bad lookup state.

Q1 implementation
-----------------
- `bin/install.ps1` now generates an `ipc` function that sets `$projectRoot` to
  `D:\workspace\ai\research\xiheAi`, pushes that location, invokes the Node
  helper plus `claude.exe`, and always pops the original location.
- Installed profiles were updated to the same generated shape:
  `C:\Users\jolen\Documents\PowerShell\Microsoft.PowerShell_profile.ps1` and
  `C:\Users\jolen\Documents\WindowsPowerShell\Microsoft.PowerShell_profile.ps1`.
- PS7 profile smoke from `C:\Users\jolen`: exit 0, rendered project cwd,
  channel listener present, no missing-MCP warning.
- Windows PowerShell 5 profile smoke from `C:\Users\jolen`: exit 0, rendered
  project cwd, channel listener present, no missing-MCP warning.

Q2 sanitizer and raw log
------------------------
- `bin/claude-stdin-auto-accept.mjs` expands the blank-fill sanitizer from
  `CSI H` only to cursor-positioning forms `H`, `f`, `d`, `G`, and `A` when
  followed by at least 100 spaces.
- The sanitizer still rewrites the matched blank-fill sequence to
  `CSI 2J` plus `CSI H`.
- The 100-space floor keeps normal Claude cursor movement outside the match.
- The K.P regression sequence remains covered:
  `CSI H + 2040 spaces + CRLF + CSI K + CSI 120C`.
- `IPC_HELPER_RAW_LOG` enables append-mode raw PTY capture before stdout
  sanitization. This gives a direct fallback for a future VSCode-specific
  pattern miss.
- Raw log smoke wrote `temp/kq-real-raw-pty.log` with 3952 bytes.

Raw log usage
-------------
```powershell
$env:IPC_HELPER_RAW_LOG = 'D:\tmp\vscode-pwsh-raw.log'
ipc test-q2-capture
```

VSCode title caveat
-------------------
- Local VSCode 1.110.1 resources show the default
  `terminal.integrated.tabs.title` is `${process}`.
- VSCode stores OSC title sequences as `sequence`, but the default tab title
  template does not display `${sequence}`.
- The helper still emits and rewrites OSC 0/1/2 titles to `IPC_NAME`; if a
  VSCode tab remains unchanged, a fresh terminal session and VSCode title
  configuration should be checked before treating it as a helper regression.

TDD and verification
--------------------
- RED commit: `b0a95cc test(ipc): cover K.Q helper cwd and PTY sanitizing`.
- New K.Q suite:
  `node --test tests\claude-stdin-auto-accept-q1q2-fix.test.mjs`
  EXIT=0, 5/5 pass.
- Install profile suite:
  `node --test tests\install-ps1.test.mjs`
  EXIT=0, 10/10 pass.
- Helper regression bundle:
  `node --test tests\claude-stdin-auto-accept-tab-title.test.mjs
  tests\claude-stdin-auto-accept-pty.test.mjs
  tests\claude-stdin-auto-accept-real-pty-confirm.test.mjs
  tests\claude-stdin-auto-accept-persistent-flags.test.mjs
  tests\claude-stdin-auto-accept-multi-prompt.test.mjs
  tests\spawn-stdin-auto-accept.test.mjs`
  EXIT=0, 25/25 pass.
- Full `pnpm test`: EXIT=0.
- Targeted post-report verification:
  `node --test tests\claude-stdin-auto-accept-q1q2-fix.test.mjs
  tests\install-ps1.test.mjs
  tests\claude-stdin-auto-accept-expect.test.mjs`
  EXIT=0, 19/19 pass.
