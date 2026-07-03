import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import multer from 'multer';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { pipeline } from 'stream/promises';
import axios from 'axios';
import { Telegraf } from 'telegraf';
import { v4 as uuidv4 } from 'uuid';
import {
  CORS_ORIGIN,
  PORT,
  PUBLIC_API_URL,
  TELEGRAM_BOT_TOKEN,
  TMP_DIR,
  TRUST_PROXY_HOPS,
  validateAuthConfiguration,
} from './config.js';
import {
  checkLoginRateLimit,
  clearLoginFailures,
  clearSessionCookie,
  credentialsAreValid,
  getAuthenticatedUser,
  recordLoginFailure,
  requireAuth,
  setSessionCookie,
} from './auth.js';
import {
  addFile,
  getFile,
  getSettings,
  listFiles,
  removeFile,
  updateSettings,
  type StoredFile,
  type StorageProviderName,
} from './store.js';
import {
  createProvider,
  DropboxStorageProvider,
  GoogleDriveStorageProvider,
} from './storage.js';

validateAuthConfiguration();

const app = express();
const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
});
const dropboxOauthStates = new Map<string, {
  appKey: string;
  appSecret: string;
  name?: string;
  redirectUri: string;
  createdAt: number;
}>();
const googleOauthStates = new Map<string, {
  redirectUri: string;
  createdAt: number;
}>();

app.disable('x-powered-by');
if (TRUST_PROXY_HOPS > 0) app.set('trust proxy', TRUST_PROXY_HOPS);
app.use(helmet({
  crossOriginResourcePolicy: false,
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
}));
app.use(cors({
  origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN,
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 180) || 'file';
}

function pruneOauthStates(): void {
  const expiresBefore = Date.now() - 10 * 60 * 1000;
  for (const [state, pending] of dropboxOauthStates) {
    if (pending.createdAt < expiresBefore) dropboxOauthStates.delete(state);
  }
  for (const [state, pending] of googleOauthStates) {
    if (pending.createdAt < expiresBefore) googleOauthStates.delete(state);
  }
}

function trustedMutationOrigin(
  request: express.Request,
  response: express.Response,
  next: express.NextFunction,
): void {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) || CORS_ORIGIN === '*') {
    next();
    return;
  }

  const origin = request.get('origin');
  if (origin && origin !== CORS_ORIGIN) {
    response.status(403).json({ error: '请求来源不受信任。' });
    return;
  }
  next();
}

async function storageProvider(name: StorageProviderName) {
  const settings = await getSettings();
  return createProvider(name, settings.dropbox, settings.googleDrive);
}

async function saveIncomingFile(
  temporaryPath: string,
  originalName: string,
  mimeType: string,
  source: StoredFile['source'],
  size?: number,
): Promise<StoredFile> {
  const settings = await getSettings();
  const provider = createProvider(
    settings.activeProvider,
    settings.dropbox,
    settings.googleDrive,
  );
  const fileName = safeName(path.basename(originalName));
  const storedName = [
    new Date().toISOString().replace(/[:.]/g, '-'),
    uuidv4(),
    fileName,
  ].join('-');
  const storedSize = size
    ?? (await fsp.stat(temporaryPath).catch(() => ({ size: 0 }))).size;
  let storedPath = '';

  try {
    storedPath = await provider.saveFile(
      temporaryPath,
      storedName,
      mimeType || 'application/octet-stream',
    );

    const file: StoredFile = {
      id: uuidv4(),
      name: originalName,
      storedName,
      mimeType: mimeType || 'application/octet-stream',
      size: storedSize,
      source,
      provider: provider.name,
      path: storedPath,
      createdAt: new Date().toISOString(),
    };

    await addFile(file);
    return file;
  } catch (error) {
    if (storedPath) await provider.deleteFile(storedPath).catch(() => undefined);
    throw error;
  } finally {
    await fsp.unlink(temporaryPath).catch(() => undefined);
  }
}

function oauthSuccessPage(
  response: express.Response,
  providerName: string,
  eventName: string,
): void {
  const openerOrigin = CORS_ORIGIN === '*' ? '*' : CORS_ORIGIN;
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
  );
  response.send(`<!doctype html>
    <html lang="zh-CN">
      <head><meta charset="utf-8"><title>${providerName} 授权成功</title></head>
      <body style="font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#f8fafc;color:#0f172a">
        <div style="text-align:center"><h2>${providerName} 授权成功</h2><p>窗口即将自动关闭。</p></div>
        <script>
          window.opener && window.opener.postMessage(${JSON.stringify(eventName)}, ${JSON.stringify(openerOrigin)});
          setTimeout(() => window.close(), 1000);
        </script>
      </body>
    </html>`);
}

app.get('/health', (_request, response) => {
  response.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('/api/auth/session', (request, response) => {
  const user = getAuthenticatedUser(request);
  response.json({ authenticated: Boolean(user), user });
});

app.post('/api/auth/login', checkLoginRateLimit, (request, response) => {
  const username = typeof request.body?.username === 'string'
    ? request.body.username.trim()
    : '';
  const password = typeof request.body?.password === 'string'
    ? request.body.password
    : '';

  if (!credentialsAreValid(username, password)) {
    recordLoginFailure(request);
    response.status(401).json({ error: '用户名或密码不正确。' });
    return;
  }

  clearLoginFailures(request);
  setSessionCookie(response, username);
  response.json({ success: true, user: { username } });
});

app.post('/api/auth/logout', requireAuth, (_request, response) => {
  clearSessionCookie(response);
  response.json({ success: true });
});

// OAuth 回调必须公开；随机、短时有效的 state 负责校验请求来源。
app.get('/api/storage/dropbox/callback', async (request, response, next) => {
  try {
    const code = String(request.query.code || '');
    const state = String(request.query.state || '');
    const pending = dropboxOauthStates.get(state);
    dropboxOauthStates.delete(state);

    if (!code || !pending || Date.now() - pending.createdAt > 10 * 60 * 1000) {
      response.status(400).send('Dropbox OAuth 请求已失效，请返回设置页重新授权。');
      return;
    }

    const token = await DropboxStorageProvider.exchangeCode(
      pending.appKey,
      pending.appSecret,
      pending.redirectUri,
      code,
    );
    if (!token.refresh_token) {
      response.status(400).send('未获得 refresh token，请确认 Dropbox 授权使用 offline access。');
      return;
    }

    const accountName = await DropboxStorageProvider
      .getAccountName(token.access_token)
      .catch(() => pending.name || 'Dropbox Account');
    await updateSettings(settings => ({
      ...settings,
      activeProvider: 'dropbox',
      dropbox: {
        appKey: pending.appKey,
        appSecret: pending.appSecret,
        refreshToken: token.refresh_token,
        accountName,
      },
    }));
    oauthSuccessPage(response, 'Dropbox', 'dropbox_auth_success');
  } catch (error) {
    next(error);
  }
});

app.get('/api/storage/google/callback', async (request, response, next) => {
  try {
    const code = String(request.query.code || '');
    const state = String(request.query.state || '');
    const pending = googleOauthStates.get(state);
    googleOauthStates.delete(state);

    if (!code || !pending || Date.now() - pending.createdAt > 10 * 60 * 1000) {
      response.status(400).send('Google OAuth 请求已失效，请返回设置页重新授权。');
      return;
    }

    const token = await GoogleDriveStorageProvider.exchangeCode(pending.redirectUri, code);
    const settings = await getSettings();
    const refreshToken = token.refresh_token || settings.googleDrive?.refreshToken;
    if (!refreshToken) {
      response.status(400).send('未获得 refresh token，请撤销旧授权后重新连接 Google Drive。');
      return;
    }

    const accountName = await GoogleDriveStorageProvider
      .getAccountName(token.access_token)
      .catch(() => 'Google Drive Account');
    await updateSettings(current => ({
      ...current,
      activeProvider: 'google-drive',
      googleDrive: {
        refreshToken: token.refresh_token || current.googleDrive?.refreshToken || refreshToken,
        accountName,
      },
    }));
    oauthSuccessPage(response, 'Google Drive', 'google_auth_success');
  } catch (error) {
    next(error);
  }
});

app.use('/api', requireAuth);
app.use('/api', trustedMutationOrigin);

app.get('/api/files', async (_request, response, next) => {
  try {
    response.json(await listFiles());
  } catch (error) {
    next(error);
  }
});

app.post('/api/upload', upload.single('file'), async (request, response, next) => {
  try {
    if (!request.file) {
      response.status(400).json({ error: '请选择要上传的文件。' });
      return;
    }
    const file = await saveIncomingFile(
      request.file.path,
      request.file.originalname,
      request.file.mimetype,
      'web',
      request.file.size,
    );
    response.json({ success: true, file });
  } catch (error) {
    if (request.file?.path) {
      await fsp.unlink(request.file.path).catch(() => undefined);
    }
    next(error);
  }
});

app.get('/api/files/:id/download', async (request, response, next) => {
  try {
    const file = await getFile(request.params.id);
    if (!file) {
      response.status(404).json({ error: '文件不存在。' });
      return;
    }

    const provider = await storageProvider(file.provider);
    const stream = await provider.getFileStream(file.path);
    response.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    const inline = request.query.inline === '1';
    response.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    );
    stream.on('error', next);
    stream.pipe(response);
  } catch (error) {
    next(error);
  }
});

app.get('/api/files/:id/preview-url', async (request, response, next) => {
  try {
    const file = await getFile(request.params.id);
    if (!file) {
      response.status(404).json({ error: '文件不存在。' });
      return;
    }
    if (file.provider === 'local') {
      response.json({ url: `/api/files/${file.id}/download?inline=1` });
      return;
    }

    const provider = await storageProvider(file.provider);
    response.json({ url: await provider.getPreviewUrl(file.path) });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/files/:id', async (request, response, next) => {
  try {
    const file = await getFile(request.params.id);
    if (!file) {
      response.status(404).json({ error: '文件不存在。' });
      return;
    }

    const provider = await storageProvider(file.provider);
    await provider.deleteFile(file.path);
    await removeFile(file.id);
    response.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/storage/config', async (_request, response, next) => {
  try {
    const settings = await getSettings();
    response.json({
      activeProvider: settings.activeProvider,
      dropboxConnected: Boolean(settings.dropbox?.refreshToken),
      dropboxAccountName: settings.dropbox?.accountName,
      dropboxRedirectUri: `${PUBLIC_API_URL}/api/storage/dropbox/callback`,
      googleDriveConnected: Boolean(settings.googleDrive?.refreshToken),
      googleDriveAccountName: settings.googleDrive?.accountName,
      googleDriveConfigured: GoogleDriveStorageProvider.isConfigured(),
      googleDriveRedirectUri: `${PUBLIC_API_URL}/api/storage/google/callback`,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/storage/switch', async (request, response, next) => {
  try {
    const provider = request.body?.provider as StorageProviderName;
    if (!['local', 'dropbox', 'google-drive'].includes(provider)) {
      response.status(400).json({ error: '无效的存储源。' });
      return;
    }

    const settings = await getSettings();
    if (provider === 'dropbox' && !settings.dropbox?.refreshToken) {
      response.status(400).json({ error: '请先连接 Dropbox。' });
      return;
    }
    if (provider === 'google-drive' && !settings.googleDrive?.refreshToken) {
      response.status(400).json({ error: '请先连接 Google Drive。' });
      return;
    }

    await updateSettings(current => ({ ...current, activeProvider: provider }));
    response.json({ success: true, activeProvider: provider });
  } catch (error) {
    next(error);
  }
});

app.post('/api/storage/dropbox/auth-url', async (request, response, next) => {
  try {
    const { appKey, appSecret, name } = request.body || {};
    if (
      typeof appKey !== 'string'
      || typeof appSecret !== 'string'
      || !appKey.trim()
      || !appSecret.trim()
    ) {
      response.status(400).json({ error: '请填写 App Key 和 App Secret。' });
      return;
    }

    const redirectUri = `${PUBLIC_API_URL}/api/storage/dropbox/callback`;
    const state = uuidv4();
    pruneOauthStates();
    dropboxOauthStates.set(state, {
      appKey: appKey.trim(),
      appSecret,
      name: typeof name === 'string' ? name.trim() : undefined,
      redirectUri,
      createdAt: Date.now(),
    });
    response.json({
      authUrl: DropboxStorageProvider.generateAuthUrl(appKey.trim(), redirectUri, state),
      redirectUri,
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/storage/google/auth-url', async (_request, response, next) => {
  try {
    if (!GoogleDriveStorageProvider.isConfigured()) {
      response.status(400).json({
        error: '请先在环境变量中配置 GOOGLE_CLIENT_ID 和 GOOGLE_CLIENT_SECRET。',
      });
      return;
    }

    const redirectUri = `${PUBLIC_API_URL}/api/storage/google/callback`;
    const state = uuidv4();
    pruneOauthStates();
    googleOauthStates.set(state, { redirectUri, createdAt: Date.now() });
    response.json({
      authUrl: GoogleDriveStorageProvider.generateAuthUrl(redirectUri, state),
      redirectUri,
    });
  } catch (error) {
    next(error);
  }
});

async function startTelegramBot(): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log('[Telegram] 未配置 TELEGRAM_BOT_TOKEN，跳过 Bot。');
    return;
  }

  const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
  bot.start(context => context.reply(
    'tg2cloud 已启动。直接发送文件、图片、视频或音频，即可保存到当前存储源。',
  ));

  bot.on(['document', 'photo', 'video', 'audio'], async context => {
    let temporaryPath = '';
    try {
      const message: any = context.message;
      const item = message.document
        || message.video
        || message.audio
        || message.photo?.[message.photo.length - 1];
      if (!item?.file_id) {
        await context.reply('没有识别到可下载的文件。');
        return;
      }

      const fileLink = await context.telegram.getFileLink(item.file_id);
      const originalName = message.document?.file_name
        || message.video?.file_name
        || message.audio?.file_name
        || `${item.file_unique_id || item.file_id}.bin`;
      const mimeType = message.document?.mime_type
        || message.video?.mime_type
        || message.audio?.mime_type
        || 'application/octet-stream';
      temporaryPath = path.join(TMP_DIR, `${uuidv4()}-${safeName(path.basename(originalName))}`);
      const downloadResponse = await axios.get(fileLink.href, {
        responseType: 'stream',
        timeout: 120000,
      });

      await pipeline(downloadResponse.data, fs.createWriteStream(temporaryPath));

      const file = await saveIncomingFile(
        temporaryPath,
        originalName,
        mimeType,
        'telegram',
        item.file_size,
      );
      await context.reply(`已保存：${file.name}\n存储源：${file.provider}`);
    } catch (error: any) {
      console.error('[Telegram] 保存失败:', error);
      await context.reply(`保存失败：${error.message || '未知错误'}`);
    } finally {
      if (temporaryPath) await fsp.unlink(temporaryPath).catch(() => undefined);
    }
  });

  await bot.launch();
  console.log('[Telegram] Bot 已启动。');

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

app.use((
  error: any,
  _request: express.Request,
  response: express.Response,
  _next: express.NextFunction,
) => {
  if (response.headersSent) {
    response.end();
    return;
  }

  if (error instanceof multer.MulterError) {
    const isTooLarge = error.code === 'LIMIT_FILE_SIZE';
    response.status(isTooLarge ? 413 : 400).json({
      error: isTooLarge ? '文件不能超过 2 GB。' : '上传请求无效。',
    });
    return;
  }

  const status = Number.isInteger(error?.status) && error.status >= 400
    ? error.status
    : 500;
  if (status >= 500) console.error(error);
  response.status(status).json({
    error: status >= 500
      ? '服务器发生错误。'
      : error.type === 'entity.parse.failed'
        ? '请求正文不是有效的 JSON。'
        : error.message || '请求处理失败。',
  });
});

app.listen(PORT, () => {
  console.log(`tg2cloud backend listening on ${PORT}`);
  startTelegramBot().catch(error => console.error('[Telegram] 启动失败:', error));
});
