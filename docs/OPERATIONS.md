# 建木 Hub 运维指南

面向日常维护者，涵盖 Hub 启停/健康诊断/故障排查/恢复流程。

## 日常操作

### 查看 Hub 状态

```bash
npm run status
# 或 curl http://127.0.0.1:3179/health
```

返回示例：
```
Hub uptime: 7878s
  pc-pet-builder — connected 7835s ago
  harness — connected 5500s ago
  ...
```

### 查看最近日志

```bash
npm run logs
# 或 tail -f data/hub.log
```

### 查看消息历史

```bash
# 最近24小时各 agent 发送量
curl "http://127.0.0.1:3179/stats?hours=24" | python -m json.tool

# 两个 session 之间的对话
curl "http://127.0.0.1:3179/messages?from=harness&to=jianmu-pm&limit=20" | python -m json.tool
```

## Daemon 管理

Hub、CLIProxyAPI 和 network-watchdog 都支持通过 Windows 任务计划自动守护。

### 安装 daemon

```powershell
# Hub daemon
npm run daemon:install
# 或 powershell -ExecutionPolicy Bypass -File bin\install-daemon.ps1

# CliProxy daemon
powershell -ExecutionPolicy Bypass -File bin\install-cliproxy-daemon.ps1

# network-watchdog daemon
npm run daemon:watchdog:install
# 或 powershell -File bin\install-network-watchdog-daemon.ps1
```

### 验证自愈能力

```powershell
# 测 Hub daemon（会 kill Hub PID 测自动恢复）
npm run daemon:verify -- -Service Hub

# 测 CliProxy daemon
npm run daemon:verify -- -Service CliProxy

# 两个都测
npm run daemon:verify
```

### 查看 daemon 任务状态

```cmd
schtasks /query /tn JianmuHubDaemon /fo LIST /V
schtasks /query /tn CliProxyDaemon /fo LIST /V
schtasks /query /tn NetworkWatchdogDaemon /fo LIST /V
```

### 卸载 daemon

```powershell
npm run daemon:uninstall
# 同时清理旧版 JianmuHub startup 快捷方式
```

## network-watchdog 运维

### 手动启动

```bash
npm run watchdog
# 或 node bin/network-watchdog.mjs
```

手动启动时，watchdog 的错误日志会直接打到当前终端 stderr。

### daemon 启停

```powershell
npm run daemon:watchdog:install
npm run daemon:watchdog:uninstall
```

### 查看 /status

```bash
curl http://127.0.0.1:3180/status
```

返回示例：

```json
{
  "state": "OK",
  "failing": [],
  "lastChecks": {
    "cliProxy": {"ok": true, "latencyMs": 12, "ts": 1776516090000},
    "hub": {"ok": true, "latencyMs": 4, "ts": 1776516090000},
    "anthropic": {"ok": true, "latencyMs": 231, "ts": 1776516090000},
    "dns": {"ok": true, "latencyMs": 8, "ts": 1776516090000}
  },
  "uptime": 153422
}
```

### 人工触发恢复

自动恢复以外，仍可用 Hub 的兼容入口手工广播恢复事件：

```bash
curl -X POST http://127.0.0.1:3179/wake-suspended
```

这会继续调用结构化 `network-up` helper，并清空 `suspended_sessions` 表。

### 故障排查

1. 看 watchdog 当前 stderr；若走 daemon，查看 `D:/workspace/ai/research/xiheAi/temp/jianmu-ipc/logs/network-watchdog-daemon.log`
2. 查 `curl http://127.0.0.1:3180/status`，确认 `state`、`failing` 和各 probe `lastChecks`
3. 查 `data/audit.log` 中 `http_internal_network_event` / `/internal/network-event` 记录，确认 Hub 是否实际收到 down/up 事件
4. 如 watchdog 已恢复但 session 仍未继续，检查 `POST /wake-suspended` 是否被人工误用或 `suspended_sessions` 是否已清空

## 故障排查

### Hub 没响应（ECONNREFUSED 3179）

```bash
# 1. 检查端口监听
netstat -ano | findstr :3179

# 2. 检查 daemon 任务状态
schtasks /query /tn JianmuHubDaemon
# 状态应该是 Ready

# 3. 查看最近日志
tail -50 data/hub.log

# 4. 等 5 分钟让 daemon 自动拉起（每 5 分钟检查一次）

# 5. 如果 5 分钟还没恢复，手动拉起
node hub.mjs >> data/hub.log 2>&1 &
```

### 某个 session 收不到消息

```bash
# 1. 确认 session 在线
curl -s http://127.0.0.1:3179/sessions | python -m json.tool | grep "name"

# 2. 查离线 inbox（SQLite）
sqlite3 data/messages.db "SELECT session_name, COUNT(*) FROM inbox GROUP BY session_name"

# 3. 查最近路由失败
grep "unknown session" data/hub.log | tail -10
```

### Codex 报 stream disconnected

99% 是 CLIProxyAPI 问题。排查：

```bash
# 1. 本地路由通？
curl -s http://127.0.0.1:8317/v1/models
# 应该返回模型列表 JSON

# 2. 上游通？
curl -s -X POST http://127.0.0.1:8317/v1/responses -H "Content-Type: application/json" -d '{"model":"gpt-5.4","input":"test","max_output_tokens":1}'
# 200 说明上游OK，502 说明上游挂（免费账号额度/OpenAI 抽风）

# 3. CliProxy daemon 状态？
schtasks /query /tn CliProxyDaemon
```

### Hub 反复重启

检查 `IPC_DEV_WATCH` 是否误开：

```bash
grep "file watch" data/hub.log | tail -3
# 应该看到 "file watch disabled (set IPC_DEV_WATCH=1 to enable)"
# 如果看到 "DEV mode: polling" 说明误开了
```

## 发版流程

> **publish 前必查登录态**：`npm whoami` 返 401 时，紧接着跑 `npm publish` 会得到误导性 `404 Not Found - PUT https://registry.npmjs.org/...`。npm CLI 为防止泄露包是否存在，把未认证的 PUT 伪装成 404。看到 publish 404 第一反应查 `npm whoami`，不要怀疑包名或权限。

### 标准流程

```bash
# 1. 全量测试（unit + 集成 + 协议层 E2E）
npm test

# 2. portfolio acceptance e2e self-test（acceptance 同口径 ship gate）
node --test tests/e2e/portfolio-acceptance.test.mjs

# 3. 确认登录态（避免 401 被伪装成 404）
npm whoami
# 预期返回你的 npm 账号名；若 401 → npm login 重登

# 4. 预检（dry-run 确认 tarball 内容 + 警告数）
npm publish --dry-run
# 警告数必须为 0

# 5. 正式 publish
npm publish
# WebAuthn 2FA（Windows Hello）会弹本机 PIN/指纹框
```

### e2e self-test（acceptance 同口径 · 必跑 ship gate）

publish 前必跑 portfolio acceptance e2e 验“老板/portfolio 真用场景”通畅。pass 才许 publish。

```bash
# 跑 portfolio acceptance e2e（5 case 含 Hub /health / 单播 / 广播 / SQLite 持久化 / HTTP /send）
node --test tests/e2e/portfolio-acceptance.test.mjs
```

**fail 不许 publish**。这条是治理层硬规则（2026-04-25 老板 critique 后立）：ship 标准 = acceptance 标准，partial check（unit/集成/协议层 E2E）虽全绿但不替代 acceptance 同口径 e2e。

完整 ship gate 顺序：
1. `npm test` 全套（unit + 集成 + 协议层 E2E）
2. **`node --test tests/e2e/portfolio-acceptance.test.mjs`（acceptance 同口径 · 新增）**
3. `npm whoami` 登录态确认
4. `npm publish --dry-run` 警告 0
5. `npm publish` 正式发布

### 常见错误

| 错误信号 | 真实含义 | 修复 |
|---------|----------|------|
| `E401 Unauthorized` on `npm whoami` | 登录态过期 | `npm login` |
| `E404 Not Found - PUT` on `npm publish` | **多数情况等同 401**（未登录），不是真的 404 | 先 `npm whoami` 验证，再 `npm login` |
| `EOTP - one-time password` | TOTP 2FA 场景 | `npm publish --otp=<6位>` |
| `EINTEGRITY` (integrity checksum failed) | package-lock.json 哈希错 | 本地 `rm -rf node_modules package-lock.json && npm install` 重建 |
| WebAuthn 2FA 交互 | Windows Hello 必须本机 | 无法 `--otp=` 传，必须桌面会话按指纹/PIN |

### 长期自动化（backlog）

手动 publish 每季度几次可接受。若频率提升，评估迁移到 **Trusted Publishing**（GitHub Actions + OIDC）：
- 参考 https://docs.npmjs.com/trusted-publishers
- 无需长期 token、免 2FA 交互、审计清晰
- 需要在 npmjs.com 后台配置 GitHub 仓库为可信发布者

## 测试

### 全量测试

```bash
npm test
# 400+ 测试，视机器性能约 5 分钟
```

### 分层测试

```bash
npm run test:unit         # 单元测试
npm run test:integration  # 集成测试
npm run test:e2e          # 协议层 E2E 测试
node --test tests/e2e/portfolio-acceptance.test.mjs  # portfolio acceptance e2e self-test（ship gate）
```

### 突变测试

```bash
npm run test:mutation
# 耗时长（~30 分钟 8 个 lib 模块）
# 仅在非工作时段跑（CPU 密集）
```

## 配置文件

| 文件 | 作用 | 是否可提交 |
|------|------|-----------|
| `feishu-apps.json` | 飞书多应用配置（含密钥） | ❌ .gitignore |
| `feishu-apps.example.json` | 飞书配置模板 | ✅ |
| `ci-routes.json` | GitHub 仓库 → AI session 路由表 | ✅ |
| `auth-tokens.json` | Per-session WebSocket token | ❌ .gitignore |
| `.ipc-internal-token` | Hub/watchdog 内部共享 token（env 缺失时自动生成） | ❌ .gitignore |
| `.env` | OpenClaw 集成配置 | ❌ .gitignore |
| `stryker.config.json` | 突变测试配置 | ✅ |

## 数据目录

`data/`（不提交 git，除 .gitkeep）：

| 文件 | 说明 |
|------|------|
| `hub.log` | Hub 主日志（stderr 输出追加） |
| `messages.db` | SQLite 持久化（messages + tasks + inbox 三张表） |
| `messages.db-wal` / `-shm` | SQLite WAL 模式副文件 |
| `audit.log` | 审计日志（关键操作） |
| `pending-cards.json` | 飞书卡片 stage 跟踪 |
| `feishu-files/` | 飞书附件下载缓存 |

临时文件（非项目目录）：

`D:/workspace/ai/research/xiheAi/temp/jianmu-ipc/` 下：
- `logs/install.log` / `uninstall.log` / `verify-daemons.log`
- `logs/cliproxy-daemon.log`
- `logs/network-watchdog-daemon.log`
- 测试数据库临时文件

## 相关决策

运维相关 ADR：

- [ADR-002](adr/002-file-watch-default-off.md) — 为什么文件监控默认关闭
- [ADR-003](adr/003-offline-inbox-sqlite-persistence.md) — offline inbox 持久化
- [ADR-004](adr/004-local-services-daemon.md) — daemon 守护机制
- [ADR-006](adr/006-register-scheduledtask-arg-escaping.md) — Task Scheduler 参数坑
