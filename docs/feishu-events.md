# 飞书事件订阅配置

新建飞书应用后，在开发者后台 -> 事件订阅中配置以下内容。

## 连接方式

选择 **WebSocket** (长连接)，无需公网回调地址。

## 必选事件

| 事件 | 事件类型 | 用途 |
|------|----------|------|
| 接收消息 | `im.message.receive_v1` | 接收用户发送的 P2P / 群聊消息 |
| 卡片回调 | `card.action.trigger` | 接收交互卡片的按钮点击、表单提交 |

## 权限

见 `feishu-permissions.json`，可在开发者后台批量导入。

核心权限:
- `im:message` / `im:message:send_as_bot` -- 收发消息
- `im:message.p2p_msg:readonly` -- P2P 消息
- `im:message.group_at_msg:readonly` -- 群 @消息
- `im:resource` -- 下载图片/文件附件
