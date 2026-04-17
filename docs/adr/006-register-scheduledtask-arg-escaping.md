# ADR-006: Register-ScheduledTask 参数吞噬规避（cmd /c 包装）

**日期**：2026-04-17
**状态**：已生效（commit 91a2dc7）

## 背景

注册 Windows 任务计划启动 VBS daemon：

```powershell
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument '//B "D:\path\daemon.vbs"'
Register-ScheduledTask -TaskName "MyDaemon" -Action $action ...
```

## 问题

任务 XML 实际存储的是：
```xml
<Exec>
  <Command>wscript.exe</Command>
  <Arguments>//B ""</Arguments>
</Exec>
```

**VBS 路径被吞了**。daemon 任务 Ready 状态但从不真正执行，隐蔽且 Hub 自愈 7 分钟没恢复才发现。

## 根因

PowerShell `-Argument` 字符串在序列化到 Task Scheduler XML 时，遇到 `//` 开头的 token 会截断后续内容。不是 VBS 或 cmd 的问题，是 `Register-ScheduledTask` cmdlet 自己的处理。

## 决策

用 `cmd /c` 包装 wscript 调用，让 cmd shell 解析参数：

```powershell
$vbsPath = "D:\path\daemon.vbs"
$argString = '/c wscript.exe //B "' + $vbsPath + '"'
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $argString
```

任务 XML 变成：
```xml
<Arguments>/c wscript.exe //B "D:\path\daemon.vbs"</Arguments>
```

cmd 可以正常解析 `//B` 作为 wscript 参数。

## 检测方法

注册后必须检查：

```powershell
schtasks /query /tn TaskName /xml | Select-String "Arguments"
# 错误：<Arguments>//B ""</Arguments>
# 正确：<Arguments>/c wscript.exe //B "D:\path\daemon.vbs"</Arguments>
```

## 后果

**正面**：
- Hub daemon 验证通过（4.3 分钟自愈）
- CliProxy daemon 同步修复
- 此模式沉淀到天枢 `local-services-daemon.md` 反模式清单

**负面**：
- 多一层 cmd 进程（忽略不计）

## 相关

- `bin/install-daemon.ps1` / `bin/install-cliproxy-daemon.ps1`
- 天枢 knowledge/local-services-daemon.md 反模式章节
