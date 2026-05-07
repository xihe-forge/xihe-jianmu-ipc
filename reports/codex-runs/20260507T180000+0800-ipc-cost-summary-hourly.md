# ipc_cost_summary hourly granularity

## Summary

- Implemented `ipc_cost_summary(window, group_by, granularity?)`.
- `granularity`: `hour | day`; default is `hour` for `window=today`, `day` otherwise.
- Hourly path reads Claude JSONL transcripts directly and buckets by message start `timestamp` into local-hour labels (`YYYY-MM-DD HH:00 +08:00` on this host).
- `group_by=ipc_name` resolves transcript `sessionId` through `data/messages.db:sessions_history`; unknown sessions fall back to `project/sessionId`.
- Added SQLite cache at `data/ccusage-hourly-cache.db` by default. Cache is file-level incremental via `file_path + size + mtime`, with hourly aggregates stored per file/session/project/model.
- No Anthropic profile/usage API calls were made. ccusage usage stayed offline/library mode.

## Diagnostics

- `npx ccusage daily --json --offline` real schema:
  - top-level `{ daily: [...], totals: {...} }`
  - daily row fields include `date`, `inputTokens`, `outputTokens`, `cacheCreationTokens`, `cacheReadTokens`, `totalTokens`, `totalCost`, `modelsUsed`, `modelBreakdowns`.
  - CLI full run took 76.2s before this patch.
- Transcript schema sampled from `~/.claude/projects/.../*.jsonl`:
  - top-level `timestamp`, `sessionId`, `cwd`, `requestId`, `message`
  - assistant `message.usage.input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`
  - `message.model` is present; many rows do not have top-level `costUSD`, so hourly uses ccusage pricing calculation offline.
- Existing `lib/ccusage-adapter.mjs` had no cache. Daily cache reuse was not possible.
- Portfolio scan size observed:
  - `~/.claude/projects`: 785 JSONL / 0.777GB
  - ccusage full path set observed by adapter: 2320 JSONL / 1.11GB

## Implementation

- `lib/ccusage-adapter.mjs`
  - Added hourly adapter path.
  - Added SQLite cache schema and incremental refresh.
  - Added private pinned ccusage `PricingFetcher` bridge for offline cost calculation; version remains pinned at `ccusage@18.0.11`.
  - Fixed existing local-time bug in daily `windowFilter`: `today` no longer becomes previous UTC date on `+08`.
- `lib/mcp-tools.mjs`
  - Added `granularity` schema and validation.
  - Passes `granularity` through to adapter.
- Docs/tests
  - README and README.zh-CN updated.
  - Contract tests added for hourly buckets, dedup, cache hit, IPC name mapping, and local-date daily `since`.

## Verification

- Focused tests:
  - `node --test tests/ccusage-adapter-contract.test.mjs tests/ipc-cost-summary.test.mjs tests/mcp-tools.test.mjs`
  - Result: 51/51 PASS
- Syntax:
  - `node --check lib/ccusage-adapter.mjs`
  - `node --check lib/mcp-tools.mjs`
  - Result: PASS
- Full suite:
  - `npm test`
  - Result: failed only in existing `tests/integration/phase3-ac-suite.test.mjs` Codex App Server AC-3/AC-6/AC-7 timeouts. Standalone rerun reproduced the same failures. This is unrelated to cost adapter paths.

## Performance

- Cold full scan, empty cache:
  - command path: `getCostSummary({ window: "all", group_by: "none", granularity: "hour" })`
  - files: 2320
  - bytes: 1.11GB
  - rows: 480461
  - usage rows: 86755
  - time: 9.06s
  - RSS: 420MB
- Cache hit on static real-data snapshot:
  - files scanned: 0
  - total time: 10ms
  - query time: 0.5ms
  - RSS: 162MB
- Live incremental today query:
  - active files changed during run, so cache was not a pure hit
  - 33 files considered, 1-7 files rescanned in observed runs
  - total time: 0.52-0.66s

## Dogfood

- Live query generated `window=today`, `group_by=ipc_name`, `granularity=hour`:
  - bucket count: 24
  - group count: 32
  - top groups included `taiwei-pm`, `taiwei-tester`, `harness`, `taiwei-director`, `taiwei-reviewer`, `taiwei-frontend`, `jianmu-pm`.
- Strict sum check used a temporary snapshot of real today JSONL files to avoid active transcript drift:
  - copied 33 files / 93.97MB
  - hourly totals:
    - total tokens: 1,274,244,495
    - total cost: 777.035323
  - hourly bucket sum:
    - total tokens: 1,274,244,495
    - total cost: 777.035325 (6-decimal bucket rounding drift)
  - daily ccusage totals on same snapshot:
    - total tokens: 1,274,244,495
    - total cost: 777.035323
  - exact token match: yes
  - hourly total cost vs daily cost: exact at 6 decimals

## Notes

- Cross-hour long messages are assigned to the message start `timestamp`, matching the requested口径.
- The running MCP process may need normal hot reload/restart before already-connected clients see the new `granularity` schema. The code path is committed in repo and tested through local MCP handler factory.
