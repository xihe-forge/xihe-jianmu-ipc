# ADR-002: 源文件监控默认关闭，仅 IPC_DEV_WATCH=1 启用

**日期**：2026-04-16
**状态**：已生效（commit 28d1f80）

## 背景

`hub.mjs` 最初有一个 10 秒轮询机制，监控 `hub.mjs`、`lib/*.mjs` 等源文件的 mtime 变化，检测到变更就 `process.exit(0)` 自动退出。设计意图：开发时改代码自动重启。

## 问题

生产环境下，代码提交（git pull/push/commit）会改 mtime，触发 Hub 自杀。但 Hub 没有守护进程自动拉回（`&` 后台进程不等于守护）。结果：

- 2026-04-16 一天内因 `hub.mjs` 和 `lib/db.mjs` 变更触发 3 次重启
- 每次重启所有 WebSocket session 断开，消息路由中断 30-60 秒
- 影响所有跨 session 协作流程

## 决策

文件监控默认**关闭**，仅当 `IPC_DEV_WATCH=1` 环境变量显式启用时才轮询。

```js
if (process.env.IPC_DEV_WATCH === '1') {
  // ... 启动 setInterval 轮询
  stderr('[ipc-hub] DEV mode: polling source files for auto-restart');
} else {
  stderr('[ipc-hub] file watch disabled (set IPC_DEV_WATCH=1 to enable)');
}
```

## 后果

**正面**：
- Hub 稳定性大幅提升，不会因代码提交自杀
- 生产/日常使用默认安全

**负面**：
- 开发时改 `hub.mjs` 需手动重启。影响小——开发迭代本来就应显式重启验证

## 替代方案（已拒绝）

1. **守护进程自动重启**：复杂度高（需要拉起/健康检查/退避）。后来补的 `bin/hub-daemon.vbs` 本质是这条路，但作为独立层在外部，不是 Hub 内嵌
2. **只监控 hub.mjs 不监控 lib/**：仍无法避免 lib 代码修改后需要重启

## 相关

- `hub.mjs:280-295`（文件监控实现）
- ADR-004: Hub daemon 守护机制（进程级守护是更正确的分工）
