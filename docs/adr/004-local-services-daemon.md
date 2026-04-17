# ADR-004: 本地服务 daemon 守护机制（Hub + CliProxy）

**日期**：2026-04-17
**状态**：已生效（commit 4537b4a / 91a2dc7）

## 背景

2026-04-16 Hub 多次被 auto-restart 杀掉。2026-04-17 C 盘爆满触发系统重启，CLIProxyAPI（localhost:8317，Codex 中转代理）也因无自启机制全天不可用。

关键服务挂了没人拉起是系统级问题。

## 决策

每个本地关键服务（Hub、CliProxy）配一个 daemon 三件套：

1. **`*-daemon.vbs`**：无限循环，每 5 分钟健康探测（curl 功能端点），失败则精确 kill 占端口 PID + 拉起新进程
2. **`install-*-daemon.ps1`**：Windows Task Scheduler 注册任务
   - 触发器：`AtLogOn` + 每 10 分钟 `RepetitionInterval`（双保险）
   - 不用 `AtStartup`（需要管理员权限）
3. **`uninstall-*-daemon.ps1`**：卸载

### 关键原则

- **健康检查必须 functional**：不只测端口（假活），测真实功能端点
  - Hub: `curl /health` 验 JSON 响应
  - CliProxy: `curl /v1/models`（本地路由，不消耗 token）
- **假活处理**：端口被占但 HTTP 不通 → `taskkill /PID $PID /F`（只杀该 PID，绝对不 `taskkill node.exe`）
- **拉起失败 5 次 → IPC 告警**：避免死循环重启，转交人工
- **上游问题不归 daemon**：CPA 上游 502 无论重启多少次 CPA 都无用，由 session 主动 IPC 告警

## 后果

**正面**：
- Hub 4.3 分钟内自愈验证通过（2026-04-18 00:03）
- CliProxy 3.4 分钟自愈通过（2026-04-17 20:59）
- 机器重启后两个服务自动起来，不需要人工介入

**负面**：
- Windows 专用（VBS + Task Scheduler），Linux/macOS 需另实现
- 踩过坑：`Register-ScheduledTask -Argument '//B "path.vbs"'` 会吞路径（见 ADR-006）

## 相关

- `bin/hub-daemon.vbs` / `bin/cliproxy-daemon.vbs`
- `bin/install-daemon.ps1` / `bin/install-cliproxy-daemon.ps1`
- `bin/verify-daemons.ps1` 自愈能力验证脚本
- ADR-005: Hub 代码分层（daemon 是进程级守护，code 层独立职责）
- ADR-006: `Register-ScheduledTask //B` 参数吞噬规避
