# tg2cloud

把 Telegram 文件和网页上传文件保存到云端。当前内置本地存储与 Dropbox 存储，支持通过 Web 页面添加 Dropbox OAuth 配置，然后将后续上传直接写入 Dropbox。

## 功能

- Web 文件上传、列表、下载、删除。
- Telegram Bot 接收文档、图片、视频、音频并转存。
- Dropbox OAuth 授权，自动保存 refresh token。
- Dropbox 小文件直传，大文件 upload session 分片上传。
- 本地存储回退，未配置 Dropbox 时可直接运行。
- Docker Compose 一键启动。

## 快速开始

```bash
cp .env.example .env
vi .env

docker compose up -d --build
```

打开前端：

```text
http://localhost:47832
```

后端 API：

```text
http://localhost:51947
```

## Dropbox 配置

1. 打开 <https://www.dropbox.com/developers/apps> 创建 App。
2. 选择 Scoped access。
3. Access type 可选择 App folder 或 Full Dropbox。
4. 权限勾选：
   - `files.content.write`
   - `files.content.read`
   - `account_info.read`
   - `sharing.write`
5. 在 Dropbox App 的 Redirect URIs 中添加：

```text
http://localhost:51947/api/storage/dropbox/callback
```

生产环境请替换成：

```text
https://你的后端域名/api/storage/dropbox/callback
```

6. 在 Web 设置页填写 App Key / App Secret，点击授权。

## Telegram Bot 配置

在 `.env` 中填写：

```env
TELEGRAM_BOT_TOKEN=123456:ABCDEF
```

启动后，把文件发送给 Bot 即可自动保存到当前存储源。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `PORT` | 后端端口，默认 `51947` |
| `PUBLIC_API_URL` | 后端公网地址，用于 OAuth callback 和前端访问 |
| `CORS_ORIGIN` | 前端来源，默认 `http://localhost:47832` |
| `DATA_DIR` | 后端数据目录，默认 `./data` |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token，可选 |

## 不会提交的文件

仓库已通过 `.gitignore` 排除：

- `node_modules/`
- `dist/` / `build/`
- `.env` / `.env.*`
- `data/` / `uploads/` / `chunks/`
- 密钥、证书、日志、编辑器配置
