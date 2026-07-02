import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import axios from 'axios';
import { UPLOAD_DIR } from './config.js';
import type { DropboxSettings, StorageProviderName } from './store.js';

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

export function createProvider(name: StorageProviderName, dropbox?: DropboxSettings): StorageProvider {
  if (name === 'dropbox') {
    if (!dropbox?.refreshToken) throw new Error('Dropbox 未配置');
    return new DropboxStorageProvider(dropbox);
  }
  return new LocalStorageProvider();
}
