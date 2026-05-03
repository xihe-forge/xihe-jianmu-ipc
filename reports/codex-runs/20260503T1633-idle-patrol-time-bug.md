# idle-patrol time bug patch

Time: 2026-05-03T16:36+08:00

## Result

PASS: patched idle-patrol time calculation so epoch/invalid action evidence cannot produce 5-digit idle minutes. Live dry-run used real Hub sessions and mock `ipcSend`; it produced 0 bad minute messages and wrote no real IPC.

## Patch

- `newestActionAt` now includes `transcript.lastUserAt`, so a valid dispatch/user timestamp is a trusted action anchor when no tool/commit/outbound evidence exists.
- Added `DEFAULT_MAX_TRUSTED_IDLE_MS = 7 days`.
- `evaluateIdlePatrolSession` skips with `untrusted-action-time` when action time is missing, non-finite, in the future, or older than the sanity window.
- `idleMinutes` is computed from the already validated idle age.

## Verification

- `node --test tests/watchdog-idle-patrol.test.mjs`: PASS 11/11.
- New regression: transcript missing / timestamp unavailable skips and sends 0 IPC.
- New regression: action time older than 7 days skips and sends 0 IPC.
- Live dry-run: 25 sessions evaluated, 2 mock nudges, 23 skips, 0 errors, 0 messages matching `\b\d{5,}min\b`.
- Live dry-run sample nudge: `xihe-ai 你 4min ...`, confirming minute values are bounded and current.
- SQLite check: latest real `topic='idle-patrol'` row remained the pre-run harness ack at `2026-05-03 08:34:12`; no real dry-run IPC was inserted.

## Restart

Daemon was not restarted. The running watchdog must be restarted by harness/boss to load this module change.
