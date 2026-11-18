# 安全定时重启

## 安装

~~~sh
sudo install -m 0755 deploy/vps/scripts/safe-scheduled-reboot.py /usr/local/sbin/safe-scheduled-reboot.py
sudo install -m 0755 deploy/vps/scripts/safe-scheduled-reboot.sh /usr/local/sbin/safe-scheduled-reboot.sh
sudo install -m 0644 deploy/vps/systemd/safe-reboot.service /etc/systemd/system/safe-reboot.service
sudo install -m 0644 deploy/vps/systemd/safe-reboot.timer /etc/systemd/system/safe-reboot.timer
sudo systemctl daemon-reload
sudo systemd-analyze verify safe-reboot.service safe-reboot.timer
sudo /usr/local/sbin/safe-scheduled-reboot.sh --dry-run
sudo systemctl enable --now safe-reboot.timer
~~~

## 判断条件

脚本只在存在 reboot-required 或北京时间周日时进入评估。以下任一项繁忙就延期：

- apt、apt-get、dpkg、unattended-upgrade、aptitude、certbot 进程或文件锁
- 容器内 Claude 进程
- sessions.sqlite 中 metadata.activeRun

数据库不可读、Docker 不可查询或锁状态不确定时，脚本以 defer 结束，不执行重启。日志只记录状态和原因，不记录会话正文、路径或令牌。

## 回滚

~~~sh
sudo systemctl disable --now safe-reboot.timer
sudo rm -f /etc/systemd/system/safe-reboot.service
sudo rm -f /etc/systemd/system/safe-reboot.timer
sudo rm -f /usr/local/sbin/safe-scheduled-reboot.sh /usr/local/sbin/safe-scheduled-reboot.py
sudo systemctl daemon-reload
~~~
