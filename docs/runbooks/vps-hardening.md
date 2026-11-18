# VPS 加固与升级顺序

## 顺序

1. 在仓库外创建完整回滚归档，并确认权限为 0700/0600。
2. 部署或升级 `cc-relay-forge` 服务端容器与 systemd 服务，确认健康接口与协议版本。
3. 安装 Claude settings.json 和 idle-compaction.json，设置 0600、属主 1000:1000。
4. 安装 nftables 命名表与 keep-docker drop-in。
5. 运行 nft -c -f 校验，reload 后检查 Docker NAT、DNS 和 HTTPS 出口。
6. 启用 BBR/fq、zram、journald 限额和禁止自动硬重启。
7. 安装 safe-reboot.timer，先执行 --dry-run。
8. 最后安装通知旁路；EnvironmentFile 只存在服务器 0600 私密路径。

## 关键验证

~~~sh
sudo nft -c -f /etc/nftables.conf
sudo systemctl daemon-reload
sudo systemctl reload nftables
sudo systemctl restart nftables
sudo iptables -t nat -S POSTROUTING
sudo docker exec CCRF_CONTAINER getent hosts api.anthropic.com
sudo docker exec CCRF_CONTAINER sh -c 'curl -fsS https://api.anthropic.com/ >/dev/null'
~~~

重启 nftables 后必须确认 Docker 的 MASQUERADE 仍存在。若 NAT 消失，立即停止继续升级，恢复备份和 Docker 网络，再检查 drop-in 是否被覆盖。

## 不变项

- 不把真实 provider、OAuth、服务令牌、证书或 sessions.sqlite 复制到仓库。
- 不加入 OTEL_LOGS_EXPORTER=none、DISABLE_TELEMETRY=1 或等价的全局遥测关闭项。
- 不用 flush ruleset 作为 stop 动作。


## 通知旁路

复制 deploy/vps/config/ccrf-notify.env.example 到服务器私有路径并设置 0600；将 bot token 和 chat id 只写在那里。安装脚本后，确认数据库目录允许读取、状态目录由数据库属主拥有，再启用服务：

~~~sh
sudo install -m 0755 deploy/vps/scripts/ccrf-tg-notify.py /usr/local/bin/ccrf-tg-notify.py
sudo install -m 0644 deploy/vps/systemd/ccrf-tg-notify.service /etc/systemd/system/ccrf-tg-notify.service
sudo systemctl daemon-reload
sudo systemctl enable --now ccrf-tg-notify.service
sudo systemctl status --no-pager ccrf-tg-notify.service
~~~

通知正文固定为审批、输入、完成、失败或取消状态；不读取、不发送项目路径、代码、会话正文或令牌。服务启动后会根据 sessions.sqlite 文件属主降权，并以只读 URI 打开数据库。若数据库表结构或属主不匹配，服务应保持失败可见，先修复映射，不要放宽为可写或全盘扫描。
