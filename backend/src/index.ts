import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import multer from 'multer';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import axios from 'axios';
import { Telegraf } from 'telegraf';
import { v4 as uuidv4 } from 'uuid';
import { PORT, PUBLIC_API_URL, CORS_ORIGIN, TMP_DIR, TELEGRAM_BOT_TOKEN } from './config.js';
import { addFile, getFile, getSettings, listFiles, removeFile, saveSettings, type StoredFile } from './store.js';
import { createProvider, DropboxStorageProvider } from './storage.js';

const app = express();
const upload = multer({ dest: TMP_DIR, limits: { fileSize: 2 * 1024 * 1024 * 1024 } });
const oauthStates = new Map<string, { appKey: string; appSecret: string; name?: string; redirectUri: string }>();

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN, credentials: true }));
app.use(express.json({ limit: '2mb' }));

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 180) || 'file';
}

async function activeProvider() {
  const settings = await getSettings();
  return createProvider(settings.activeProvider, settings.dropbox);
}

async function saveIncomingFile(tempPath: string, originalName: string, mimeType: string, source: StoredFile['source'], size?: number): Promise<StoredFile> {
  const settings = await getSettings();
  const provider = createProvider(settings.activeProvider, settings.dropbox);
  const ext = path.extname(originalName);
  const storedName = `${new Date().toISOString().replace(/[:.]/g, '-')}-${uuidv4()}-${safeName(path.basename(originalName, ext))}${ext}`;
  const storedPath = await provider.saveFile(tempPath, storedName, mimeType || 'application/octet-stream');

  const statSize = size ?? (await fsp.stat(tempPath).catch(() => ({ size: 0 }))).size;
  const file: StoredFile = {
    id: uuidv4(),
    name: originalName,
    storedName,
    mimeType: mimeType || 'application/octet-stream',
    size: statSize,
    source,
    provider: provider.name,
    path: storedPath,
    createdAt: new Date().toISOString(),
  };
  await addFile(file);
  await fsp.unlink(tempPath).catch(() => undefined);
  return file;
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('/api/files', async (_req, res, next) => {
  try {
    res.json(await listFiles());
  } catch (error) {
    next(error);
  }
});

app.post('/api/upload', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: '没有上传文件' });
    const file = await saveIncomingFile(req.file.path, req.file.originalname, req.file.mimetype, 'web', req.file.size);
    res.json({ success: true, file });
  } catch (error) {
    if (req.file?.path) await fsp.unlink(req.file.path).catch(() => undefined);
    next(error);
  }
});

app.get('/api/files/:id/download', async (req, res, next) => {
  try {
    const file = await getFile(req.params.id);
    if (!file) return res.status(404).json({ error: '文件不存在' });
    const settings = await getSettings();
    const provider = createProvider(file.provider, file.provider === 'dropbox' ? settings.dropbox : undefined);
    const stream = await provider.getFileStream(file.path);
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    stream.pipe(res);
  } catch (error) {
    next(error);
  }
});

app.get('/api/files/:id/preview-url', async (req, res, next) => {
  try {
    const file = await getFile(req.params.id);
    if (!file) return res.status(404).json({ error: '文件不存在' });
    if (file.provider === 'local') return res.json({ url: `/api/files/${file.id}/download` });
    const settings = await getSettings();
    const provider = createProvider(file.provider, settings.dropbox);
    res.json({ url: await provider.getPreviewUrl(file.path) });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/files/:id', async (req, res, next) => {
  try {
    const file = await removeFile(req.params.id);
    if (!file) return res.status(404).json({ error: '文件不存在' });
    const settings = await getSettings();
    const provider = createProvider(file.provider, file.provider === 'dropbox' ? settings.dropbox : undefined);
    await provider.deleteFile(file.path).catch(() => undefined);
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/storage/config', async (_req, res, next) => {
  try {
    const settings = await getSettings();
    res.json({
      activeProvider: settings.activeProvider,
      dropboxConnected: !!settings.dropbox?.refreshToken,
      dropboxAccountName: settings.dropbox?.accountName,
      dropboxRedirectUri: `${PUBLIC_API_URL}/api/storage/dropbox/callback`,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/storage/switch', async (req, res, next) => {
  try {
    const provider = req.body?.provider;
    if (provider !== 'local' && provider !== 'dropbox') return res.status(400).json({ error: '无效存储源' });
    const settings = await getSettings();
    if (provider === 'dropbox' && !settings.dropbox?.refreshToken) return res.status(400).json({ error: 'Dropbox 未配置' });
    await saveSettings({ ...settings, activeProvider: provider });
    res.json({ success: true, activeProvider: provider });
  } catch (error) {
    next(error);
  }
});

app.post('/api/storage/dropbox/auth-url', async (req, res, next) => {
  try {
    const { appKey, appSecret, name } = req.body || {};
    if (!appKey || !appSecret) return res.status(400).json({ error: '缺少 App Key 或 App Secret' });
    const redirectUri = `${PUBLIC_API_URL}/api/storage/dropbox/callback`;
    const state = uuidv4();
    oauthStates.set(state, { appKey, appSecret, name, redirectUri });
    res.json({ authUrl: DropboxStorageProvider.generateAuthUrl(appKey, redirectUri, state), redirectUri });
  } catch (error) {
    next(error);
  }
});

app.get('/api/storage/dropbox/callback', async (req, res, next) => {
  try {
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    const pending = oauthStates.get(state);
    if (!code || !pending) return res.status(400).send('Dropbox OAuth state 无效，请返回设置页重新授权。');

    const token = await DropboxStorageProvider.exchangeCode(pending.appKey, pending.appSecret, pending.redirectUri, code);
    if (!token.refresh_token) return res.status(400).send('未获得 refresh_token，请确认 Dropbox 授权 URL 使用 offline access。');
    const accountName = await DropboxStorageProvider.getAccountName(token.access_token).catch(() => pending.name || 'Dropbox Account');
    const settings = await getSettings();
    await saveSettings({ ...settings, activeProvider: 'dropbox', dropbox: { appKey: pending.appKey, appSecret: pending.appSecret, refreshToken: token.refresh_token, accountName } });
    oauthStates.delete(state);

    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'");
    res.send(`<html><body style="font-family:sans-serif;display:grid;place-items:center;height:100vh"><div><h2>Dropbox 授权成功</h2><p>窗口将自动关闭。</p></div><script>window.opener&&window.opener.postMessage('dropbox_auth_success','*');setTimeout(()=>window.close(),1000)</script></body></html>`);
  } catch (error) {
    next(error);
  }
});

async function startTelegramBot() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log('[Telegram] TELEGRAM_BOT_TOKEN 未配置，跳过 Bot。');
    return;
  }
  const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

  bot.start(ctx => ctx.reply('tg2cloud 已启动。直接发送文件、图片、视频或音频即可保存到当前存储源。'));

  bot.on(['document', 'photo', 'video', 'audio'], async ctx => {
    try {
      const message: any = ctx.message;
      const item = message.document || message.video || message.audio || message.photo?.[message.photo.length - 1];
      if (!item?.file_id) return ctx.reply('未识别到可下载文件。');

      const fileLink = await ctx.telegram.getFileLink(item.file_id);
      const originalName = message.document?.file_name || message.video?.file_name || message.audio?.file_name || `${item.file_unique_id || item.file_id}.bin`;
      const mimeType = message.document?.mime_type || message.video?.mime_type || message.audio?.mime_type || 'application/octet-stream';
      const tmpPath = path.join(TMP_DIR, `${uuidv4()}-${safeName(originalName)}`);
      const response = await axios.get(fileLink.href, { responseType: 'stream', timeout: 120000 });
      await new Promise<void>((resolve, reject) => {
        const ws = fs.createWriteStream(tmpPath);
        response.data.pipe(ws);
        ws.on('finish', resolve);
        ws.on('error', reject);
      });
      const file = await saveIncomingFile(tmpPath, originalName, mimeType, 'telegram', item.file_size);
      await ctx.reply(`已保存：${file.name}\n存储源：${file.provider}`);
    } catch (error: any) {
      console.error('[Telegram] 保存失败:', error);
      await ctx.reply(`保存失败：${error.message || '未知错误'}`);
    }
  });

  await bot.launch();
  console.log('[Telegram] Bot 已启动');

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  res.status(500).json({ error: error.message || '服务器错误' });
});

app.listen(PORT, () => {
  console.log(`tg2cloud backend listening on ${PORT}`);
  startTelegramBot().catch(error => console.error('[Telegram] 启动失败:', error));
});
