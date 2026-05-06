# v3 drift bug recurrence real fix

时间：2026-05-06T12:03+08:00

## 结论

真因选 C，B 是覆盖缺口，A 证伪。

11:49 复刻不是 full ISO range `2026-05-06T11:33:00-11:47` 没修到；真实 audit 里 `ai_ts_raw` 是裸短时间 range `11:33-11:47`，`ai_ts_kind=short-time-today`，被旧 `ShortTimePattern` 当成 `11:33` + timezone offset `-11:47`，所以 drift 算成 `70203s` 并误进 governance ledger。

task #17 patch 失败原因：只在 ISO/range scan 前覆盖了 `YYYY-MM-DDTHH:MM-HH:MM` 形态，没有在 short-time timezone parser 前拦截 `HH:MM-HH:MM`。dogfood 4 case 没覆盖真实 raw 裸短 range，也没覆盖跨日期 range。

## 诊断实证

- 复刻 IPC 审计真值：`C:\Users\jolen\.claude\jianmu-ipc-hooks\audit\timestamp-drift-2026-05-06.log` 11:49:57 行显示 `ai_ts_raw=11:33-11:47`、`ai_ts_kind=short-time-today`、`ai_ts=2026-05-06T11:33:00-11:47`、`drift_seconds=70203`。
- 现磁盘 ded95fb 直接喂 full-date `2026-05-06T11:33:00-11:47`：结果 `drift_seconds=177`、`ai_ts=2026-05-06T11:47:00+08:00`、`ai_ts_kind=iso8601-range-end`，audit-only，无 IPC。
- 现 `.test.ps1` 旧 15 case PASS，但 `rg` 显示未覆盖 `11:33:00-11:47`、跨日期 `2026-05-05T23:30-2026-05-06T01:00`、裸 `11:33-11:47`。
- hot reload 检查：`settings.json` 活跃命令直接指向 `D:/workspace/ai/research/xiheAi/xihe-tianshu-harness/domains/software/hooks/timestamp-drift-warning.ps1`；排除当前查询后没有常驻 `powershell/pwsh ... timestamp-drift-warning.ps1` 进程。A 不是本次根因。

## Patch

`timestamp-drift-warning.ps1`：

- `TimestampRangePattern` 扩成通用 range parser，先于 ISO 和 short-time timezone parser 执行。
- 支持 `HH:MM-HH:MM`、`HH:MM:SS-HH:MM`、`HH:MM:SS-HH:MM:SS`、`YYYY-MM-DDTstart-end`、`YYYY-MM-DDTstart-YYYY-MM-DDTend`。
- 裸短时间 range 用 wall-clock date 扩展到 end timestamp，kind=`short-time-range-end`。
- 带日期 range 保持 kind=`iso8601-range-end`。
- 明确 end date 的跨日期 range 取 end date；真实 negative timezone `2026-05-06T09:35:00-08:00` 因 end<=start 且无 end date，不当 range，继续走 scalar ISO。

## Verify

- PS5：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\domains\software\hooks\timestamp-drift-warning.test.ps1` -> 22 PASS / 0 FAIL。
- PS7：`pwsh -NoProfile -ExecutionPolicy Bypass -File .\domains\software\hooks\timestamp-drift-warning.test.ps1` -> 22 PASS / 0 FAIL。
- 修后真实 raw 直接复刻：`director 11:33-11:47` + wall `2026-05-06T11:49:57+08:00` -> `drift_seconds=177`、`ai_ts=2026-05-06T11:47:00+08:00`、`ai_ts_kind=short-time-range-end`、audit-only、IPC 空。

## Dogfood 6

全部在 PS5/PS7 测试输出中 PASS：

| case | expected |
|---|---|
| `2026-05-06T09:35:00-10:18` | end `10:18:00+08:00`, drift `3416`, warning, no governance |
| `2026-05-06T11:33:00-11:47` | end `11:47:00+08:00`, drift `177`, audit-only |
| `2026-05-06T08:00:00-09:00:00` | end `09:00:00+08:00`, drift `360`, warning |
| `2026-05-05T23:30-2026-05-06T01:00` | explicit end date `2026-05-06T01:00:00+08:00`, one range candidate |
| `2026-05-06T09:35:00-08:00` | scalar ISO, not range, drift `360` |
| `2026-05-06T09:35:00+08:00` | scalar ISO, not range, drift `360` |

额外回归：真实 audit raw `11:33-11:47` -> short-time range end, not timezone offset.

## Sync

- harness code patched and tested.
- `handover/TODO.md` appended in `xihe-jianmu-ipc` and `xihe-tianshu-harness`.
- report written to both repos at `reports/codex-runs/20260506T115100+0800-v3-drift-bug-recurrence-real-fix.md`.
- jianmu-pm IPC ack sent after push.
- portfolio broadcast skipped by requirement.
