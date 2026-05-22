import { requestJson, walletApi } from './client';
import type { WalletAddressResponse } from '@/types/api/wallet';

export interface AuthUser {
  id: number;
  username: string;
  email: string | null;
  user_type: string;
  status: number;
  kyc_status: number;
  created_at?: string;
  updated_at?: string;
  last_login_at?: string | null;
}

export interface AuthSessionPayload {
  user: AuthUser;
  wallet?: WalletAddressResponse;
  token: string;
  expiresAt: string;
}

interface ApiResponse<T> {
  success?: boolean;
  message?: string;
  error?: string;
  data?: T;
}

export async function registerAccount(input: {
  username: string;
  email: string;
  password: string;
}): Promise<AuthSessionPayload> {
  const result = await requestJson<ApiResponse<AuthSessionPayload>>(`${walletApi.baseUrl}/api/auth/register`, {
    method: 'POST',
    body: JSON.stringify(input)
  });
  if (!result.data) throw new Error(result.error || '注册失败');
  return result.data;
}

export async function loginAccount(input: {
  identifier: string;
  password: string;
}): Promise<AuthSessionPayload> {
  const result = await requestJson<ApiResponse<AuthSessionPayload>>(`${walletApi.baseUrl}/api/auth/login`, {
    method: 'POST',
    body: JSON.stringify(input)
  });
  if (!result.data) throw new Error(result.error || '登录失败');
  return result.data;
}

export async function logoutAccount(token: string): Promise<void> {
  await requestJson<ApiResponse<void>>(`${walletApi.baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
}

export async function fetchCurrentAccount(token: string): Promise<{
  user: AuthUser;
  wallet?: WalletAddressResponse;
}> {
  const result = await requestJson<ApiResponse<{ user: AuthUser; wallet?: WalletAddressResponse }>>(
    `${walletApi.baseUrl}/api/auth/me`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  );
  if (!result.data) throw new Error(result.error || '获取当前账号失败');
  return result.data;
}
