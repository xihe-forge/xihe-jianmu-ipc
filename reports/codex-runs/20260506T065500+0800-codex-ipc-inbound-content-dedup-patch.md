# codex IPC inbound content dedup patch

## Summary

- Removed duplicate inbound content from `formatInboundIpcContent()`: Codex now receives one canonical `← ipc:` line instead of the old two-part payload.
- Simplified PTY bridge instruction: it now refers to "the IPC line above" and no longer repeats another `← ipc:` literal.
- Migrated router app-server fallback marker to the same single `← ipc:` format.
- Updated focused Codex inbound tests and added router fallback coverage.

## Patch

- `mcp-server.mjs`
  - `formatInboundIpcContent()` returns only `← ipc: [<ts> from: <sender>] <content>`.
  - Idle app-server wake text now describes the single `← ipc:` format.
- `lib/codex-pty-bridge.mjs`
  - `formatCodexPtyPrompt()` emits two pipe segments only: the inbound IPC line plus the short handling instruction.
  - The handling instruction no longer repeats the old bracket marker or another `← ipc:` literal.
- `lib/router.mjs`
  - Codex app-server fallback now uses the single `← ipc:` line.
- Tests updated:
  - `tests/codex-idle-wake.test.mjs`
  - `tests/codex-ui-echo.test.mjs`
  - `tests/codex-pty-bridge.test.mjs`
  - `tests/router.test.mjs`

## Verification

- Legacy exact marker grep: 0 tracked hits.
- `node --test --test-isolation=none tests\codex-pty-bridge.test.mjs tests\codex-idle-wake.test.mjs tests\codex-ui-echo.test.mjs tests\router.test.mjs`: PASS, 144 tests.
- `git diff --check`: PASS.

## Dogfood

First live run:

- Session: `codex-ipc-dedup-test`
- Inbound: `jianmu-pm -> codex-ipc-dedup-test`, `msg_1778022319521_0992bb`, 306 bytes
- PTY ack: `codex_pty_push_ok`, `prompt_chars=440`, `ack_sent`
- Reply: `codex-ipc-dedup-test -> jianmu-pm`, `msg_1778022417878_8e2d0e`, content `DEDUP-ACK-070519 ok`

Second live run after final instruction trim:

- Session: `codex-ipc-dedup-test-v2`
- Inbound: `jianmu-pm -> codex-ipc-dedup-test-v2`, `msg_1778022541809_155778`, 289 bytes
- PTY ack: `codex_pty_push_ok`, `prompt_chars=454`, `ack_sent`
- Prompt reconstruction for the exact message:
  - `hasLegacy=false`
  - `ipcLiteralCount=1`
  - `pipeSegments=2`
- Reply: `codex-ipc-dedup-test-v2 -> jianmu-pm`, `msg_1778022558747_2065a1`, content `DEDUP2-ACK-070901 ok`

Token/char saving proxy for the second dogfood payload:

- Old prompt chars: 828
- New prompt chars: 454
- Saved chars: 374
- Reduction: 45.2%

## Notes

- Historical untracked task brief under `reports/codex-runs/codex-ipc-inbound-content-dedup/brief.md` still preserves the original boss/root-cause quote and is not part of the patch.
- The visible PTY path is the dogfood target. App-server fallback remains covered by unit tests.
