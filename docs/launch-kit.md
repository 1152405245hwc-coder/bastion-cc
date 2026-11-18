# BastionCC（棱堡）品牌命名与宣发文案库

> 适用场景：GitHub 仓库简介、V2EX / Linux.do 技术帖、掘金/知乎长文、X (Twitter) 首发串、小红书/即刻短动态。所有文案仅引用仓库公开能力，不含任何个人隐私或真实部署参数。

---

## 一、品牌命名说明

- **英文主名**：**BastionCC**（`Bastion` 意为“棱堡/要塞”，`CC` 指代 `Claude Code`）
- **中文副名**：**棱堡**
- **一句话 Slogan**：
  - 中文：`把官方 Claude Code 稳在可信棱堡，把原生高缓存桌面工作台装进口袋。`
  - 英文：`Anchor native Claude Code CLI inside a trusted bastion—keep your prompt cache intact and control every session from Desktop, Web, CLI, and Mobile.`
- **备选灵感名（若需分仓/插件扩展）**：
  1. **BastionCC / 棱堡**（主推：安全边界清晰 + 抗风控稳定驻留 + 自研全栈感强）
  2. **AnvilCC / 铁砧**（适合偏重执行与工程锤炼调性）
  3. **LighthouseCC / 灯塔**（适合强调海外长驻与断线指路）

---

## 二、GitHub 仓库一句话简介 (About / Taglines)

- **GitHub Description**:
  `Self-hosted remote workbench for native Claude Code CLI (--resume). Preserves prompt caching on Pro/Max subscriptions with Desktop/Web/CLI clients, 6-digit pairing, encrypted history, and isolated account cages.`
- **Topics 标签建议**:
  `claude-code`, `ai-coding`, `self-hosted`, `electron`, `sqlite`, `prompt-caching`, `developer-tools`, `remote-agent`

---

## 三、V2EX / Linux.do / 掘金长文发布帖

### 标题候选
1. `我造了个「BastionCC 棱堡」：把官方 Claude Code CLI 稳在海外服务器，原生 --resume 保住 70%+ 缓存命中率，顺手补齐了桌面端/Web/手机配对工作台`
2. `Pro 订阅用反代 API 太烧额度？试试开源自建的 BastionCC：原生 CLI 续接 + 多账号隔离仓 + 深浅自适应三端控制台`

### 正文模板

大家用海外 VPS 跑 Claude Code 时，大概率都做过这道选择题：

- **路线 1：服务器开反代 API，本地接第三方 API 客户端**
  画面很好看，但通用 API 客户端往往按自己的系统提示词和历史数组重拼报文，直接打穿 Anthropic Prompt Cache 前缀对齐，`cache_read_input_tokens` 命中率一掉，**Pro / Max 订阅额度几轮就见底**。
- **路线 2：纯 SSH 连上去敲官方 CLI**
  缓存极高、额度极其耐用，但缺一个像样的跨端工作台：项目一多找不到历史会话、换手机不方便点高危审批、想导出对话或开分支只能手写脚本。

所以我做并开源了 **BastionCC（棱堡）**：**不改写官方模型请求，而是直接让服务端原生调用官方 `claude -p ... --output-format stream-json --resume <session_id>`，外面由一套完全自主、轻量清晰的 HTTP/SSE 控制面与三端客户端接管体验。**

#### 它核心解决了什么？

1. **保缓存、看指标**：每次执行自动沉淀 `providerSessionId`，同一会话续问自动拼接 `--resume`；顶部面板实时计算并展示 **Prompt Cache 缓存命中率（%）**。
2. **多账号隔离仓**：按会话选择 `accountProfile`，映射独立的 `CLAUDE_CONFIG_DIR` 与美西一致化环境指纹；Electron 桌面端内置外链路由器，打开 Claude 登录自动切隔离浏览器，不需要拆包魔改任何第三方软件。
3. **傻瓜式桌面端 + 网页工作台 + 一线 CLI**：
   - Electron 桌面端自带 **⚡ 一键本地服务 / 🏃 本机执行器**，点一下就能本地跑起来；支持原生系统选目录、深浅色自适应、对话草稿按会话保存、中文输入法按 Enter 防误触。
   - 会话支持 **按项目目录分组、实时搜索、重命名、分叉（Fork）、Markdown 一键导出**。
   - 终端党直接用内置远程 CLI：`ccrf chat backend-fix "排查鉴权问题"` 一行自动建会话、跑服务端并续接上下文。
4. **手机 6 位配对码 & 安全分层**：
   - 支持生成 5 分钟单次有效的 **6 位配对码**（免手抄长令牌），支持分权作用域（`control` / `read` / `runner`）和 TOTP 二次验证。
   - 敏感对话正文支持 **AES-256-GCM** 独立加密存入 `run_bodies`，事件时间线与通知器只读脱敏元数据。

欢迎试玩、提 Issue 或 PR！
- 代码与架构设计：[README.md](../README.md)
- 安全模型与独立测试：仓库内置 70+ 契约/集成/恢复测试及全历史隐私扫描门禁，开箱本地 `MockProviderAdapter` 无需账号即可体验全部工作流。

---

## 四、X (Twitter) 英文首发串 (Thread)

**Post 1 (Hook)**
> API reverse proxies look nice with 3rd-party GUIs—until they rewrite your prompt prefix, break Anthropic Prompt Caching, and burn through your Claude Pro quota in minutes.
>
> Meet **BastionCC**: keep native `claude --resume` anchored on your trusted server bastion, and control everything from a fast Desktop, Web, CLI & Mobile workbench. 🧵👇

**Post 2 (Core Architecture)**
> How BastionCC protects your quota & privacy:
> 1️⃣ Zero prompt rewriting: invokes official `claude --output-format stream-json --resume <id>` natively
> 2️⃣ Live `cacheHitRate` metrics right in the top bar
> 3️⃣ Per-account isolated config cages (`CLAUDE_CONFIG_DIR`) + consistent locale/TZ
> 4️⃣ 6-digit one-time pairing codes for phones & laptops

**Post 3 (Developer UX & Open Source)**
> Plus the quality-of-life features you expect from a modern AI workbench:
> • Adaptive Light/Dark Electron & zero-dependency Web UI
> • Project folder grouping, instant search, fork & Markdown export
> • IME-safe Enter-to-submit & per-session draft persistence
> • AES-256-GCM encrypted transcript bodies (`run_bodies`)
>
> Apache-2.0 open source, zero hidden third-party wrappers, 60-second mock quickstart ready.

---

## 五、小红书 / 即刻图文短文案

### 标题
`别再用反代 API 烧 Claude Pro 额度了！我开源了一个自托管原生工作台 BastionCC（棱堡）🏰`

### 正文
踩坑踩出来的架构觉悟：
用 API 反代接各种炫酷第三方客户端，每次发消息都在破坏 Prompt Cache，5 小时额度半小时就灰了；老老实实用服务器原生 `claude` CLI，额度耐用十倍，就是纯黑框终端太简陋……

于是自己动手把 **BastionCC（棱堡）** 做了出来👇
✅ **只跑官方原生 CLI**：自动用 `--resume` 接力上下文，顶部直接实时显示 **缓存命中率**，真正省额度！
✅ **多端遥控工作台**：Mac 桌面端 + 浏览器 Web 端 + 手机网页端全打通，自带高颜值自动深浅色切换，中文输入法敲 Enter 再也不会发半截话出去！
✅ **像做笔记一样管 AI 对话**：按项目目录分组、实时搜索、随时分叉思路（Fork）、一键导出 Markdown 归档。
✅ **6 位配对码 & 多号隔离**：手机扫一串 6 位数字 5 秒连上控制台；不同 Pro 账号互相隔离配置目录，稳如老狗。

重点：自带 **一键本地试跑模式 + 全自动化隐私门禁**，不绑死任何第三方魔改壳，Apache-2.0 完全开源！

`#ClaudeCode #AI编程 #开源项目 #独立开发者 #效率工具`
