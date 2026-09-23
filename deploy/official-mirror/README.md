# FsTTY 官方更新镜像

镜像地址为 `https://f.qkw.io/fstty/updater/latest.json`。此目录只服务应用自动更新，不提供新的手动下载入口。服务器每五分钟读取已公开的 GitHub 最新正式 Release；下载、摘要和更新元数据均通过检查后，才将新版本公开。GitHub 不可达或校验失败时，原有 `latest.json` 保持不变。

## 部署到 amazon-ubuntu-1

1. 确认服务器能访问 `api.github.com`、`github.com` 及其 HTTPS 附件重定向地址。确认 `f.qkw.io` 的 A 记录指向该实例，并在 AWS 安全组放行入站 TCP 80 和 443。80 用于证书签发与 HTTP 跳转，客户端更新必须能从公网访问 443。证书及公网 443 均验证通过前，不要交付指向该镜像的客户端。
2. 创建无登录权限的 `fstty-mirror` 系统账号。将 `pull_release.py` 安装到 root 拥有的 `/usr/local/lib/fstty-mirror/`，将两个 systemd unit 安装到 `/etc/systemd/system/`。创建 `/srv/fstty-mirror/public`（镜像账号可写、Web 服务只读，权限 `0755`）、`/srv/fstty-mirror/staging` 和 `/srv/fstty-mirror/state`（后两者仅镜像账号可读写，权限 `0700`）；三者须在同一文件系统。程序与 unit 不得由 Web 服务或普通用户修改。
3. 安装 `fstty-http.conf` 到 `/etc/nginx/conf.d/`，创建 `/var/www/letsencrypt/.well-known/acme-challenge/`，运行 `nginx -t` 并重载 Nginx。安装 Certbot 后，用 `certbot certonly --webroot -w /var/www/letsencrypt -d f.qkw.io` 签发证书。将 `nginx-reload.sh` 安装到 `/etc/letsencrypt/renewal-hooks/deploy/` 并赋予执行权限，使续期后自动重载 Nginx。证书就绪后安装 `fstty-https.conf` 到 `/etc/nginx/conf.d/`，再次运行 `nginx -t` 并重载。两个配置只新增 `f.qkw.io` 虚拟主机，不覆盖已有站点。仅 `/fstty/updater/latest.json` 和 `/fstty/releases/*` 对外提供镜像文件，暂存与状态目录不得暴露。
4. 重载 systemd，手动运行一次 `fstty-mirror.service`，再启用 `fstty-mirror.timer`。检查 `journalctl -u fstty-mirror.service`、`/srv/fstty-mirror/state/status.json`、`systemctl list-timers fstty-mirror.timer certbot.timer`。失败状态会记录错误及时间，已发布版本不会被覆盖。
5. 先在服务器用 `curl --resolve f.qkw.io:443:127.0.0.1` 核对 HTTPS 元数据与安装包，再从中国大陆网络分别获取元数据及其中的完整安装包，核对 TLS 证书、两个 Windows 平台入口、签名和 SHA-256；最后用 Windows 测试客户端完成一次应用更新。服务器每次轮询只查询 GitHub Release 信息，同版本且附件摘要不变时不会重新下载安装包。

发布 CI 不等待镜像同步。GitHub 发布后，在正常网络下镜像可能晚一个五分钟轮询周期；服务器无法访问 GitHub 时会继续保留旧版本。应用自动模式只有在 GitHub 更新检查失败或两秒内未完成时才使用官方镜像；GitHub 检查成功后若安装包下载失败，不会自动改源。

本次发布继续同步 CNB，供旧客户端过渡。待新版可从官方镜像完成实际更新后，在下一次更新中单独移除 CNB 发布步骤与脚本；CNB 历史附件是否清理由维护者决定。

## 本地测试

在此目录运行 `python -m unittest test_pull_release.py`。测试只使用生成数据和临时目录，不访问真实 Release。
