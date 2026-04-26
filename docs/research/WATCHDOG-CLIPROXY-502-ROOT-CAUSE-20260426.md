# network-watchdog cliProxy 502 anomaly · 根因调查 + 修复方案

> **调查日期**：2026-04-26T18:14+08:00
> **调查人**：jianmu-pm（接 harness 18:55 派单 "anomaly 深挖优先于其他 backlog"）
> **触发**：jianmu-pm 17:57 体检 `/status` 见 state=down failing=cliProxy HTTP 502，hub/anthropic/dns 全 ok·写入 self-handover §五给 lineage 10 警告
> **结论**：probe 设计 bug，非真实服务 outage·一行 evaluate 调整即可清

---

## 一、症状

```bash
$ curl -s http://127.0.0.1:3180/status
{
  "state": "down",
  "failing": ["cliProxy"],
  "lastChecks": {
    "cliProxy": {"ok": false, "latencyMs": 8, "error": "HTTP 502"},
    "hub": {"ok": true, "latencyMs": 3},
    "anthropic": {"ok": true, "latencyMs": 1435},
    "dns": {"ok": true, "latencyMs": 10}
  }
}
```

= cliProxy 探测 502，watchdog 整体 state 标 down。但实际：
- hub OK（3179 端口活）
- anthropic OK（1.4s 跨境延迟正常）
- dns OK
- 整 portfolio 工作正常

---

## 二、根因

### 2.1 探测路径

`lib/network-probes.mjs:195-216` `probeCliProxy()`：

```js
// CLI_PROXY_URL = 'http://127.0.0.1:8317/v1/responses'
fetch(CLI_PROXY_URL, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({}),  // 空 body
})
// evaluate: response.status >= 500 → ok: false
```

### 2.2 服务实情

```
$ Get-NetTCPConnection -LocalPort 8317
LocalPort 8317 · State Listen · OwningProcess 61132

$ Get-Process -Id 61132
ProcessName cli-proxy-api
Path D:\workspace\ai\opensource\CLIProxyAPI_6.9.36_windows_amd64\cli-proxy-api.exe
StartTime 2026/4/24 14:13:30
```

= `cli-proxy-api` v6.9.36 自 04-24 14:13 持续运行，48 小时无重启，端口 8317 LISTENING 正常。

### 2.3 实测响应

```
$ curl -sv -X POST http://127.0.0.1:8317/v1/responses \
    -H "content-type: application/json" -d "{}"
HTTP/1.1 502 Bad Gateway
{"error":{"message":"unknown provider for model","type":"server_error","code":"internal_server_error"}}
```

= **服务活着且响应**，只是因为 body `{}` 缺 `model` 字段，cli-proxy 找不到 provider 路由，回 502 配上 error body。

### 2.4 根因总结

probeCliProxy 设计 bug：
- 假设：发空 body 看是否 200 来判断服务活
- 实际：cli-proxy-api 不是健康检查端点，要 model 字段才能路由
- 结果：服务**永远** 502（无论是否真实活着），watchdog **永远**标 down

**=** 不是真实 outage，是 probe 自身的 false positive。

### 2.5 何时引入

probeCliProxy 是 watchdog 8 项 probe 之一，自上线起设计就有此 bug。**只是 cli-proxy-api 之前可能未启动（502 vs connection refused 都 fail），所以一直被认为是"cliProxy 服务没起"。** 04-24 14:13 cli-proxy-api 进程启起后，从"connection refused"切到"502"，但仍 fail 不变，没人察觉是 probe bug。

---

## 三、修复方案

### 3.1 选项对比

| 方案 | 改动 | 风险 | 推荐度 |
|---|---|---|---|
| **A** evaluate 接受 502 +"unknown provider"作为 alive | 1 行 | 低（依赖 error body，cli-proxy 升级若改 error msg 会断）| ⭐⭐ |
| **B** 改用 OPTIONS / GET / HEAD | 几行 | 中（cli-proxy-api 是否支持需测）| ⭐⭐⭐ |
| **C** 发最小 valid body 让 cli-proxy 回 4xx 而非 502 | 几行 | 低（4xx 已被 evaluate 视为 alive）| ⭐⭐⭐⭐ |
| **D** 用 cli-proxy-api 健康端点（如 /healthz）| 几行 | 低-中（需查 cli-proxy-api 版本是否有该端点）| ⭐⭐⭐⭐⭐ 最优 |

### 3.2 推荐方案 D + fallback 到 C

**主路径**：探测 `GET http://127.0.0.1:8317/v1/models`（OpenAI/Anthropic 兼容代理常有此端点列模型，回 200 + 模型清单）。

**fallback**：若 cli-proxy-api 无 /v1/models，改用 `POST /v1/responses` body 含 `{"model": "claude-haiku-4-5"}` 让 cli-proxy 回 4xx（缺其他必需字段如 messages），4xx 被现 evaluate 当 alive。

**实测验证**（2026-04-26T18:15+08:00 jianmu-pm 自验）：

| 端点 | 状态码 | 适用度 |
|---|---|---|
| `GET /healthz` | **200** | ⭐⭐⭐⭐⭐ 推荐·purpose-built 健康端点·无 auth 无 body |
| `GET /v1/models` | 200 | ⭐⭐⭐⭐ 备选·列模型·无 auth |
| `GET /` | 200 | ⭐⭐⭐ root 端点 |
| `GET /health` | 404 | ✗ 不可用 |

**最终推荐**：改 probeCliProxy 为 `GET /healthz`，evaluate `status === 200 → ok`。一行 fetch 改动。

---

## 四、harness 状态机 stale anomaly（次要）

### 4.1 症状

```
"harness": {
  "state": "down",
  "lastTransition": 1776949514530,    // 2026-04-22T14:25:14
  "lastReason": "ws-down-grace-exceeded",
  "lastProbe": {"ok": true, "connected": true, "latencyMs": 4}  // 当前
}
```

= state=down + lastTransition 4 天前 + lastProbe ok 当前。状态机滞后未刷新。

### 4.2 推测根因（未确认）

`bin/network-watchdog.mjs` harness state 机：
- 4 天前某次 ws 断开 → state=down，lastTransition 落档
- 之后 ws 恢复 + 持续 alive，但 state 转 up 的逻辑没触发
- 可能是：lastSeenOnlineAt 刷新逻辑只在 probe.connected=true 时刷，但 state 转 down → up 需要 connected + 其他条件（如 heartbeat 收到）

### 4.3 影响

- watchdog state=down 累积 cliProxy 502 + harness stale 双叠加 → /status 持续 state=down
- 但实际 portfolio 无人受影响（jianmu-pm + harness 都正常 IPC，4 太微 spawn 也成功）
- ADR-006 v0.3 的"五信号 AND"设计正在解决此类假阳性，但当前不阻塞

### 4.4 建议

harness state 机刷新逻辑深挖留给：
- ADR-006 v0.3 第二波（步骤 8/9/10）实施时附带审计
- 或单独立新 issue 派 codex 排查（约 1h）

---

## 五、影响 + 建议

### 5.1 当前影响（实测）

| 项 | 影响 | 严重度 |
|---|---|---|
| watchdog /status 显示 state=down | 无人决策依此 | 低 |
| 误触 self-handover？ | 实证 lineage 8 → 9 切账号期间未误触 | 低 |
| ADR-006 v0.3 设计验证 | cliProxy 502 是 v0.3 五信号 AND 想解决的"全局探针看一切正常但 session 卡住"反向案例（这里是"全局探针看一切异常但其实 portfolio 正常"）| 高·正面价值 |

### 5.2 修复优先级

- **P2**：cliProxy probe 改为 D 方案（/v1/models 或 /healthz），1 行 evaluate 调整，预计 30 分钟
- **P3**：harness state 机 stale 深挖，并入 ADR-006 v0.3 第二波 brief 范围
- **P0**：本调查文档落档（本文）+ IPC harness 同步

### 5.3 不修复的代价

- /status 一直显示假 down，但只要 portfolio 工作正常（如当前），无 actionable 影响
- 新 lineage 接手时若不知此 anomaly 容易误判（已通过 self-handover §五警告 lineage 10）
- 长期看 watchdog 数据进 ADR-006 v0.3 五信号 AND 时若复用 state 信号会被污染

---

## 六、数据点（用于 case-study 4a §十 后续 patch）

- watchdog 累计 uptime：`uptime: 392482321ms = 4.5 天`（自 lineage 7/8 启动至今）
- harness lineage 8/9 切账号未触发 self-handover 误触发：实证 cold-start grace + connected=true 双信号防 false positive 有效
- cliProxy 502 持续 ≥ 48 小时无人察觉：watchdog 监测有效但**无 actionable 告警**·待补"down 状态 24h 未恢复触发 IPC critique"机制

---

## 七、版本

| 版本 | 日期 | 变更 |
|---|---|---|
| v0.1 | 2026-04-26T18:14+08:00（实测 wall clock）| jianmu-pm 起草·cliProxy 502 根因 + 4 修复选项 + harness state 机 stale 推测 + 数据点 |
