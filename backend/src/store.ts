import crypto from 'crypto';
import fs from 'fs/promises';
import { INDEX_FILE, SETTINGS_FILE } from './config.js';

export type StorageProviderName = 'local' | 'dropbox' | 'google-drive';

export interface StoredFile {
  id: string;
  name: string;
  storedName: string;
  mimeType: string;
  size: number;
  source: 'web' | 'telegram';
  provider: StorageProviderName;
  path: string;
  createdAt: string;
}

export interface DropboxSettings {
  appKey: string;
  appSecret: string;
  refreshToken: string;
  accountName?: string;
}

export interface GoogleDriveSettings {
  refreshToken: string;
  accountName?: string;
}

export interface AppSettings {
  activeProvider: StorageProviderName;
  dropbox?: DropboxSettings;
  googleDrive?: GoogleDriveSettings;
}

const defaultSettings: AppSettings = { activeProvider: 'local' };
let mutationQueue = Promise.resolve();

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return fallback;
    throw new Error(`无法读取数据文件 ${file}：${error?.message || '未知错误'}`);
  }
}

async function writeJson<T>(file: string, value: T): Promise<void> {
  const temporaryFile = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryFile, JSON.stringify(value, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    });
    try {
      await fs.rename(temporaryFile, file);
    } catch (error: any) {
      if (process.platform !== 'win32' || !['EEXIST', 'EPERM'].includes(error?.code)) {
        throw error;
      }
      // Windows cannot atomically replace an existing file with rename.
      await fs.copyFile(temporaryFile, file);
      await fs.unlink(temporaryFile);
    }
    await fs.chmod(file, 0o600);
  } catch (error) {
    await fs.unlink(temporaryFile).catch(() => undefined);
    throw error;
  }
}

async function mutate<T>(operation: () => Promise<T>): Promise<T> {
  const previous = mutationQueue;
  let release!: () => void;
  mutationQueue = new Promise<void>(resolve => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

export async function getSettings(): Promise<AppSettings> {
  return readJson<AppSettings>(SETTINGS_FILE, defaultSettings);
}

export async function updateSettings(
  updater: (settings: AppSettings) => AppSettings,
): Promise<AppSettings> {
  return mutate(async () => {
    const settings = await readJson<AppSettings>(SETTINGS_FILE, defaultSettings);
    const updated = updater(settings);
    await writeJson(SETTINGS_FILE, updated);
    return updated;
  });
}

export async function listFiles(): Promise<StoredFile[]> {
  return readJson<StoredFile[]>(INDEX_FILE, []);
}

export async function addFile(file: StoredFile): Promise<void> {
  await mutate(async () => {
    const files = await listFiles();
    files.unshift(file);
    await writeJson(INDEX_FILE, files);
  });
}

export async function getFile(id: string): Promise<StoredFile | undefined> {
  const files = await listFiles();
  return files.find(file => file.id === id);
}

export async function removeFile(id: string): Promise<StoredFile | undefined> {
  return mutate(async () => {
    const files = await listFiles();
    const target = files.find(file => file.id === id);
    if (target) await writeJson(INDEX_FILE, files.filter(file => file.id !== id));
    return target;
  });
}
