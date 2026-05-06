# v3 timestamp drift calc bug patch

时间：2026-05-06T11:32+08:00

## 结论

已实证 root cause，不是猜测：`timestamp-drift-warning.ps1` 的 ISO regex 把 `2026-05-06T09:35:00-10:18` 整体识别为 ISO timestamp，PowerShell `[DateTimeOffset]::Parse` 再把 `-10:18` 当 timezone offset，导致 drift_seconds=59884。

已 patch：range 先于 ISO 解析，`dateTstart-end` 取末尾 timestamp；普通 ISO 8601 含可选 timezone 仍解析；raw ai_ts 进入 audit；range-end 30-60min 按本次任务的保守要求走 warning，不进 governance ledger。普通 scalar ISO 的 >30min governance 行为不变。

## Root Cause Verify

PowerShell parse 实证：

| runtime | input | parsed UTC | +08 view | wall | drift |
|---|---|---|---|---|---|
| PS5 5.1.26100.8115 | `2026-05-06T09:35:00-10:18` | `2026-05-06T19:53:00Z` | `2026-05-07T03:53:00+08:00` | `2026-05-06T11:14:56+08:00` | `59884` |
| PS7 7.6.0 | same | `2026-05-06T19:53:00Z` | `2026-05-07T03:53:00+08:00` | same | `59884` |

Prepatch hook fake stdin：

- tool=`Bash`
- command=`git commit -m "action=governance-ledger ai_ts=2026-05-06T09:35:00-10:18"`
- wall=`2026-05-06T11:14:56+08:00`
- actual output: `action=governance-ledger drift_seconds=59884 ai_ts=2026-05-06T09:35:00-10:18`
- audit details: `ai_ts_kind=iso8601`, `candidate_count=1`

结论：harness 猜测吻合真实执行路径。漂移公式是 `abs(wall_clock.UtcDateTime - candidate.value.UtcDateTime)`，误差来自 candidate 被 offset 误解析。

## Patch

Changed in `xihe-tianshu-harness/domains/software/hooks/timestamp-drift-warning.ps1`:

- `IsoPattern` 改为 timezone offset optional，覆盖 offset-less ISO。
- 新增 `TimestampRangePattern`，在 ISO scan 前识别 `YYYY-MM-DDTHH:MM-HH:MM` / `YYYY-MM-DDTHH:MM:SS-HH:MM`。
- range candidate 扩展为 `dateT<end>:ss<wall offset>`，kind=`iso8601-range-end`，raw 保留原字符串。
- compact dash 的 `-08:00` negative timezone 通过 start/end 顺序防误判：`09:35:00-08:00` 不当 range，继续走 ISO offset。
- audit pass/warning/governance details 都记录 `ai_ts_raw` 和 `ai_ts_kind`。
- range-end drift 在 1801-3600s 内按 warning 处理，并写 `range_hold_reason`；这是为满足本次 57min dogfood “非 governance”要求的保守分流。

Tests changed in `xihe-tianshu-harness/domains/software/hooks/timestamp-drift-warning.test.ps1`:

- 增加 range 秒级 case。
- 增加 HH:MM range case。
- 增加正常 `+08:00` ISO case。
- 增加真实 `-08:00` negative timezone case。
- 增加 offset-less ISO uses wall offset case。

## Dogfood Verify

| case | wall | result |
|---|---|---|
| `2026-05-06T09:35:00-10:18` | `2026-05-06T11:14:56+08:00` | `action=warning`, `drift_seconds=3416`, `ai_ts=2026-05-06T10:18:00+08:00`, `ai_ts_raw=2026-05-06T09:35:00-10:18`, no governance marker |
| `2026-05-06T08:00-09:00` | `2026-05-06T09:06:00+08:00` | `action=warning`, `drift_seconds=360`, end timestamp `09:00:00+08:00` |
| `2026-05-06T09:35:00+08:00` | `2026-05-06T09:41:00+08:00` | `action=warning`, `drift_seconds=360`, `ai_ts_kind=iso8601` |
| `2026-05-06T09:35:00-08:00` | `2026-05-07T01:41:00+08:00` | `action=warning`, `drift_seconds=360`, `ai_ts_kind=iso8601`, not range |

## Test

- PS5: `powershell -NoProfile -ExecutionPolicy Bypass -File .\domains\software\hooks\timestamp-drift-warning.test.ps1` -> 15 PASS / 0 FAIL
- PS7: `pwsh -NoProfile -ExecutionPolicy Bypass -File .\domains\software\hooks\timestamp-drift-warning.test.ps1` -> 15 PASS / 0 FAIL

## Sync

- harness TODO: `xihe-tianshu-harness/handover/TODO.md` appended 2026-05-06T11:32+08 entry.
- cross-repo report: this file.
- jianmu-pm IPC ack: `msg_1778038452028_6b83a1` accepted, online=true, buffered=false.
- portfolio broadcast: skipped by requirement.
