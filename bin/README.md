# bin/ 脚本索引

## 🌟 推荐使用（当前方案）

### Daemon 守护（Windows）

让 Hub/CliProxy 开机自启 + 崩溃自愈。由 Windows 任务计划 + VBS 健康探测组成。

| 文件 | 用途 |
|------|------|
| `hub-daemon.vbs` | Hub 健康探测主体（5 分钟循环 curl /health） |
| `install-daemon.ps1` | 注册 JianmuHubDaemon 任务计划 |
| `uninstall-daemon.ps1` | 卸载 JianmuHubDaemon |
| `cliproxy-daemon.vbs` | CLIProxyAPI 健康探测主体 |
| `install-cliproxy-daemon.ps1` | 注册 CliProxyDaemon 任务计划 |
| `uninstall-cliproxy-daemon.ps1` | 卸载 CliProxyDaemon |
| `verify-daemons.ps1` | 手动 kill PID 验证自愈（开发/测试用） |

快速命令（项目根目录）：

```bash
npm run daemon:install    # 安装 Hub daemon
npm run daemon:uninstall  # 卸载 Hub daemon
npm run daemon:verify     # 自愈能力验证
```

### CLI 工具

| 文件 | 用途 |
|------|------|
| `jianmu.mjs` | CLI 入口（`jianmu status` / `jianmu hub`） |
| `install.ps1` | 安装 `ipc` 函数到 PowerShell profile |
| `patch-channels.mjs` | Claude Code cli.js 补丁（跳过 dev channels 弹窗） |
| `feishu-auto-reply.cjs` | Stop hook 自动回复飞书 |
| `feishu-reply.sh` | Shell 快捷回复飞书 |

### Linux/macOS 脚本

| 文件 | 用途 |
|------|------|
| `run-forever.sh` | 无限重启循环（老版"守护"，Linux 环境用） |
| `start.sh` / `stop.sh` | Hub 启停 |
| `restart.sh` | 重启 |
| `status.sh` | 查看状态 |
| `update.sh` | 拉 git + 重启 |

## ⚠️ 已废弃（LEGACY，保留仅供过渡期）

这些文件被新版 daemon 方案替代，请不要继续使用。

| 文件 | 替代为 |
|------|--------|
| `start-hub-silent.vbs` | `hub-daemon.vbs` |
| `create-shortcut.ps1` | `install-daemon.ps1` |
| `start-hub.bat` / `stop-hub.bat` | `npm run hub` + daemon 自动守护 |
| `install-startup.bat` / `uninstall-startup.bat` | `install-daemon.ps1` / `uninstall-daemon.ps1` |

原因：
- startup 快捷方式只在登录时触发一次，挂了不会自愈（新方案每 5 分钟自检）
- bat 脚本无健康验活能力（只检测端口监听，假活无法识别）
- create-shortcut.ps1 创建的快捷方式会被新版 install-daemon.ps1 自动清理

详见 [ADR-004](../docs/adr/004-local-services-daemon.md)。

## 故障排查

见 [../docs/OPERATIONS.md](../docs/OPERATIONS.md)。
