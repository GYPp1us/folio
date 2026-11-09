# 在 Linux 上部署 Folio

示例使用 systemd、nginx、Node.js 22.18+ 和独立的 cc-sandbox 服务。安装脚本使用 `/usr/local/bin/node`；请先核对本机 Node 路径。后端监听 `127.0.0.1:8004`，沙箱和发布网关分别监听 `127.0.0.1:8123` 和 `127.0.0.1:8124`。

`install-la.sh`、`stage-la.sh` 和 `activate-la.sh` 是单机部署脚本。执行前把部署目录中出现的 `folio.example.com` 替换为你自己的域名，配置 DNS，并检查该站点的 nginx 配置。源代码也可用根目录 README 的 `npm start` 运行，由你自己的反向代理接入。

## 初次安装

1. 在目标主机运行兼容的 cc-sandbox，并将其服务 token 保存在 `/etc/cc-sandbox/token`。这个仓库提供沙箱客户端和发布网关；cc-sandbox 服务需独立安装。
2. 在工作副本执行 `npm ci` 与 `npm run build`。打包 `package.json`、`package-lock.json`、`dist/`、`server/`、`shared/` 和 `deploy/`，不包含本地环境变量或运行数据。
3. 上传归档及脚本，运行 `sudo bash install-la.sh <archive> <release>`。要启用独立的动态发布网关，安装后可对同一版本执行 `sudo bash /opt/folio/current/deploy/activate-la.sh <release>`。
4. 域名解析后执行 `sudo bash /opt/folio/current/deploy/enable-https.sh`。HTTP 虚拟主机在启用 HTTPS 前只提供 ACME 验证和提示页。若自配 nginx，请保留 Host、转发 HTTPS 协议、允许 WebSocket 并关闭 SSE 缓冲，参见 `nginx.conf`。
5. 从可信终端读取 `/etc/folio/bootstrap-token`，用它完成一次性安装向导。也可通过 SSH 本地转发 8004 端口完成首次配置。

## 版本与数据

- 版本位于 `/opt/folio/releases/`，服务从 `/opt/folio/current` 启动。升级先执行 `sudo bash stage-la.sh <archive> <release>`，再执行 `sudo bash activate-la.sh <release>`。
- 应用数据位于 `/var/lib/folio`。激活脚本先备份一致 SQLite、加密设置、密钥、附件与报告，再切换版本。健康检查失败时会回滚版本链接。
- `/etc/folio/` 中的引导文件、服务配置和沙箱 token 只应由服务账户或 root 读取。数据库与 `vault.key` 一起备份并限制读取权限。沙箱卷独立保留。
- 保留当前发布与一个可回滚版本即可。确认旧目录已不被运行进程使用后，可单独回收多余版本。

```sh
sudo systemctl status folio folio-reports --no-pager
curl -fsS http://127.0.0.1:8004/api/health
sudo journalctl -u folio -n 30 --no-pager
```
