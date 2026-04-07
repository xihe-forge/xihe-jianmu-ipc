# xihe-jianmu-ipc 开发路线图

## Phase 1-7: 基础设施 ✅ 已完成

- [x] 群聊收发 + @mention检测 + Stop hook群回复
- [x] 进程管理: run-forever.sh、start/stop/restart脚本、代码变更自动重启
- [x] SQLite持久化 (WAL模式) + GET /messages查询 + 7天TTL清理
- [x] 监控Dashboard骨架 (session列表、消息计数)
- [x] 消息类型: 图片/文件下载、富文本post解析
- [x] 多App动态加载: feishu-apps.json热重载、worker自动启停
- [x] 安全加固: per-session token、敏感信息过滤(redact)、审计日志(audit)
- [x] 飞书卡片: 状态卡片、多任务汇总、进度阶段、置顶、一键新增机器人
- [x] 消息去重、async ACK、ipc_rename、feishu ping拦截

## Phase 8: 飞书AI控制台 🚧 进行中

**方向**: 飞书变成AI遥控器，手机上指挥和监控所有Agent。

### 8.1 快捷指令 ✅
- [x] 命令解析器 (lib/command-parser.mjs)
- [x] 7种命令: 状态/帮助/派发/广播/重启/历史/日报
- [x] P2P消息命令拦截，不转发到Hub
- [x] 卡片模板系统 (lib/console-cards.mjs)

### 8.2 Agent状态追踪 ✅
- [x] 15秒轮询Hub /sessions (lib/agent-status.mjs)
- [x] 上下线变更检测 + 飞书通知
- [x] 状态看板卡片 (在线/离线/时长)
- [x] 刷新按钮 (card.action.trigger)

### 8.3 任务派发 ✅
- [x] "让{agent}去{task}" 自然语言指令
- [x] 派发确认卡片 (已送达/已缓冲)
- [x] 广播消息到所有在线Agent

### 8.4 审批流 ✅
- [x] Agent发审批卡片 (确认/拒绝按钮)
- [x] 按钮回调 → IPC回传审批结果

### 8.5 待完善
- [x] 日报: 接入per-agent消息计数 (GET /stats API已实现)
- [ ] 定时推送: 每日早报 (cron触发)
- [ ] 消息历史: 改用卡片展示而非纯文本
- [ ] 群聊命令支持 (当前仅P2P)

## Phase 9: Agent协作协议

- [ ] 结构化任务消息: `{ action, target, deadline, priority }`
- [ ] 任务状态跟踪 (pending → running → done/failed)
- [ ] Dashboard解析和展示任务链

## Phase 10: Agent状态广播

- [ ] Agent定期广播状态到群: 忙碌/空闲/错误
- [ ] Dashboard实时显示每个agent当前任务
- [ ] 任务分配时自动选空闲agent

## Phase 11: 团队知识共享

- [ ] Agent发现的问题/方案通过群消息共享
- [ ] 知识索引和搜索
- [ ] 避免重复踩坑

## 其他待办

- [ ] npm发布0.2.0 (同步所有新功能)
- [ ] README/CHANGELOG更新
- [ ] Dashboard深化: 实时消息流、告警、日志查看器
