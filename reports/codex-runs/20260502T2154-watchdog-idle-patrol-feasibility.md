# watchdog idle-patrol feasibility

Time: 2026-05-02T21:54+08
Repo: xihe-jianmu-ipc

## 1. Task list persistence

Conclusion: feasible.

Evidence:
- Claude Code task files exist under `C:\Users\jolen\.claude\tasks\<sessionId>\*.json`.
- Sample path `C:\Users\jolen\.claude\tasks\55d0970c-6571-4be9-b342-68dc8239f7ad\10.json` was readable by the watchdog user context.
- Schema includes `id`, `subject`, `description`, `activeForm`, `status`, `blocks`, `blockedBy`.

Decision: watchdog can read task list directly. No IPC pull fallback needed for phase 2.

## 2. Transcript jsonl write lag

Conclusion: feasible with 3 minute patrol interval.

Evidence:
- Harness dispatch created `BRIEF-codex-watchdog-idle-patrol-20260502T2154.md` at `2026-05-02T13:55:35Z`.
- Harness transcript `C:\Users\jolen\.claude\projects\D--workspace-ai-research-xiheAi\55d0970c-6571-4be9-b342-68dc8239f7ad.jsonl` recorded the related tool/result/stop events by `2026-05-02T13:55:55Z`.
- Observed lag for this live dispatch sample: about 20 seconds, below the 30 second cutoff.

Decision: use 3 minute patrol interval. It provides at least 6x buffer over the observed lag.

## 3. Multi-session jsonl read race

Conclusion: feasible.

Evidence:
- PowerShell read test used `[System.IO.File]::ReadAllText` across the latest 24 transcript jsonl files.
- Result: `file_count=24`, `errors=0`, `elapsed_ms=179`.

Decision: watchdog can read transcript jsonl files directly. Implementation catches read/parse errors per session so one active writer cannot break the patrol round.

## 4. Session state source of truth

Conclusion: feasible for the required skip/nudge decisions.

Evidence:
- Transcript tail entries include:
  - assistant `message.stop_reason` / top-level `stop_reason`
  - assistant `content[].type="tool_use"` and `content[].name`, including `ScheduleWakeup`
  - user messages with `message.role="user"` and content blocks
  - transcript file `mtime`
- The sampled harness tail showed `stop_reason="tool_use"` for Bash and ScheduleWakeup turns, and `stop_reason="end_turn"` for final assistant text.

Decision: phase 2 can classify `baked`, `ScheduleWakeup`, recent tool use, and last dispatch-like user prompt from transcript tail.

## Decision

Proceed with phase 2 implementation.

Adjustment: L2 timing follows the self-test/IPC text in the brief: L1 dedup 30 minutes, L2 after 30 minutes, L3 after 90 minutes from L1. The implementation starts idle-patrol after the first 3 minute daemon interval, so a watchdog restart does not immediately nudge stale sessions before a full observation window.
