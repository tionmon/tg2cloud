import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import axios from 'axios';
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, UPLOAD_DIR } from './config.js';
import type { DropboxSettings, GoogleDriveSettings, StorageProviderName } from './store.js';

export interface StorageProvider {
  name: StorageProviderName;
  saveFile(tempPath: string, storedName: string, mimeType: string): Promise<string>;
  getFileStream(storedPath: string): Promise<NodeJS.ReadableStream>;
  getPreviewUrl(storedPath: string): Promise<string>;
  deleteFile(storedPath: string): Promise<void>;
}

export class LocalStorageProvider implements StorageProvider {
  name: StorageProviderName = 'local';

  async saveFile(tempPath: string, storedName: string): Promise<string> {
    const dest = path.join(UPLOAD_DIR, storedName);
    await fsp.rename(tempPath, dest).catch(async error => {
      if (error.code === 'EXDEV') {
        await fsp.copyFile(tempPath, dest);
        await fsp.unlink(tempPath);
        return;
      }
      throw error;
    });
    return dest;
  }

  async getFileStream(storedPath: string): Promise<NodeJS.ReadableStream> {
    return fs.createReadStream(storedPath);
  }

  async getPreviewUrl(): Promise<string> {
    return '';
  }

  async deleteFile(storedPath: string): Promise<void> {
    await fsp.unlink(storedPath).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export class DropboxStorageProvider implements StorageProvider {
  name: StorageProviderName = 'dropbox';
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(private settings: DropboxSettings) {}

  static generateAuthUrl(appKey: string, redirectUri: string, state: string): string {
    const params = new URLSearchParams({
      client_id: appKey,
      redirect_uri: redirectUri,
      response_type: 'code',
      token_access_type: 'offline',
      scope: ['files.content.write', 'files.content.read', 'account_info.read', 'sharing.write'].join(' '),
      state,
    });
    return `https://www.dropbox.com/oauth2/authorize?${params.toString()}`;
  }

  static async exchangeCode(appKey: string, appSecret: string, redirectUri: string, code: string): Promise<any> {
    const params = new URLSearchParams({
      client_id: appKey,
      client_secret: appSecret,
      redirect_uri: redirectUri,
      code,
      grant_type: 'authorization_code',
    });
    const response = await axios.post('https://api.dropboxapi.com/oauth2/token', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 30000,
    });
    return response.data;
  }

  static async getAccountName(accessToken: string): Promise<string> {
    const response = await axios.post('https://api.dropboxapi.com/2/users/get_current_account', null, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 30000,
    });
    return response.data.email || response.data.name?.display_name || 'Dropbox Account';
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 300000) return this.accessToken;

    const params = new URLSearchParams({
      client_id: this.settings.appKey,
      client_secret: this.settings.appSecret,
      refresh_token: this.settings.refreshToken,
      grant_type: 'refresh_token',
    });
    const response = await axios.post('https://api.dropboxapi.com/oauth2/token', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 30000,
    });
    this.accessToken = response.data.access_token;
    this.tokenExpiresAt = Date.now() + ((response.data.expires_in || 14400) * 1000);
    return this.accessToken!;
  }

  private dropboxPath(storedName: string): string {
    return `/tg2cloud/${storedName}`;
  }

  private async ensureRootFolder(token: string): Promise<void> {
    try {
      await axios.post('https://api.dropboxapi.com/2/files/create_folder_v2', { path: '/tg2cloud', autorename: false }, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 30000,
      });
    } catch (error: any) {
      if (error.response?.status !== 409) throw error;
    }
  }

  async saveFile(tempPath: string, storedName: string, mimeType: string): Promise<string> {
    const token = await this.getAccessToken();
    await this.ensureRootFolder(token);
    const targetPath = this.dropboxPath(storedName);
    const stat = await fsp.stat(tempPath);

    if (stat.size <= 150 * 1024 * 1024) {
      const response = await axios.post('https://content.dropboxapi.com/2/files/upload', fs.createReadStream(tempPath), {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
          'Dropbox-API-Arg': JSON.stringify({ path: targetPath, mode: 'add', autorename: true, mute: false }),
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 120000,
      });
      return response.data.path_lower || response.data.path_display || targetPath;
    }

    const chunkSize = 8 * 1024 * 1024;
    const fd = await fsp.open(tempPath, 'r');
    let offset = 0;
    let sessionId = '';
    try {
      while (offset < stat.size) {
        const size = Math.min(chunkSize, stat.size - offset);
        const buffer = Buffer.alloc(size);
        await fd.read(buffer, 0, size, offset);

        if (offset === 0) {
          const start = await axios.post('https://content.dropboxapi.com/2/files/upload_session/start', buffer, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': JSON.stringify({ close: false }) },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 120000,
          });
          sessionId = start.data.session_id;
        } else if (offset + size < stat.size) {
          await axios.post('https://content.dropboxapi.com/2/files/upload_session/append_v2', buffer, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': JSON.stringify({ cursor: { session_id: sessionId, offset }, close: false }) },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 120000,
          });
        } else {
          const finish = await axios.post('https://content.dropboxapi.com/2/files/upload_session/finish', buffer, {
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/octet-stream',
              'Dropbox-API-Arg': JSON.stringify({ cursor: { session_id: sessionId, offset }, commit: { path: targetPath, mode: 'add', autorename: true, mute: false } }),
            },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 120000,
          });
          return finish.data.path_lower || finish.data.path_display || targetPath;
        }
        offset += size;
      }
      return targetPath;
    } finally {
      await fd.close();
    }
  }

  async getFileStream(storedPath: string): Promise<NodeJS.ReadableStream> {
    const token = await this.getAccessToken();
    const response = await axios.post('https://content.dropboxapi.com/2/files/download', null, {
      headers: { Authorization: `Bearer ${token}`, 'Dropbox-API-Arg': JSON.stringify({ path: storedPath }) },
      responseType: 'stream',
      timeout: 60000,
    });
    return response.data;
  }

  async getPreviewUrl(storedPath: string): Promise<string> {
    const token = await this.getAccessToken();
    const response = await axios.post('https://api.dropboxapi.com/2/files/get_temporary_link', { path: storedPath }, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 30000,
    });
    return response.data.link || '';
  }

  async deleteFile(storedPath: string): Promise<void> {
    const token = await this.getAccessToken();
    await axios.post('https://api.dropboxapi.com/2/files/delete_v2', { path: storedPath }, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 30000,
    }).catch(error => {
      if (error.response?.status !== 409) throw error;
    });
  }
}

type GoogleTokenResponse = {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
};

export class GoogleDriveStorageProvider implements StorageProvider {
  name: StorageProviderName = 'google-drive';
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(private settings: GoogleDriveSettings) {}

  static isConfigured(): boolean {
    return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
  }

  static generateAuthUrl(redirectUri: string, state: string): string {
    if (!this.isConfigured()) throw new Error('Google OAuth 未配置');
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      scope: ['openid', 'email', 'https://www.googleapis.com/auth/drive.file'].join(' '),
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  static async exchangeCode(redirectUri: string, code: string): Promise<GoogleTokenResponse> {
    if (!this.isConfigured()) throw new Error('Google OAuth 未配置');
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      code,
      grant_type: 'authorization_code',
    });
    const response = await axios.post<GoogleTokenResponse>('https://oauth2.googleapis.com/token', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 30000,
    });
    return response.data;
  }

  static async getAccountName(accessToken: string): Promise<string> {
    const response = await axios.get('https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress)', {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 30000,
    });
    return response.data.user?.emailAddress || response.data.user?.displayName || 'Google Drive Account';
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 300000) return this.accessToken;
    if (!GoogleDriveStorageProvider.isConfigured()) {
      throw new Error('Google OAuth 未配置，请设置 GOOGLE_CLIENT_ID 和 GOOGLE_CLIENT_SECRET');
    }

    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: this.settings.refreshToken,
      grant_type: 'refresh_token',
    });
    const response = await axios.post<GoogleTokenResponse>('https://oauth2.googleapis.com/token', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 30000,
    });
    this.accessToken = response.data.access_token;
    this.tokenExpiresAt = Date.now() + ((response.data.expires_in || 3600) * 1000);
    return this.accessToken!;
  }

  private async ensureRootFolder(token: string): Promise<string> {
    const query = "name = 'tg2cloud' and mimeType = 'application/vnd.google-apps.folder' and trashed = false";
    const existing = await axios.get('https://www.googleapis.com/drive/v3/files', {
      headers: { Authorization: `Bearer ${token}` },
      params: { q: query, spaces: 'drive', pageSize: 1, fields: 'files(id)' },
      timeout: 30000,
    });
    const folderId = existing.data.files?.[0]?.id;
    if (folderId) return folderId;

    const created = await axios.post('https://www.googleapis.com/drive/v3/files?fields=id', {
      name: 'tg2cloud',
      mimeType: 'application/vnd.google-apps.folder',
    }, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 30000,
    });
    return created.data.id;
  }

  async saveFile(tempPath: string, storedName: string, mimeType: string): Promise<string> {
    const token = await this.getAccessToken();
    const folderId = await this.ensureRootFolder(token);
    const stat = await fsp.stat(tempPath);
    const session = await axios.post('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
      name: storedName,
      parents: [folderId],
    }, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(stat.size),
      },
      timeout: 30000,
    });
    const uploadUrl = session.headers.location;
    if (!uploadUrl) throw new Error('Google Drive 未返回上传地址');

    const uploaded = await axios.put(uploadUrl, fs.createReadStream(tempPath), {
      headers: { 'Content-Type': mimeType, 'Content-Length': String(stat.size) },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 600000,
    });
    if (!uploaded.data.id) throw new Error('Google Drive 上传失败：未返回文件 ID');
    return uploaded.data.id;
  }

  async getFileStream(fileId: string): Promise<NodeJS.ReadableStream> {
    const token = await this.getAccessToken();
    const response = await axios.get(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'stream',
      timeout: 60000,
    });
    return response.data;
  }

  async getPreviewUrl(fileId: string): Promise<string> {
    return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
  }

  async deleteFile(fileId: string): Promise<void> {
    const token = await this.getAccessToken();
    await axios.delete(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 30000,
    }).catch(error => {
      if (error.response?.status !== 404) throw error;
    });
  }
}

export function createProvider(name: StorageProviderName, dropbox?: DropboxSettings, googleDrive?: GoogleDriveSettings): StorageProvider {
  if (name === 'dropbox') {
    if (!dropbox?.refreshToken) throw new Error('Dropbox 未配置');
    return new DropboxStorageProvider(dropbox);
  }
  if (name === 'google-drive') {
    if (!googleDrive?.refreshToken) throw new Error('Google Drive 未连接');
    return new GoogleDriveStorageProvider(googleDrive);
  }
  return new LocalStorageProvider();
}
