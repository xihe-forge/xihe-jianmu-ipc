# v3 timestamp hook emergency patch

时间：2026-05-06T07:37+08:00

## 结论

已选 E：紧急 hold `sensitive-audit-warning` 档。`61-300s` drift 现在全部只写 audit log，不再 stderr warning，不再 IPC harness / 老板 inbox。`>300s` warning 和 `>1800s` governance ledger 原样保留。

## 诊断

- 实现位置：`xihe-tianshu-harness/domains/software/hooks/timestamp-drift-warning.ps1`
- active install：`C:\Users\jolen\.claude\settings.json` 直接执行 harness 仓 ps1，改仓库文件后下一次 PostToolUse 即生效。
- 审计日志：`C:\Users\jolen\.claude\jianmu-ipc-hooks\audit\timestamp-drift-2026-05-06.log`
- 05:23-07:19 非 IPC 审计事件 62 条：
  - `sensitive-audit-warning` 48 条，其中 47 条成功发 IPC，1 条 timeout。
  - 42/48 在 61-180s，符合 AI IPC compose / Write 正常链路延迟。
  - 8/48 来自 `Write`，说明文档落盘的 1-3min latency 也被误打为老板可见 IPC。
  - `warning` 10 条，全部在 301-1800s；该档仍有用，不能误关。
  - `governance-ledger` 1 条，drift=2702s；该档仍需保留治理总账。

## 决策

没有选 D。D 会同时改阈值、tool scope、敏感词，适合后续精修，但紧急止血场景会引入更多行为变化。

选 E 的原因：真实噪音集中在 1-3min，且 root cause 是正常工作链路 latency，不是叙事时间累加。E 的 blast radius 最小，只改变 `<=300s` 的 escalation，不碰 5-30min 和 >30min 高信号路径。

## Patch

- `61-300s` 分支改为统一 `Write-AuditEvent -Kind audit`。
- audit details 保留 `sensitive_text = Test-SensitiveText $text`，后续仍可做 baseline。
- audit details 加 `hold_reason = sensitive-audit-warning emergency hold: 1-5min drift is audit-only`。
- 自测 case 3 从“敏感低漂移应 IPC”改为“敏感低漂移 audit-only”。

## Verify

- PS5：`powershell -NoProfile -ExecutionPolicy Bypass -File domains\software\hooks\timestamp-drift-warning.test.ps1` -> 10 PASS / 0 FAIL
- PS7：`pwsh -NoProfile -ExecutionPolicy Bypass -File domains\software\hooks\timestamp-drift-warning.test.ps1` -> 10 PASS / 0 FAIL

Dogfood capture：

| case | result |
|---|---|
| 2min sensitive drift (`老板 ship ... 07:28`, wall clock `07:30`) | `audit_kinds=audit`, `audit_lines=1`, `ipc_lines=0` |
| 6min drift | `audit_kinds=warning,ipc`, `ipc_lines=1` |
| 31min drift | `audit_kinds=governance-ledger,ipc`, `ipc_lines=1`, marker present |

老板 inbox 结论：1-3min sensitive drift 已不走 `Send-IpcWarning`，capture 验证 `ipc_lines=0`；active install 又直接指向 harness 仓 ps1，所以后续 1-3min AI latency 不再弹 IPC。

## 后续

继续保留 audit baseline。若未来 181-300s 内出现真实叙事漂移，再评估 D 的 tool scope / 敏感词精简，不在本次止血里扩大改动面。
