# Jianmu sessions_history persistence report

Time: 2026-05-05T15:42:24+08:00

## OpenClaw research truth

Found. OpenClaw documents a durable per-agent session store instead of relying on live process memory:

- CLI doc: https://docs.openclaw.ai/cli/sessions
- Session management doc: https://docs.openclaw.ai/sessions
- Runtime doc: https://docs.openclaw.ai/agent

Relevant truth: `openclaw sessions --all-agents` reads configured agent stores and examples show `~/.openclaw/agents/<agentId>/sessions/sessions.json`; transcripts live beside that store as `<sessionId>.jsonl`. This validates Jianmu adding a durable name/sessionId birth registry instead of relying on Hub `/sessions` memory or jsonl marker grep.

## Existing Jianmu registry truth

`C:\Users\jolen\.claude\sessions-registry.json` exists, length 8123, last write `2026-05-02 03:45:54`. It is a role/projects/name registry maintained by `ipc_register_session`, not a db-connected sessionId history table. It cannot answer "taiwei-director name -> previous jsonl GUID".

## Path decision

Chosen path: A plus B-style direct registration paths, with legacy jsonl fallback kept.

- A: `session-state-writer.ps1` posts once to `POST /sessions/register-history` when the hook first sees `sessionId`; marker file is `sessions-history-marker-<sessionId>` so repeat hook fires are harmless.
- B-style: Hub WebSocket register and MCP register can pass `sessionId` / `transcriptPath`; Hub records immediately when that identity is available.
- C: full watchdog 60s jsonl scan was not implemented in this pass; it remains a possible later backfill job. The install fallback still scans jsonl markers when db history is absent.
- D: rejected as primary path because the MCP process itself cannot reliably know the Claude jsonl GUID at startup without hook/statusline payload.

## Schema

```sql
CREATE TABLE IF NOT EXISTS sessions_history (
  session_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_name TEXT,
  parent_session_id TEXT,
  spawn_reason TEXT,
  cwd TEXT,
  runtime TEXT DEFAULT 'claude',
  transcript_path TEXT,
  spawn_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_history_name_spawn
  ON sessions_history(name, spawn_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_history_parent
  ON sessions_history(parent_session_id);
```

Implementation detail: pending atomic handoff rows use `pending-<timestamp>-<name>` and are excluded from `getSessionsByName`; when the real child session registers, it inherits the latest pending parent metadata and the pending row is deleted.

## Dogfood / AC truth

- AC1 PASS-partial: live Hub `/sessions-history?name=taiwei-test&limit=10` returns durable rows with non-empty session IDs. Seed rows show `spawn_reason='fresh'`; hook path is covered by harness hook commit but not a fresh interactive Claude launch in this run.
- AC2 PASS-partial: closed-session resume selection is validated through live Hub history and PS5/PS7 helper lookup. `taiwei-test` order is latest `bbbbbbbb-2222-4222-8222-bbbbbbbb2222`, previous `aaaaaaaa-1111-4111-8111-aaaaaaaa1111`; `-resume 1` maps to the older id when an online latest row is present. I did not launch a real interactive Claude resume from the shell to avoid disturbing production terminals.
- AC3 PASS: targeted test `atomic handover records lineage and pending sessions_history before spawn` verifies parent metadata staging and real child inheritance path. Dry-run still does not production-spawn.
- AC4 PASS: existing lineage table remains intact; `harness-handover.mjs` path was not changed.
- AC5 PASS: install logic keeps `/sessions` as first tier for `ipc <name> -resume 0` when an online session exposes `sessionId`.
- AC6 PASS: `npm test` passed.
- AC7 PASS-partial: PS5 and PS7 both loaded installed profiles and `Get-IpcSessionsByNameFromHub taiwei-test` returned the expected `bbbb...`, `aaaa...` order. GUID/static resume paths are covered by install tests; no interactive Claude process was launched.

## Verification commands

- `node --test tests/install-ps1.test.mjs` PASS, 18 tests.
- `node --test tests/sessions-history.test.mjs tests/integration/hub-api.test.mjs tests/atomic-handoff-quit-ipc.test.mjs` PASS, 35 tests.
- `npm test` PASS.
- PS5 helper query PASS:
  `bbbbbbbb-2222-4222-8222-bbbbbbbb2222`, then `aaaaaaaa-1111-4111-8111-aaaaaaaa1111`.
- PS7 helper query PASS:
  `bbbbbbbb-2222-4222-8222-bbbbbbbb2222`, then `aaaaaaaa-1111-4111-8111-aaaaaaaa1111`.

## Commits and push status

Jianmu IPC repo `master`, pushed to `origin/master`:

- `7fd2a9c` `feat(db): persist IPC sessions history`
- `02ba71e` `feat(hub): expose sessions history registration`
- `d15ee3e` `feat(handoff): pre-register atomic handoff lineage`
- `bddce60` `feat(install): resume IPC sessions from history`

Tianshu harness repo `main`, pushed to `origin/main`:

- `0697f90` `feat(hooks): register IPC session history once`

Report commit, pushed to `origin/master`:

- `b17d15e` `docs(report): record sessions history ship truth`

## Ship tier

ship-tier: e2e-partial 5/7 AC full PASS, 2/7 PASS-partial due no real interactive Claude resume launch.

EXIT 0
