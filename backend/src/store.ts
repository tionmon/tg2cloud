import fs from 'fs/promises';
import { INDEX_FILE, SETTINGS_FILE } from './config.js';

export type StorageProviderName = 'local' | 'dropbox';

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

export interface AppSettings {
  activeProvider: StorageProviderName;
  dropbox?: DropboxSettings;
}

const defaultSettings: AppSettings = { activeProvider: 'local' };

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson<T>(file: string, value: T): Promise<void> {
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}

export async function getSettings(): Promise<AppSettings> {
  return readJson<AppSettings>(SETTINGS_FILE, defaultSettings);
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await writeJson(SETTINGS_FILE, settings);
}

export async function listFiles(): Promise<StoredFile[]> {
  return readJson<StoredFile[]>(INDEX_FILE, []);
}

export async function addFile(file: StoredFile): Promise<void> {
  const files = await listFiles();
  files.unshift(file);
  await writeJson(INDEX_FILE, files);
}

export async function getFile(id: string): Promise<StoredFile | undefined> {
  const files = await listFiles();
  return files.find(file => file.id === id);
}

export async function removeFile(id: string): Promise<StoredFile | undefined> {
  const files = await listFiles();
  const target = files.find(file => file.id === id);
  await writeJson(INDEX_FILE, files.filter(file => file.id !== id));
  return target;
}
