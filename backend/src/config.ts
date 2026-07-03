import fs from 'fs';
import path from 'path';

export const PORT = Number(process.env.PORT || 51947);
export const PUBLIC_API_URL = (process.env.PUBLIC_API_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
export const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:47832';
export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const INDEX_FILE = path.join(DATA_DIR, 'files.json');
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
export const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
export const AUTH_SECRET = process.env.AUTH_SECRET || '';
export const AUTH_SESSION_HOURS = Math.max(1, Number(process.env.AUTH_SESSION_HOURS || 12));
export const TRUST_PROXY_HOPS = Math.max(0, Number(process.env.TRUST_PROXY_HOPS || 0));
export const AUTH_COOKIE_SECURE = process.env.AUTH_COOKIE_SECURE
  ? process.env.AUTH_COOKIE_SECURE === 'true'
  : PUBLIC_API_URL.startsWith('https://');

for (const dir of [DATA_DIR, TMP_DIR, UPLOAD_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function validateAuthConfiguration(): void {
  if (ADMIN_USERNAME.trim().length === 0) {
    throw new Error('ADMIN_USERNAME must not be empty.');
  }
  if (ADMIN_PASSWORD.length < 12 || ADMIN_PASSWORD === 'change-this-password') {
    throw new Error('ADMIN_PASSWORD must be changed and contain at least 12 characters.');
  }
  if (AUTH_SECRET.length < 32 || AUTH_SECRET === 'replace-with-a-random-secret-at-least-32-characters') {
    throw new Error('AUTH_SECRET must be changed and contain at least 32 characters.');
  }
  if (!Number.isFinite(AUTH_SESSION_HOURS)) {
    throw new Error('AUTH_SESSION_HOURS must be a valid number.');
  }
  if (!Number.isInteger(TRUST_PROXY_HOPS)) {
    throw new Error('TRUST_PROXY_HOPS must be a non-negative integer.');
  }
}
