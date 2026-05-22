import type { AuthUser } from '@/lib/api/auth-api';
import type { WalletAddressResponse } from '@/types/api/wallet';

export const AUTH_STORAGE_KEY = 'cex_account_session';

export interface StoredSession {
  user: AuthUser;
  wallet?: WalletAddressResponse;
  token: string;
  expiresAt: string;
}

export function readStoredSession(): StoredSession | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = window.localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return undefined;
    const session = JSON.parse(raw) as StoredSession;
    if (!session.token || new Date(session.expiresAt).getTime() <= Date.now()) {
      window.localStorage.removeItem(AUTH_STORAGE_KEY);
      return undefined;
    }
    return session;
  } catch {
    return undefined;
  }
}

export function persistSession(session?: StoredSession) {
  if (typeof window === 'undefined') return;
  if (!session) {
    window.localStorage.removeItem(AUTH_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
}

export function getStoredAuthToken(): string | undefined {
  return readStoredSession()?.token;
}
