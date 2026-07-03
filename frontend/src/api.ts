export const API_BASE = (import.meta.env.VITE_API_URL || 'http://localhost:51947').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (typeof options.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers,
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    if (response.status === 401 && path !== '/api/auth/login') {
      window.dispatchEvent(new Event('auth:unauthorized'));
    }
    throw new ApiError(payload.error || `${response.status} ${response.statusText}`, response.status);
  }

  return response.json() as Promise<T>;
}

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export function apiOrigin(): string {
  return new URL(API_BASE, window.location.href).origin;
}
