# xihe-jianmu-ipc 开发路线图

## Phase 1: 群聊回复（进行中，Codex实现）
- [x] feishu-bridge群消息接收
- [ ] feishu-bridge群消息回复（from字段带chat_id，Hub路由回群）
- [ ] Stop hook支持群消息自动回复
- [ ] Hub POST /feishu-reply支持chat_id参数

## Phase 2: 进程管理与稳定性
- [ ] pm2/systemd配置文件：Hub + feishu-bridge一键启动
- [ ] 自动重启、崩溃恢复
- [ ] 日志轮转（防止日志文件无限增长）
- [ ] 健康检查脚本（检测Hub/bridge存活状态）
- [ ] Hub启动时自动拉起bridge（或反过来）

## Phase 3: 消息持久化
- [ ] SQLite存储所有经过Hub的消息
- [ ] 消息表结构：id, from, to, content, topic, timestamp, status(delivered/buffered/failed)
- [ ] API查询：GET /messages?from=xxx&to=xxx&limit=50
- [ ] 替代内存inbox，重启不丢消息
- [ ] 消息TTL自动清理

## Phase 4: 监控Dashboard
- [ ] Web界面（轻量，可以用Hono或Express静态页面）
- [ ] 实时状态面板：
  - 在线session列表（名称、连接时间、来源hub/ip）
  - feishu-bridge状态（连接状态、消息计数）
  - Hub运行指标（uptime、消息吞吐量、错误率）
- [ ] 消息流可视化：
  - 实时消息流（谁发给谁、什么时候）
  - 消息搜索/过滤
  - 失败消息高亮
- [ ] 告警：
  - session异常断连通知
  - bridge崩溃通知
  - 消息投递失败通知
- [ ] 日志查看器：
  - Hub日志在线查看
  - bridge日志在线查看
  - 按时间/级别/关键词过滤

## Phase 5: 飞书消息类型扩展
- [ ] 图片消息：下载并转为可访问链接
- [ ] 文件消息：保存到本地，提供路径
- [ ] 富文本(post)消息：解析为markdown
- [ ] 飞书卡片回复：agent回复用卡片格式
  - 代码块、折叠区域
  - 操作按钮（确认/取消）
  - 状态标签（成功/失败/进行中）

## Phase 6: 多App动态加载
- [ ] feishu-apps.json热加载（file watcher）
- [ ] 新增app自动启动worker_thread
- [ ] 删除app自动停止worker
- [ ] 修改app配置自动重启对应worker
- [ ] 不重启bridge进程

## Phase 7: 安全加固
- [ ] Hub认证增强：per-session token替代共享token
- [ ] 飞书消息加密传输
- [ ] 敏感信息过滤（不转发包含密码/token的消息）
- [ ] 操作审计日志

## 其他待考虑
- [ ] 消息去重：群消息被多个bot收到时避免重复处理
- [ ] 消息优先级：紧急消息优先投递
- [ ] 限流保护：防止消息风暴压垮Hub
- [ ] Webhook outgoing：Hub可以将消息推送到外部HTTP endpoint
- [ ] npm发布0.2.0版本（同步所有新功能到npm/ClawHub）
