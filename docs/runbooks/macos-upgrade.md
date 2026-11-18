# macOS 客户端与 OAuth 隔离浏览器

## 前置条件

1. 记录当前桌面端与本地服务版本和连接状态。
2. 将私有配置备份到仓库外的 0700 目录；敏感文件使用 0600。
3. 本项目自带的 Electron 桌面壳 (`clients/desktop`) 已通过 `link-router.mjs` 原生隔离 Claude OAuth 域名并转交 `claude-us-browser`，无需拆包修改外部 `.asar` 文件。

## 浏览器验收

确认 LaunchAgent 已提供 `CCRF_SOCKS_PORT` 后运行：

~~~sh
CCRF_SOCKS_PORT=28787 deploy/macos/compat/bin/claude-us-browser https://claude.ai/
~~~

验收出口地址、时区、语言、DNS 和 WebRTC 参数。不要把结果页截图、完整 URL、profile 或日志复制到仓库。
