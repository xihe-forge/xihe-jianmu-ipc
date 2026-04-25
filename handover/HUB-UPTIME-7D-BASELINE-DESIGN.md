# Hub `/health` 7 天 uptime 基线测量设计

**日期**：2026-04-25
**作者**：jianmu-pm
**状态**：草案 v0.1 · 等 harness review + 老板拍排期
**目标**：PROJECT-PLAN.md §六度量指标 "Hub /health uptime > 99%" 跑 7 天基线后复核
**触发**：v0.5.0 已 ship，jianmu-ipc 仓进入运营期，需建立量化健康基线作为 v0.6.0 改进依据
**ETA 跑测**：2026-05-01 至 2026-05-08 共 7×24h 基线窗口

---

## 1. 目标

将 Hub 守护进程的"经验觉得稳"转换成**量化指标**，作为：

- **Release gate**：v0.6.0 之前必须证明 v0.5.0 在生产负载下达 uptime > 99%
- **回归检测基线**：未来任何 Hub 改动可对比基线，量化是否引入退化
- **故障预警阈值**：watchdog `committed_pct` / `available_ram_mb` / `phys_ram_used_pct` 已有运行时阈值，缺**长期趋势基线**（短期波动 vs 长期偏移区分）
- **portfolio 治理证据**：harness 治理层用作 "Hub 健康"客观度量，replace 主观印象

**不在本 baseline 测量**（留 v0.6.0 后续）：
- Hub 写入吞吐 QPS（需压测，本 baseline 是观察期数据）
- WebSocket 消息往返 latency（需埋点 trace，复杂度高）
- 消息持久化丢失率（需 audit replay，留独立专项）

---

## 2. 数据源

### 2.1 Hub `GET /health`（主数据源）
返回示例：
```json
{
  "status": "ok",
  "sessionCount": N,
  "messageCount": M,
  "uptime": <seconds>,
  "version": "...",
  ...
}
```
**采集字段**：`status` / `sessionCount` / `messageCount` / `uptime`

### 2.2 network-watchdog `GET http://127.0.0.1:3180/status`（辅助）
返回 `{ state, failing, lastChecks, uptime, harness }`。
**采集字段**：`lastChecks.hub.{ok, connected, ms}` / `lastChecks.committed_pct` / `lastChecks.phys_ram_used_pct` / `state`

### 2.3 `data/hub.log`（事件流）
**采集事件**：
- WebSocket reconnect events（grep "reconnect"）
- `reclaim_evict` audit events（ADR-008）
- `push_deliver` audit events（ADR-009）
- `[housekeeping] OK` 心跳（hub-daemon.vbs 时间盒每 10min 一条）
- ERROR 行计数

### 2.4 SQLite `data/messages.db`（持久化健康）
**采集字段**：
- 文件 size 增长
- WAL checkpoint 频率
- messages 表 row count 增量
- inbox 表 row count

### 2.5 `wscript.exe` / `node.exe` 进程数（系统层）
**采集**：`Get-Process` 或 `tasklist` 计 wscript（hub-daemon 时间盒后预期 ≤ 2 持续态）+ node hub.mjs PID。

---

## 3. 测量指标

| 指标 | 来源 | 目标 | 计算 |
|---|---|---|---|
| **Hub uptime %** | /health status=ok 比例 | > 99% | (status=ok 采样数 / 总采样数) × 100% |
| **Hub /health 响应耗时** | watchdog lastChecks.hub.ms | p50 < 50ms / p95 < 200ms | 7 天采样分布 |
| **WS reconnect 频率** | hub.log "reconnect" grep | < 5 次/天/session | 日均统计 |
| **SQLite size 增长** | data/messages.db ls -la | < 50MB/周 | 7 天差量 |
| **WAL checkpoint 间隔** | data/messages.db-wal mtime 变化 | 自动健康 | 观察 |
| **wscript 孤儿数（hub-daemon）** | tasklist | 持续 ≤ 2 | 每 5min 采样 |
| **node hub.mjs 重启次数** | hub-daemon `[housekeeping] OK` + 间断检测 | < 1 次/天 | 7 天 |
| **reclaim_evict 频率** | hub.log audit | < 1 次/天 | 7 天 |
| **push_deliver 失败率** | hub.log audit `send_ok=false` | < 0.1% | 总数比 |
| **committed_pct WARN/CRIT 触发** | hub.log critique broadcast | 仅在真负载尖峰 | 触发记录 |

---

## 4. 采集方案

### 4.1 采集脚本
`bin/baseline-collector.mjs`（新建）：
- 每 5min 跑一次（schtasks Repetition Every 5 minutes）
- 调 Hub /health + watchdog /status
- 解析 hub.log 增量（last seek position 持久化）
- ls data/messages.db
- tasklist count wscript / node
- 写入 `data/baseline-YYYY-MM-DD.jsonl` 一行一记录

### 4.2 schtasks 任务
```powershell
schtasks /Create /TN "JianmuBaselineCollector" /TR "node D:\...\bin\baseline-collector.mjs" /SC MINUTE /MO 5 /RU $env:USERNAME /F
```
- 与现有 `JianmuHubDaemon`（10min repetition）+ `JianmuCliproxyDaemon` 并存
- collector 失败不影响 Hub 运行（独立进程）

### 4.3 数据持久化
`data/baseline-*.jsonl` schema：
```jsonl
{"ts": "2026-05-01T00:05:00+08:00", "health": {"status": "ok", "sessionCount": 12, "messageCount": 4523, "uptime": 86400}, "watchdog": {"hub": {"ok": true, "ms": 12}, "committed_pct": 65, "phys_ram_used_pct": 67}, "log_events": {"reconnect": 0, "reclaim_evict": 0, "push_deliver_fail": 0, "housekeeping_ok": 1, "errors": 0}, "db_size_bytes": 12345678, "process_counts": {"wscript": 1, "node_hub": 1}}
```
7 天 ~2016 行 jsonl，~500KB-1MB 体量。

### 4.4 报告生成
`bin/baseline-report.mjs`（新建）：
- 读 7 天 jsonl 聚合统计
- 计算 §3 指标
- 渲染 markdown 报告 → `handover/HEALTH-BASELINE-YYYY-MM-DD-7D.md`

---

## 5. 报告模板（`HEALTH-BASELINE-YYYY-MM-DD-7D.md`）

```markdown
# Hub Health Baseline · 7 天 uptime 报告

**报告日期**：YYYY-MM-DD
**测量窗口**：YYYY-MM-DDTHH:MM (start) ~ YYYY-MM-DDTHH:MM (end)
**采样间隔**：5 min
**总采样数**：N

## 摘要

| 指标 | 实测 | 目标 | 状态 |
|---|---|---|---|
| Hub uptime % | XX.XX% | > 99% | ✅/⚠️/❌ |
| Hub /health 耗时 p50 | XXms | < 50ms | ✅/⚠️/❌ |
| Hub /health 耗时 p95 | XXms | < 200ms | ✅/⚠️/❌ |
| WS reconnect 日均 | XX 次 | < 5/天/session | ✅/⚠️/❌ |
| SQLite 增长 | XXMB | < 50MB/周 | ✅/⚠️/❌ |
| wscript 孤儿持续态最大 | X | ≤ 2 | ✅/⚠️/❌ |
| node hub.mjs 重启次数 | X | < 1/天 = < 7 | ✅/⚠️/❌ |
| reclaim_evict 总数 | X | < 1/天 = < 7 | ✅/⚠️/❌ |
| push_deliver 失败率 | X.XX% | < 0.1% | ✅/⚠️/❌ |
| committed_pct WARN 触发 | X 次 | 仅尖峰 | 详情段 |

## 时序事件清单

- 触发 critique broadcast：YYYY-MM-DD HH:MM committed_pct=92%（持续 Xmin） · 期间 portfolio session 反应：…
- Hub 重启：（如有）YYYY-MM-DD HH:MM 原因 root cause
- 慢响应尖峰：YYYY-MM-DD HH:MM /health=Xms 偏离 p95 10x 原因…

## 结论

- **释放 v0.6.0 release gate**：✅ 达标 / ⚠️ 部分达标待 patch / ❌ 未达需深入诊断
- **建议改进项**：（基于 baseline 数据驱动）
  - 改进 1：…
  - 改进 2：…
- **下一基线窗口**：v0.6.0 ship 后再跑 7 天对比

## 原始数据

`data/baseline-*.jsonl` 共 7 天 N 行（保留入仓还是 .gitignore 待决）
```

---

## 6. 阈值与达标判定

### 6.1 一票否决项（任一不达即整体 ❌）
- Hub uptime % < 95%（明显坏）
- node hub.mjs 重启次数 ≥ 1/天（频繁重启）
- push_deliver 失败率 > 1%（消息丢失严重）

### 6.2 警告项（达标但需观察）
- Hub uptime 95%-99% → ⚠️ 需诊断且 v0.6.0 不能 release
- /health p95 > 200ms → ⚠️ 性能退化候选
- WS reconnect > 5 次/天/session → ⚠️ 网络不稳或心跳问题

### 6.3 健康项（达标可 release）
- Hub uptime ≥ 99%
- 所有 §3 目标内
- 7 天无 一票否决项

---

## 7. 实施分解

| 任务 | Owner | ETA |
|---|---|---|
| `bin/baseline-collector.mjs` 写 + TDD（AC-BASELINE-001 4 case：health 解析 / watchdog 解析 / log 增量 / jsonl append） | jianmu-pm 派 codex | 1h |
| `bin/baseline-report.mjs` 写 + TDD（AC-BASELINE-002 报告渲染 + 阈值判定） | 同上 | 1h |
| schtasks 安装 install-baseline-collector.ps1 | 同上 | 30min |
| 7 天采集窗口（被动等） | passive | 7×24h = 168h |
| 报告生成 + harness review | jianmu-pm + harness | 30min |
| 写入 `handover/HEALTH-BASELINE-2026-05-08-7D.md` 落档 | jianmu-pm | 15min |

总主动工作 ~3-3.5h + 被动 7 天观察。

---

## 8. 时间窗口建议

### 8.1 起跑日
**2026-05-01 00:00**（v0.5.0 ship 后第 5 天，Hub 跑稳定状态，老板/portfolio 已恢复 PS hook 正常使用）。

### 8.2 结束日
**2026-05-08 00:00**（含 7×24h 观察期）。

### 8.3 报告 ETA
2026-05-08 12:00 出 `HEALTH-BASELINE-2026-05-08-7D.md` v1.0。

### 8.4 节奏
- 第 1 天 collector ship 后跑通验证（jsonl 5min 写一行）
- 第 2-7 天被动采集 + jianmu-pm 偶尔 spot check（每天读 jsonl 末行确认 collector 还在跑）
- 第 7 天报告生成 + 老板审 + 决定 v0.6.0 release

---

## 9. 失败回退

| 失败模式 | 缓解 |
|---|---|
| collector schtasks 跑挂 | hub-daemon 模式时间盒 + 看 wscript/node 进程数 + jsonl mtime 验证 |
| jsonl corrupt（部分写） | 跳过 corrupt 行，报告生成时 robust parse + 标注 lost samples 数 |
| Hub 自身崩 → /health 返回 fail → uptime 计算受影响 | hub-daemon.vbs 时间盒重拉 → 短时 outage 计入 uptime % 真实数据 |
| 7 天观察期被中断（老板要 v0.6.0 提前 ship） | 部分窗口数据仍有用 → 出 partial baseline 报告 + 标注覆盖率 |
| collector 进程影响 Hub 性能 | 资源轻量（每 5min HTTP GET + log seek + ls，预算 < 100MB RAM）+ schtasks 优先级 normal |

---

## 10. 后续延展（v0.6.0 议题）

- **持续监控**：collector 报告完不停跑，作为 portfolio 长期 health snapshot
- **趋势分析**：跨多个 7 天窗口对比，看是否有缓慢退化
- **告警集成**：indicator 偏离阈值 → IPC harness 主动 broadcast critique
- **Grafana / 自部署 dashboard**：jsonl → SQLite/InfluxDB 视图（中长期）
- **portfolio 级 baseline**：扩到 18 session 各自 last_heartbeat 频率 + IPC throughput 等

---

## 11. 与 ADR / TODO 的关系

- **PROJECT-PLAN.md §六**：本 baseline 是该度量指标的实施载体
- **TODO P3**：`Hub /health uptime 7 天基线测量` ETA 2026-05-24（本 doc 提议提前到 2026-05-01-08）
- **ADR-005 observation**：collector jsonl 是 observation 的延展（项目级 health observation）
- **ADR-008 reclaim**：reclaim_evict audit 是本 baseline 的一项采集源
- **ADR-009 channel race fix**：push_deliver / ack_received audit 是本 baseline 的关键采集源
- **ADR-003 hook**：hook 真激活率（writer.ps1 触发频率）也可加入 baseline（v2 议题）

---

## 12. 老板答疑

| 问 | 答 |
|---|---|
| 为啥要测 7 天而不是 1 天 / 30 天 | 1 天数据噪声大（短时尖峰主导）+ 30 天太久晚于 v0.6.0 决策窗口；7 天涵盖工作日 5 天 + 周末 2 天，足够看负载分布 |
| collector 数据要入仓吗？| 默认 .gitignore（jsonl 生成数据），仅最终报告 markdown 入仓；如需追溯可 archive 到 temp/ |
| 影响 Hub 性能吗？| 5min 一次 HTTP GET + log seek，资源轻量，且独立进程不阻 Hub 主流程 |
| 跑期间 Hub 改动怎么办？| 改动会污染 baseline，建议 7 天窗口内 freeze Hub（除 P0 hot-fix）。改动后重启 baseline |
| 7 天窗口太长？| baseline 一次性投资 + 持续监控延展。7 天后改进可基于数据驱动。可加速但风险数据不足 |

---

## 13. 推荐决策

**立即 ship**：collector + report 工具（~3-3.5h Codex TDD），2026-05-01 起跑 7 天观察。

如老板要更早起跑，可压缩到 4-7 天（最少 3×24h 才有足够采样可信度）。

---

## 14. 版本

| 版本 | 日期 | 作者 | 说明 |
|---|---|---|---|
| v0.1 | 2026-04-25 16:35 | jianmu-pm | 草案，等 harness review + 老板拍排期。Self-driven 自抓本 P3 backlog 提前规划 |
