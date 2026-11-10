# Folio · Claude Code 工作台

Folio 通过官方 Claude Agent SDK 驱动沙箱里的 Claude Code。它提供中文工作流、隐私审阅、流式对话和用量视图，也能在同一登录下分享报告与临时服务。

- 输入支持静默翻译、逐步确认与直接发送。识别到敏感内容时，可选择占位、透传、非密钥 ENV 或重写。
- 执行时可发送补充要求。回复支持中文、原文及双语，工具详情默认折叠。
- 支持文件与图片、Markdown、SVG 和隔离的 HTML 预览。沙箱管理包含 Shell、会话统计和卷操作。
- 提供浅色和黑色主题。手机端使用抽屉导航和竖屏布局。

## 快速开始

需要 Node.js **22.18 或更高版本**，以及可访问的 **cc-sandbox 兼容服务**。翻译使用 OpenAI 兼容接口。默认所有服务端口都应只监听本机。

```sh
npm ci
cp .env.example .env
npm run dev
```

打开 http://127.0.0.1:5173。通过 .env 指定沙箱地址和 token 文件，首次打开时按向导设置访问密码、Claude 授权与翻译接口。可以在可信终端执行 `claude setup-token` 获取长期 token，也可从沙箱管理发起原生 Claude 登录。

| 命令 | 用途 |
|---|---|
| `npm run dev` | 启动开发前端和 API |
| `npm run build` | TypeScript 检查与生产构建 |
| `npm start` | 从默认端口 3210 同源提供 API 和已构建页面 |
| `npm test` | 运行回归测试。测试使用本机模拟服务，无需真实 token |

浅色和黑色主题都可选自定义背景。把透明 PNG 保存为 `src/assets/folio-wallpaper.png` 后重新构建；这份本地个性化资源由 Git 忽略。

## 自托管

[使用指南](docs/guide.md) · [部署指南](deploy/README.md) · [环境变量](.env.example) · [第三方致谢](THIRD_PARTY_NOTICES.md)

工作台采用单进程、单人部署模型。持久化目录包含 SQLite、加密设置和产物，备份时需保存对应密钥。原生沙箱工作卷和会话卷单独维护，可能保存明文。隐私检查基于规则与手动审阅，覆盖范围取决于输入类型和用户选择。

## Android

在 [Releases](https://github.com/GYPp1us/folio/releases) 下载 APK 和校验和。Android 10 或更高版本可用。APK 连接 [Folio 工作台](https://folio.arcol.site)，首次打开时输入该站点的访问密码。
