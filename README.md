# tg2cloud

把网页或 Telegram Bot 收到的文件保存到本地、Dropbox 或 Google Drive，并通过带登录鉴权的 Web 控制台统一管理。

## 功能

- 管理员登录与服务端接口鉴权，未登录无法读取、上传、下载或删除文件
- HttpOnly 签名会话、登录失败限速与跨来源写操作保护
- Web 文件上传、搜索、筛选、预览、下载和删除
- Telegram Bot 接收文档、图片、视频、音频并自动转存
- 本地文件存储
- Dropbox OAuth 授权与分片上传
- Google Drive OAuth 授权与可恢复上传
- 响应式文件控制台，支持手机和桌面端
- Docker Compose 一键启动

## 快速开始

复制环境变量并修改管理员密码与会话密钥：

```bash
cp .env.example .env
```

必须修改：

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=请设置至少12位的强密码
AUTH_SECRET=请生成至少32个字符的随机字符串
```

生成随机密钥示例：

```bash
openssl rand -hex 32
```

启动服务：

```bash
docker compose up -d --build
```

- Web 控制台：<http://localhost:47832>
- 后端健康检查：<http://localhost:51947/health>

除健康检查、登录接口和带随机 state 校验的 OAuth 回调外，所有 `/api` 接口均要求有效登录会话。

## Linux 一键部署

支持 Debian/Ubuntu 与 Fedora/RHEL/CentOS/Rocky/AlmaLinux。先将域名解析到服务器，然后运行：

```bash
sudo bash ./deploy.sh --domain files.example.com
```

没有域名时可显式使用 HTTP：

```bash
sudo bash ./deploy.sh --domain http://服务器IP
```

脚本会安装或复用 Docker 与 Caddy、构建容器、配置反向代理和防火墙，并等待后端健康检查通过。首次部署若仍使用示例凭据，脚本会自动生成管理员密码和会话密钥；管理员密码会在部署完成时显示一次，同时保存在权限为 `0600` 的 `.env` 中。再次运行会保留已有凭据，并在修改 `.env` 或 Caddy 配置前创建备份。

可选参数：

```text
--skip-system-update   跳过系统软件包升级
--skip-firewall        不修改 UFW/firewalld
```

## Dropbox 配置

1. 在 [Dropbox App Console](https://www.dropbox.com/developers/apps) 创建 Scoped access App。
2. 开启 `files.content.write`、`files.content.read`、`account_info.read`、`sharing.write`。
3. 添加 Redirect URI：

```text
http://localhost:51947/api/storage/dropbox/callback
```

4. 登录控制台，在“配置 Dropbox”中填写 App Key 与 App Secret 后授权。

生产环境请把回调地址替换为：

```text
https://你的后端域名/api/storage/dropbox/callback
```

## Google Drive 配置

这里使用 Google Drive 而不是 Google Cloud Storage：Drive 支持用户直接选择 Google 账号授权；Cloud Storage 仍需单独配置项目、计费、Bucket 与 IAM，无法只靠 Google 登录完成。

1. 在 Google Cloud Console 创建 OAuth 2.0 Web Client。
2. 启用 Google Drive API。
3. 在 `.env` 中填写：

```env
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

4. 添加 Redirect URI：

```text
http://localhost:51947/api/storage/google/callback
```

5. 重启后端，在控制台中连接 Google Drive。

## Telegram Bot

在 `.env` 中填写：

```env
TELEGRAM_BOT_TOKEN=123456:ABCDEF
```

启动后，把文件发送给 Bot 即可保存到当前存储源。

## 生产环境安全

- 使用 HTTPS，并将 `PUBLIC_API_URL`、`CORS_ORIGIN`、`VITE_API_URL` 设置为实际地址。
- HTTPS 部署应设置 `AUTH_COOKIE_SECURE=true`；未显式设置时会根据 `PUBLIC_API_URL` 是否为 HTTPS 自动推断。
- 通过反向代理部署时设置 `TRUST_PROXY_HOPS` 为实际代理层数；一键部署会自动设为 `1`。
- 不要提交 `.env`、Dropbox/Google 密钥、Telegram Token 或数据目录。
- 修改 `AUTH_SECRET` 会使现有登录会话立即失效。
