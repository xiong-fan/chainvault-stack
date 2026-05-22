'use client';

import { ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AuthSessionPayload,
  AuthUser,
  fetchCurrentAccount,
  loginAccount,
  logoutAccount,
  registerAccount
} from '@/lib/api/auth-api';
import type { WalletAddressResponse } from '@/types/api/wallet';
import { persistSession, readStoredSession, StoredSession } from './session-storage';

interface UserSessionContextValue {
  user?: AuthUser;
  wallet?: WalletAddressResponse;
  token?: string;
  expiresAt?: string;
  userId?: number;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (input: { identifier: string; password: string }) => Promise<void>;
  register: (input: { username: string; email: string; password: string }) => Promise<void>;
  logout: () => Promise<void>;
  setSession: (payload: AuthSessionPayload) => void;
}

const UserSessionContext = createContext<UserSessionContextValue | undefined>(undefined);

export function useUserSession() {
  const ctx = useContext(UserSessionContext);
  if (!ctx) throw new Error('useUserSession must be used within UserSessionProvider');
  return ctx;
}

export function UserSessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [session, setSessionState] = useState<StoredSession | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(true);

  const setSession = useCallback((payload: AuthSessionPayload) => {
    const nextSession: StoredSession = {
      user: payload.user,
      wallet: payload.wallet,
      token: payload.token,
      expiresAt: payload.expiresAt
    };
    setSessionState(nextSession);
    persistSession(nextSession);
  }, []);

  useEffect(() => {
    const stored = readStoredSession();
    if (!stored) {
      setIsLoading(false);
      return;
    }

    setSessionState(stored);
    fetchCurrentAccount(stored.token)
      .then((data) => {
        const refreshed = { ...stored, user: data.user, wallet: data.wallet || stored.wallet };
        setSessionState(refreshed);
        persistSession(refreshed);
      })
      .catch(() => {
        setSessionState(undefined);
        persistSession(undefined);
      })
      .finally(() => setIsLoading(false));
  }, []);

  const login = useCallback(
    async (input: { identifier: string; password: string }) => {
      const payload = await loginAccount(input);
      setSession(payload);
      router.push('/dashboard');
    },
    [router, setSession]
  );

  const register = useCallback(
    async (input: { username: string; email: string; password: string }) => {
      const payload = await registerAccount(input);
      setSession(payload);
      router.push('/dashboard');
    },
    [router, setSession]
  );

  const logout = useCallback(async () => {
    const token = session?.token;
    setSessionState(undefined);
    persistSession(undefined);
    if (token) {
      await logoutAccount(token).catch(() => undefined);
    }
    router.push('/login');
  }, [router, session?.token]);

  const value = useMemo<UserSessionContextValue>(
    () => ({
      user: session?.user,
      wallet: session?.wallet,
      token: session?.token,
      expiresAt: session?.expiresAt,
      userId: session?.user.id,
      isAuthenticated: Boolean(session?.token && session.user),
      isLoading,
      login,
      register,
      logout,
      setSession
    }),
    [isLoading, login, logout, register, session, setSession]
  );

  return <UserSessionContext.Provider value={value}>{children}</UserSessionContext.Provider>;
}
