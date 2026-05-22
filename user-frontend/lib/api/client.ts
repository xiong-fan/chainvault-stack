import { APP_CONFIG } from '../config/app-config';
import { getStoredAuthToken } from '../auth/session-storage';

const DEFAULT_TIMEOUT = 20000;

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
  const token = getStoredAuthToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(init?.headers as Record<string, string> | undefined)
  };

  try {
    const response = await fetch(url, {
      ...init,
      headers,
      signal: controller.signal
    });

    const text = await response.text();
    const payload = text ? (JSON.parse(text) as T) : ({} as T);

    if (!response.ok) {
      const message =
        typeof payload === 'object' && payload && 'error' in (payload as Record<string, unknown>)
          ? String((payload as { error?: string }).error)
          : 'Request failed';
      const error = new Error(`HTTP ${response.status} ${response.statusText}: ${message}`) as Error & {
        status?: number;
        details?: unknown;
      };
      error.status = response.status;
      error.details = (payload as { details?: unknown })?.details;
      throw error;
    }

    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

export const walletApi = {
  baseUrl: APP_CONFIG.apiBaseUrl.replace(/\/$/, '')
};
