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

for (const dir of [DATA_DIR, TMP_DIR, UPLOAD_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
