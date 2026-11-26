# Folio · Claude Code 工作台

Folio 是自托管的 Claude Code 工作台，**分两层**：A 层 `cc-sandbox` 把 Claude Code 关进一次性容器里执行，B 层 Folio 负责中文输入、隐私审阅、会话管理和发布。用户用中文提需求，进入 Claude Code 之前已经变成英文；Claude Code 的读写都发生在一个固定出口的沙箱里，容器本身可以随时销毁重建，状态留在卷里。

本仓库是 **B 层**。A 层是独立服务，接口契约见下文 [A 层 § 接口契约](#接口契约)。

## 功能

- **中文工作流** — 输入支持静默翻译、逐步确认、直接发送三种模式。
- **隐私审阅** — 本地规则识别姓名、邮箱、电话、身份证、银行卡、内网 IP、凭证、JWT、私钥与带凭证 URL；每项可选占位、原样透传、非密钥 ENV 或重写。译文里残留中文、或占位符数量对不上，会直接拒绝发送。
- **流式对话** — 执行中可发补充要求；回复支持中文、原文、双语；工具详情默认折叠。
- **用量与控制** — 实时切换模型、思考强度、工具审核模式；查看上下文占用、技能、MCP、后台任务，支持检查点回滚。
- **预览** — 文件、图片、Markdown、SVG，以及禁用 `allow-same-origin` 的隔离 HTML。
- **发布** — `publish_file` 生成静态报告，`publish_service` 起临时服务。两者沿用同一登录，不需要额外域名。
- **沙箱管理** — 容器启停与重建、真实 PTY Shell、会话统计、卷备份与删除、紧急断网。
- **客户端** — 浅色/深色主题，手机抽屉布局，另有 Android 客户端。

## 架构

```
浏览器 ──HTTPS──▶ Folio (B 层) ──spawnClaudeCodeProcess / stdio──▶ cc-sandbox (A 层) ──docker exec──▶ 容器内 Claude Code
```

- **Folio** 拿到 SDK 要 spawn 的进程参数，不自己开进程，而是把整段对话经 HTTP 推给 A 层。
- **A 层**在已有容器里 `docker exec` 起 Claude Code，双向转发 stdio，返回 stdout/stderr 与退出码。
- **容器**是一次性的，`/work` 和 `~/.claude` 挂在卷上，所以重建容器不丢代码和会话。

```
B 层  部署后 :8004 工作台 / :8124 发布网关（开发为 :5173，`npm start` 默认 :3210）
      SQLite + 加密设置 + 报告
A 层  :8123 loopback / 容器 ccsb-<repo> / 卷 cc-work-<repo>、cc-state-<repo>
```

### A 层 · `cc-sandbox`

只负责**执行**，不持有策略：不判断哪个仓库、什么时候能跑、谁有权限。这些都在 B 层。

| 项 | 约定 |
|---|---|
| 监听 | `127.0.0.1:8123`，仅 loopback |
| 鉴权 | 除 `/health` 外全部要求 `Authorization: Bearer <token>`，token 从 0600 文件按请求读取，轮换不需重启 |
| 容器 | 每仓库一个长驻容器，命名 `ccsb-<repo>`，非 root 用户 `ccuser`，独立 bridge 网络 |
| 卷 | `cc-state-<repo>` → `/home/ccuser/.claude`，`cc-work-<repo>` → `/work` |
| 镜像 | `cc-sandbox:1`，内置 Claude Code 原生二进制 |

容器是**一次性**的，卷才是持久的：销毁重建容器后工作区和会话记录都还在，B 层用 `--resume <session_id>` 接回对话。

#### 接口契约

```
POST   /sandbox/start            起容器（已运行则返回 already-running）
POST   /sandbox/stop             停容器，卷保留
POST   /sandbox/recreate         销毁重建，卷保留
GET    /sandbox/status?repo=…    容器状态、镜像、卷名
POST   /sandbox/exec             ★ 跑 Claude Code，双向 stdio
POST   /sandbox/network/cut      断网，容器不退
POST   /sandbox/network/restore  恢复网络
POST   /sandbox/image/rebuild    重建镜像
GET    /sandbox/image/status     镜像信息与 Claude Code 版本
GET    /volumes                  卷列表、大小、是否被占用
POST   /volumes/:id/backup       导出卷
DELETE /volumes/:id              删卷（?force=true 强删）
POST   /sandbox/git/refresh      重推 Git 凭据
```

`/sandbox/exec` 是唯一形态特殊的一个。Agent SDK 用 `--input-format stream-json`，整个对话从 stdin 流入，所以**配置走请求头、body 全是 stdin**：

```
POST /sandbox/exec
  x-ccsb-repo    : 仓库 key
  x-ccsb-command : 可执行文件（绝对路径会被重映射到容器内的 Claude Code）
  x-ccsb-args    : JSON 数组
  x-ccsb-env     : JSON 对象
  x-ccsb-cwd     : 容器内工作目录，默认 /work
  body           : 原始 stdin 字节

响应：Docker 风格多路复用帧，8 字节帧头 [1B 流号][3B 填充][4B 大端长度]
      1 = stdout，2 = stderr，末帧 3 且 4 字节负载为退出码
```

`server/sandbox.ts` 实现了这个适配器。`scripts/sandbox-smoke.mjs` 可以在真实 A 层上跑通传输层，不发任何模型请求。

### B 层 · 本仓库

Fastify + React/Vite，Node.js **22.18+**，驱动 Claude Agent SDK **0.3.309**（30 个公开 Query 控制方法都有入口）。单进程、单人部署。

- `server/` — API、会话、隐私规则、翻译、沙箱客户端、发布网关客户端
- `src/` — 前端
- `deploy/` — systemd 单元、nginx 配置、部署脚本、发布网关 `report-gateway.py`
- `apps/android/` — Android 客户端

## 这套形状在解决什么

爬取的、生成的、粘贴进去的东西都会进模型上下文。所以边界要放在**能控制的地方**：输入侧、凭证侧、出口侧。

**一个固定出口。** 整个栈跑在一台常驻主机上，容器走固定 bridge 网络，出口 IP 不变。不要在前面挂会跳国家的代理池——从行为上看，频繁换出口比换别的更可疑，也会让会话记录对不上。

**输入先英文化。** 首轮需求在 B 层翻译成英文再交给 Claude Code。翻译只处理**用户 ↔ Claude Code 的发言**，以最近五轮完整往返为参考，代码块和行内代码冻结不译。

**凭证不进容器环境。** Claude Code 会主动把 `CLAUDE_CODE_OAUTH_TOKEN` 从子进程环境里擦掉，所以这个 token 走环境是安全的；但 `GH_TOKEN`、`GITHUB_TOKEN`、`ANTHROPIC_*` 这类**不会**被擦，跑一次 `env` 就进了模型上下文。因此 Git 凭据写成容器内的 `~/.git-credentials`（0600），不走环境变量；A 层用 `docker exec` 而不是 `docker run -e` 注入，前者不落盘、inspect 也读不到，后者会把值明文写进 `/var/lib/docker/containers/<id>/config.v2.json`。

### 边界说明

**这套架构不隐藏什么，只减少暴露面。**

B 层只处理用户自己打的字。Claude Code 读到的文件内容、跑命令的输出，是**原样透传**的——用户可能在编辑中文文件，把它也改掉就写不了中文代码了。代价是：仓库里的中文注释、命令输出里的中文，后续轮次照样会发出去。

所以准确的说法是**首轮指令为英文，后续可能夹带中文**。要彻底消除只能把仓库内容也过一遍，但那会破坏正常编辑，是有意不做的取舍。

同理，固定出口只保证"不因为换 IP 而显得异常"，不构成任何形式的隐身。

## 快速开始

需要 Node.js **22.18 或更高版本**，一个可访问的 **cc-sandbox 兼容服务**，以及一个 OpenAI 兼容的翻译接口。默认所有服务端口都只监听本机。

```sh
npm ci
cp .env.example .env
npm run dev
```

打开 http://127.0.0.1:5173。首次打开时按向导设置访问密码、Claude 授权与翻译接口。长期 token 可在可信终端执行 `claude setup-token` 获取，也可从沙箱管理发起原生 Claude 登录。

| 命令 | 用途 |
|---|---|
| `npm run dev` | 启动开发前端和 API |
| `npm run build` | TypeScript 检查与生产构建 |
| `npm start` | 从 `PORT`（默认 3210）同源提供 API 和已构建页面 |
| `npm test` | 运行回归测试。使用本机模拟服务，无需真实 token |
| `node scripts/sandbox-smoke.mjs` | 在沙箱宿主机上验证 A 层传输，不发模型请求 |

浅色和黑色主题都可选自定义背景。把透明 PNG 保存为 `src/assets/folio-wallpaper.png` 后重新构建；这份本地个性化资源由 Git 忽略。

## 自托管

[使用指南](docs/guide.md) · [部署指南](deploy/README.md) · [环境变量](.env.example) · [第三方致谢](THIRD_PARTY_NOTICES.md)

完整部署需要三样东西：

1. **A 层 `cc-sandbox`** — 独立安装，token 放 `/etc/cc-sandbox/token`
2. **Folio 本体** — `deploy/install-la.sh` 安装，`/opt/folio/releases/` 放版本
3. **发布网关** — `deploy/report-gateway.py`，`folio-reports.service`，监听 `127.0.0.1:8124`

工作台采用单进程、单人部署模型。持久化目录包含 SQLite、加密设置和产物，备份时需保存对应密钥。原生沙箱工作卷和会话卷单独维护，可能保存明文。隐私检查基于规则与手动审阅，覆盖范围取决于输入类型和用户选择。

## 发布与报告

主页面的 Reports 入口打开 `/report`，所有发布项位于 `/report/<id>/`，沿用 Folio 登录，不需要额外 DNS。

- **静态报告** — 快照独立于原会话保存，AES-256-GCM 加密；最多 1,000 个文件、25 MB，拒绝符号链接和路径越界。
- **动态服务** — 跑在独立的非 root 容器里，工作区只读，可写 `/tmp`，不挂载 Claude 状态和登录凭证；CPU、内存、进程数受限，同时最多六个，默认运行两小时、最长一天。
- **网关** — 只监听 `127.0.0.1:8124`，只代理已登记发布项，不能指定任意目的地址。HTTP、SSE 和 WebSocket 都支持。Folio 的 Cookie 与 Authorization 不会转发给应用。

## Android

在 [Releases](https://github.com/GYPp1us/folio/releases) 下载 APK 和校验和。Android 10 或更高版本可用。APK 连接 [Folio 工作台](https://folio.arcol.site)，首次打开时输入该站点的访问密码。

原生源码和构建说明见 [Folio Android](apps/android/README.md)。
