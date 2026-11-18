# 通知旁路契约

deploy/vps/scripts/ccrf-tg-notify.py 是宿主机旁路进程。它只读会话数据库（支持 `events` 与兼容 `sessions` 表），按数据库文件属主降权，然后发送固定状态文案。它不读取或发送项目路径、会话正文、代码、令牌和完整 metadata。

## 数据库契约

通知器当前读取以下最小结构：

~~~sql
CREATE TABLE sessions (
  id TEXT,
  status TEXT,
  metadata TEXT
);
~~~

- 使用 SQLite 隐式 rowid 作为游标；rowid 必须单调递增。
- status 是以下值之一：awaiting_approval、awaiting_input、completed、failed、cancelled。
- metadata 是 JSON 对象；未知字段必须被忽略。
- 终态任务优先读取 durationSeconds、duration_seconds 或 elapsedSeconds。
- 没有显式时长时，可以用 startedAt/started_at/startTime/start_time 与 endedAt/ended_at/completedAt/completed_at/updatedAt/updated_at 计算。
- metadata 非法、表结构不匹配或数据库不可读时，进程应失败可见；不能把错误当成“没有事件”。

如果上游改变表名、status 字段或 metadata 编码，先更新契约、测试和迁移说明，再部署通知器。

## 发送规则

| status | 发送条件 | 固定文案 |
| --- | --- | --- |
| awaiting_approval | 新 rowid 且未发送过 | CC Relay Forge: approval required |
| awaiting_input | 新 rowid 且未发送过 | CC Relay Forge: input required |
| completed | duration >= MIN_RUN_SECONDS 且未发送过 | CC Relay Forge: task completed |
| failed | duration >= MIN_RUN_SECONDS 且未发送过 | CC Relay Forge: task failed |
| cancelled | duration >= MIN_RUN_SECONDS 且未发送过 | CC Relay Forge: task cancelled |

短任务不发送完成/失败/取消消息。审批和输入事件立即发送。状态文件只保存 last_rowid 和已经发送的 rowid/status，权限为 0600。

## 凭据和权限

EnvironmentFile 只在服务器私有路径，权限 0600：

- TELEGRAM_BOT_TOKEN
- TELEGRAM_CHAT_ID
- CCRF_DB
- CCRF_NOTIFY_STATE
- MIN_RUN_SECONDS
- POLL_SECONDS

systemd 服务不把 token 写入命令行或日志。数据库打开使用 SQLite read-only URI；服务不能写入 sessions.sqlite、WAL 或 SHM。

## 验收

~~~sh
sudo systemctl status --no-pager ccrf-tg-notify.service
sudo stat -c '%a %U:%G %n' /etc/ccrf-notify.env /var/lib/ccrf-notify/state.json
~~~

真实通知验收只发送固定测试状态，不把 token、chat id、URL、数据库内容或手机截图写入公开仓库。
