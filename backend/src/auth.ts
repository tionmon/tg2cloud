import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  AUTH_COOKIE_SECURE,
  AUTH_SECRET,
  AUTH_SESSION_HOURS,
} from './config.js';

const COOKIE_NAME = 'tg2cloud_session';
const MAX_AGE_SECONDS = AUTH_SESSION_HOURS * 60 * 60;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

type SessionPayload = {
  sub: string;
  iat: number;
  exp: number;
  nonce: string;
};

type LoginAttempts = {
  count: number;
  resetAt: number;
};

const loginAttempts = new Map<string, LoginAttempts>();
let lastAttemptCleanup = 0;

function digest(value: string): Buffer {
  return crypto.createHash('sha256').update(value).digest();
}

function safeEqual(left: string, right: string): boolean {
  return crypto.timingSafeEqual(digest(left), digest(right));
}

function sign(value: string): string {
  return crypto.createHmac('sha256', AUTH_SECRET).update(value).digest('base64url');
}

function readCookies(request: Request): Record<string, string> {
  return (request.headers.cookie || '').split(';').reduce<Record<string, string>>((cookies, part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return cookies;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) {
      try {
        cookies[name] = decodeURIComponent(value);
      } catch {
        cookies[name] = value;
      }
    }
    return cookies;
  }, {});
}

function createSession(username: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    sub: username,
    iat: now,
    exp: now + MAX_AGE_SECONDS,
    nonce: crypto.randomBytes(16).toString('base64url'),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${sign(encoded)}`;
}

function verifySession(token?: string): SessionPayload | null {
  if (!token) return null;
  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra || !safeEqual(signature, sign(encoded))) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload;
    const now = Math.floor(Date.now() / 1000);
    if (payload.sub !== ADMIN_USERNAME || !payload.exp || payload.exp <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

function sessionFromRequest(request: Request): SessionPayload | null {
  return verifySession(readCookies(request)[COOKIE_NAME]);
}

function cookieOptions(maxAge: number): string {
  return [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    ...(AUTH_COOKIE_SECURE ? ['Secure'] : []),
  ].join('; ');
}

export function credentialsAreValid(username: string, password: string): boolean {
  return safeEqual(username, ADMIN_USERNAME) && safeEqual(password, ADMIN_PASSWORD);
}

export function setSessionCookie(response: Response, username: string): void {
  const cookie = cookieOptions(MAX_AGE_SECONDS).replace(
    `${COOKIE_NAME}=`,
    `${COOKIE_NAME}=${encodeURIComponent(createSession(username))}`,
  );
  response.setHeader('Set-Cookie', cookie);
}

export function clearSessionCookie(response: Response): void {
  response.setHeader('Set-Cookie', cookieOptions(0));
}

export function getAuthenticatedUser(request: Request): { username: string } | null {
  const session = sessionFromRequest(request);
  return session ? { username: session.sub } : null;
}

export function requireAuth(request: Request, response: Response, next: NextFunction): void {
  if (!sessionFromRequest(request)) {
    response.status(401).json({ error: '登录已过期，请重新登录。' });
    return;
  }
  next();
}

export function checkLoginRateLimit(request: Request, response: Response, next: NextFunction): void {
  const key = request.ip || request.socket.remoteAddress || 'unknown';
  const now = Date.now();
  if (now - lastAttemptCleanup > ATTEMPT_WINDOW_MS) {
    for (const [address, attempt] of loginAttempts) {
      if (attempt.resetAt <= now) loginAttempts.delete(address);
    }
    lastAttemptCleanup = now;
  }

  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= now) {
    loginAttempts.set(key, { count: 0, resetAt: now + ATTEMPT_WINDOW_MS });
    next();
    return;
  }
  if (current.count >= MAX_ATTEMPTS) {
    response.setHeader('Retry-After', String(Math.ceil((current.resetAt - now) / 1000)));
    response.status(429).json({ error: '登录尝试过多，请稍后再试。' });
    return;
  }
  next();
}

export function recordLoginFailure(request: Request): void {
  const key = request.ip || request.socket.remoteAddress || 'unknown';
  const now = Date.now();
  if (now - lastAttemptCleanup > ATTEMPT_WINDOW_MS) {
    for (const [address, attempt] of loginAttempts) {
      if (attempt.resetAt <= now) loginAttempts.delete(address);
    }
    lastAttemptCleanup = now;
  }

  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
    return;
  }
  current.count += 1;
}

export function clearLoginFailures(request: Request): void {
  const key = request.ip || request.socket.remoteAddress || 'unknown';
  loginAttempts.delete(key);
}
