# 公开发布前门禁

发布前运行：

~~~sh
python3 security/verification/release_gate.py
~~~

门禁是只读的。它要求当前工作树干净，并且所有可达提交都使用仓库规定的通用项目身份。它不会打印疑似密钥、token、密码、私钥正文或环境变量值，只打印类别和仓库相对路径。

## 检查内容

- Git 历史的 Author/Committer 身份
- 工作树是否有暂存、未暂存或未跟踪文件
- 文件名、隐藏配置、备份目录、日志、数据库、证书和私钥扩展名
- 符号链接和扩展属性
- 私钥头、常见平台 token、JWT、密钥赋值和长十六进制值
- Git 本地配置中可能带认证信息的 remote URL
- 超过 8 MiB 的单个文件

发现问题时，先按输出的类别和相对路径处理，再重新运行门禁。门禁无法使用 Git、读取文件、读取扩展属性或检查仓库时会返回非零状态；它不会把“无法检查”当成通过。

## 推荐顺序

~~~sh
find . -type d -name __pycache__ -prune -exec rm -rf {} +
npm run check
python3 security/verification/public_scan.py
python3 security/verification/release_gate.py
git status --short
git log --format='%an <%ae> | %cn <%ce>' -5
~~~

最后两条命令用于人工确认工作树干净、提交身份仍然是通用项目身份。若之后新增截图、压缩包、二进制、Issue、Release 附件或 CI 日志，发布前应重新运行门禁并单独检查这些新增内容。
