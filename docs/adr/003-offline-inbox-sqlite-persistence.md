# ADR-003: Offline inbox 持久化到 SQLite

**日期**：2026-04-16
**状态**：已生效（commit e63dfda）

## 背景

Hub 为离线 session 缓冲消息：调用 `pushInbox(session, msg)` 时消息加入 `session.inbox` 数组，session 重连时 `flushInbox` 一次性投递。早期实现 inbox 只在内存（`session.inbox: Array`），`sessions` Map 也是内存。

## 问题

Hub 重启时：
- 所有 `sessions` Map 丢失
- 所有 inbox 消息丢失
- stub session（未知 `to` 时自动创建的占位）彻底消失

2026-04-16 Hub 因 auto-restart 重启 3 次，每次都把缓冲消息丢光。重连后的 session 永远收不到离线期间别人发给它的消息。

## 决策

新增 SQLite `inbox` 表，`pushInbox` 时同时写入 DB，`flushInbox` 时合并内存+DB 消息、按 `ts` 升序去重发送。

```sql
CREATE TABLE inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_name TEXT NOT NULL,
  message TEXT NOT NULL,  -- JSON.stringify(msg)
  ts INTEGER NOT NULL
);
CREATE INDEX idx_inbox_session ON inbox(session_name);
```

API：
- `saveInboxMessage(sessionName, msg)` — 写入
- `getInboxMessages(sessionName)` — 读取（ts 升序）
- `clearInbox(sessionName)` — 投递后清空
- `clearExpiredInbox(maxAgeMs)` — TTL 清理

## 后果

**正面**：
- Hub 重启消息不丢
- 集成测试覆盖 Hub 重启场景（tests/integration/router-with-db.test.mjs）
- `flushInbox` 按 ts 排序，多路径汇合消息顺序正确

**负面**：
- 每条 offline 消息多一次 SQLite 写（微秒级，WAL 模式下可忽略）
- Hub 内存 inbox 仍保留作为热缓存（双写），代码稍复杂

## 相关

- `lib/router.mjs::pushInbox` / `flushInbox`
- `lib/db.mjs` 新增 4 个函数
- ADR-002: 文件监控默认关闭（Hub 不再因代码变更重启，但机器重启/崩溃仍可能发生）
