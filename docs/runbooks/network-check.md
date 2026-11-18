# 网络验收

security/verification/network_check.py 是只读的 fail-closed 网络验收工具。它只读取环境、解析 DNS、建立连接、读取 Docker/iptables 状态，不修改路由、防火墙、代理、容器或系统配置。

## 检查内容

| 检查名 | 目的 | 运行环境 |
| --- | --- | --- |
| proxy_https | 通过显式 HTTP/HTTPS 代理访问一个 HTTPS 目标 | macOS/Linux |
| direct_https | 不使用环境代理，直接访问一个 HTTPS 目标 | macOS/Linux |
| dns | 解析指定名称并打印地址 | macOS/Linux |
| ipv4 | 对指定 IPv4 目标建立 TCP 连接 | macOS/Linux |
| ipv6 | 对指定 IPv6 目标建立 TCP 连接 | macOS/Linux，目标必须有 IPv6 |
| udp | 向 UDP echo 服务发送并等待回包 | macOS/Linux，必须有 echo 服务 |
| host_ports | 检查一组主机 TCP 端口 | macOS/Linux |
| docker_nat | 检查容器运行状态和 iptables POSTROUTING MASQUERADE | Linux + Docker + iptables |

检查不通过就返回非零。缺少变量、外部命令、权限或目标不可达都算失败；工具不会把“跳过”当成功。

## 配置示例

所有值都来自环境变量。下面的域名、地址和端口是占位符：

~~~sh
export CCRF_PROXY_URL='http://PROXY_HOST.example.invalid:PROXY_PORT'
export CCRF_PROXY_TARGET_URL='https://SERVICE_HOST.example.invalid/health'
export CCRF_DIRECT_TARGET_URL='https://SERVICE_HOST.example.invalid/health'

export CCRF_DNS_NAME='SERVICE_HOST.example.invalid'
export CCRF_DNS_PORT='443'

export CCRF_IPV4_TARGET='IPV4_TARGET.example.invalid'
export CCRF_IPV4_TARGET_PORT='443'
export CCRF_IPV6_TARGET='IPV6_TARGET.example.invalid'
export CCRF_IPV6_TARGET_PORT='443'

export CCRF_UDP_TARGET='UDP_ECHO_HOST.example.invalid'
export CCRF_UDP_PORT='9999'
export CCRF_UDP_FAMILY='ipv4'
export CCRF_UDP_EXPECTED='ccrf-network-check'

export CCRF_HOST_PORTS='SERVICE_HOST.example.invalid:8787,SERVICE_HOST.example.invalid:SSH_PORT'

export CCRF_CONTAINER='CCRF_CONTAINER_NAME'
export CCRF_CONTAINER_SUBNET='172.30.0.0/16'
~~~

实际部署时把占位符替换成私有配置；不要把填写后的环境文件提交 Git。

## 运行

列出检查名：

~~~sh
python3 security/verification/network_check.py --list
~~~

运行全部检查：

~~~sh
python3 security/verification/network_check.py --check all
~~~

只运行可在本机完成的浏览器/入口检查：

~~~sh
python3 security/verification/network_check.py \
  --check proxy_https \
  --check direct_https \
  --check dns \
  --check ipv4 \
  --check ipv6 \
  --check host_ports \
  --json
~~~

在 Linux VPS 上额外检查 Docker NAT：

~~~sh
python3 security/verification/network_check.py --check docker_nat
~~~

输出为 JSON 时，顶层 ok 为 false 就必须停止后续升级。文本输出中的 FAIL 需要保留到私有验收记录，不能把包含真实地址的输出复制到公开仓库。

## 解释边界

- HTTPS 检查证明 TLS/HTTP 传输路径能得到响应，不代表业务认证成功。
- DNS 检查只证明解析器返回地址；要证明代理 DNS，分别运行 direct_https 和 proxy_https，并观察代理日志或使用专用解析目标。
- UDP 没有握手；本工具要求 echo 回包，只有 send 成功而没有回包会失败。
- host_ports 只证明 TCP 连接建立；不代表端口后的应用健康。
- docker_nat 只读取 docker inspect 和 iptables；它不能证明容器内部 DNS 或 API 业务成功。
- macOS 通常没有宿主机 iptables POSTROUTING 表，因此 docker_nat 应在 Linux VPS 上运行；不要为了让 macOS 通过而改变规则。
- 官方 Claude Code 文档说明模型流量使用 HTTP/HTTPS 代理，不要把本工具的 SOCKS 检查误认为 Claude Code 支持 SOCKS。浏览器 OAuth 的独立 SOCKS 路径仍需单独验收。
