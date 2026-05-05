# fix sessions_history lifecycle bug

ship-tier: e2e-full

## Boss repro truth

- Command sequence: `ipc taiwei-resume-test`, close, `ipc taiwei-resume-test`, close, then `curl http://127.0.0.1:3179/sessions-history?name=taiwei-resume-test`.
- Observed row count: 1.
- Observed row:
  `{"sessionId":"f3f935f7-5ec9-4a9b-9bfd-144263e605b6","name":"taiwei-resume-test","spawnReason":"fresh","runtime":"unknown","spawnAt":1777967815713,"lastSeenAt":1777967820514,"endedAt":1777967820514}`
- Missing transcript: `C:\Users\jolen\.claude\projects\D--workspace-ai-research-xiheAi\f3f935f7-5ec9-4a9b-9bfd-144263e605b6.jsonl` did not exist.
- Time window: 2026-05-05 15:56:55 to 15:57:00 Asia/Shanghai, about 5 seconds.

## f3f935f7 grep truth

- `C:\Users\jolen\.claude\session-env\f3f935f7-5ec9-4a9b-9bfd-144263e605b6\sessionstart-hook-0.sh` exists and contains `CODEX_COMPANION_SESSION_ID='f3f935f7-5ec9-4a9b-9bfd-144263e605b6'`.
- No matching project transcript jsonl exists under `C:\Users\jolen\.claude\projects\D--workspace-ai-research-xiheAi`.
- Other hits were task briefs, Codex/Claude logs, and the boss pasted curl output. No old transcript file was found.

## Portfolio settings truth

Before fix, all 7 checked settings files had no `hooks.SessionStart` entry pointing to `session-state-writer.ps1`.

After fix, all 7 are registered:

- `D:\workspace\ai\research\xiheAi\.claude\settings.json`
- `D:\workspace\ai\research\xiheAi\heartreadAI\.claude\settings.json`
- `D:\workspace\ai\research\xiheAi\lumidrive-novel\.claude\settings.json`
- `D:\workspace\ai\research\xiheAi\lumidrive-site\.claude\settings.json`
- `D:\workspace\ai\research\xiheAi\xihe-ai\.claude\settings.json`
- `D:\workspace\ai\research\xiheAi\xihe-company-brain\.claude\settings.json`
- `D:\workspace\ai\research\xiheAi\xihe-houtu-seeds\.claude\settings.json`

Backups were created as `.claude\settings.json.bak-20260505T161440` before editing.

## mcp-server cache decision tree

`findSelfTranscriptPath` now resolves in this order:

1. `CLAUDE_TRANSCRIPT_PATH` or `TRANSCRIPT_PATH`.
2. Startup-instance cache: `.claude/mcp-server-cache/parent-${ppid}-${ipcName}-${startedAt}.json`; cache must point to an existing transcript and its basename must match cached `sessionId`.
3. `.claude/sessions/${pid}.json` with explicit existing `transcriptPath`.
4. `.claude/sessions/${pid}.json` with `sessionId` fallback only if the derived project jsonl file already exists.
5. Birthtime detection in the current Claude project directory, within 60 seconds.

The old cross-startup cache key was `parent-${ppid}-${ipcName}.json`, which could be reused across launches with the same parent/name. The new key adds `startedAt`.

## RCA

- Layer 1 hit: portfolio SessionStart hook was not registered, so boss run only hit WebSocket register and wrote `fresh/unknown`.
- Layer 2 hit: mcp-server could synthesize a transcript path from `.claude/sessions/<pid>.json` before the jsonl existed, producing wrong sessionId/transcriptPath rows.
- Layer 3 symptom: duplicate/wrong sessionId plus `INSERT OR IGNORE` leaves only one row.

Fixes:

- Added `SessionStart` hook registration to the 7 portfolio settings files.
- Changed `session-state-writer.ps1` to register history only when `transcriptPath` exists as a real file.
- Changed `mcp-server.mjs` cache key to include `startedAt`, validate cached basename, and require derived `.claude/sessions/<pid>.json` transcript fallback to exist.
- Added hook-discovery upgrade logic in `recordSessionSpawn` so a later hook can upgrade an earlier `fresh` row for the same true sessionId without changing `INSERT OR IGNORE`.

## E2E AC truth

- AC1: PASS. `ipc taiwei-bug-test` with prompt created session `85b11e95-7b65-42c5-9c17-659f54ecec7b`; transcript exists at `C:\Users\jolen\.claude\projects\D--workspace-ai-research-xiheAi\85b11e95-7b65-42c5-9c17-659f54ecec7b.jsonl`.
- AC2: PASS. Second run created `78ea2170-e125-4c7c-a455-7aac42304708`; `/sessions-history?name=taiwei-bug-test` returned 2 rows with different sessionIds.
- AC3: PASS. Both rows have `spawnReason="hook-discovery"` and `runtime="claude"`.
- AC4: PASS. `ipc taiwei-bug-test -resume 1` appended `taiwei-bug-test-resume-1` to first session jsonl `85b11e95-7b65-42c5-9c17-659f54ecec7b.jsonl`; file length changed from 19100 to 26293.
- AC5: PASS. All 7 portfolio settings files have `SessionStart` registered to `session-state-writer.ps1`.
- AC6: PARTIAL PASS. `node --test` ran 943 tests: 942 pass, 1 failed in `tests/claude-stdin-auto-accept-real-pty-confirm.test.mjs` due event order flake. Immediate rerun of that exact file passed 4/4.

## Verification

- Focused tests passed: `node --test tests\mcp-server-self-transcript.test.mjs tests\sessions-history.test.mjs tests\integration\hub-api.test.mjs` passed 37/37 after final fixes.
- Full baseline: `node --test` had one flaky failure, then the failed file passed on rerun.
- Lifecycle raw logs are under `reports/codex-runs/lifecycle-raw/`.

## Commit and push

- jianmu commit: `d42438d` (`fix(mcp): require real transcript for session history`).
- harness commit: `11ccee7` (`fix(hooks): register history only for real transcripts`).
- Push status: pending at report update.

EXIT 0
