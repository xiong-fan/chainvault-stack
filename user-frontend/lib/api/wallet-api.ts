import { requestJson, walletApi } from './client';
import type {
  ApiResponse,
  BalanceDetailItem,
  BalanceStats,
  CreateTokenRequest,
  PendingDepositItem,
  TokenBalanceDetail,
  TokenBalanceItem,
  CreateErc20TokenRequest,
  CreateWithdrawResponse,
  EvmNonceDiagnostic,
  TokenOnboardingOption,
  WalletTokenConfig,
  WithdrawDetail,
  WithdrawItem,
  WalletAddressResponse,
  WithdrawListResponse
} from '@/types/api/wallet';
import { SupportedChainType, WithdrawStatus } from '@/lib/types';

/**
 * backendModule: wallet
 * apiPath: /api/user/{id}/address
 */
export async function fetchWalletAddress(userId: number, chainType: SupportedChainType): Promise<WalletAddressResponse> {
  const url = `${walletApi.baseUrl}/api/user/${userId}/address?chain_type=${chainType}`;
  const result = await requestJson<ApiResponse<WalletAddressResponse>>(url, { method: 'GET' });
  if (!result.data) throw new Error(result.error || '获取钱包地址失败');
  return result.data;
}

/**
 * backendModule: wallet
 * apiPath: /api/user/{id}/balance/total
 */
export async function fetchTotalBalances(userId: number): Promise<TokenBalanceItem[]> {
  const url = `${walletApi.baseUrl}/api/user/${userId}/balance/total`;
  const result = await requestJson<ApiResponse<TokenBalanceItem[]>>(url, { method: 'GET' });
  return result.data || [];
}

/**
 * backendModule: wallet
 * apiPath: /api/user/{id}/balance/stats
 */
export async function fetchBalanceStats(userId: number): Promise<BalanceStats> {
  const url = `${walletApi.baseUrl}/api/user/${userId}/balance/stats`;
  const result = await requestJson<ApiResponse<BalanceStats>>(url, { method: 'GET' });
  return result.data || {
    user_id: userId,
    chain_count: 0,
    token_count: 0,
    address_count: 0,
    positive_balance_count: 0,
    last_balance_update: null
  };
}

/**
 * backendModule: wallet
 * apiPath: /api/user/{id}/balance/details
 */
export async function fetchBalanceDetails(userId: number): Promise<BalanceDetailItem[]> {
  const url = `${walletApi.baseUrl}/api/user/${userId}/balance/details`;
  const result = await requestJson<ApiResponse<BalanceDetailItem[]>>(url, { method: 'GET' });
  return result.data || [];
}

/**
 * backendModule: wallet
 * apiPath: /api/user/{id}/balance/pending
 */
export async function fetchPendingDeposits(userId: number): Promise<PendingDepositItem[]> {
  const url = `${walletApi.baseUrl}/api/user/${userId}/balance/pending`;
  const result = await requestJson<ApiResponse<PendingDepositItem[]>>(url, { method: 'GET' });
  return result.data || [];
}

/**
 * backendModule: wallet
 * apiPath: /api/user/{id}/balance/token/{symbol}
 */
export async function fetchTokenBalance(userId: number, symbol: string): Promise<TokenBalanceDetail> {
  const url = `${walletApi.baseUrl}/api/user/${userId}/balance/token/${symbol}`;
  const result = await requestJson<ApiResponse<TokenBalanceDetail>>(url, { method: 'GET' });
  if (!result.data) throw new Error(result.error || `未返回 ${symbol} 余额`);
  return result.data;
}

export async function fetchAdminTokens(params?: {
  chainType?: SupportedChainType;
  chainId?: number;
  tokenSymbol?: string;
}): Promise<WalletTokenConfig[]> {
  const search = new URLSearchParams();
  if (params?.chainType) search.set('chain_type', params.chainType);
  if (params?.chainId) search.set('chain_id', String(params.chainId));
  if (params?.tokenSymbol) search.set('token_symbol', params.tokenSymbol);

  const suffix = search.toString() ? `?${search.toString()}` : '';
  const url = `${walletApi.baseUrl}/api/admin/tokens${suffix}`;
  const result = await requestJson<ApiResponse<WalletTokenConfig[]>>(url, { method: 'GET' });
  return result.data || [];
}

export async function fetchAvailableTokens(params?: {
  chainType?: SupportedChainType;
  chainId?: number;
}): Promise<WalletTokenConfig[]> {
  const search = new URLSearchParams();
  if (params?.chainType) search.set('chain_type', params.chainType);
  if (params?.chainId) search.set('chain_id', String(params.chainId));

  const suffix = search.toString() ? `?${search.toString()}` : '';
  const url = `${walletApi.baseUrl}/api/tokens${suffix}`;
  const result = await requestJson<ApiResponse<WalletTokenConfig[]>>(url, { method: 'GET' });
  return result.data || [];
}

export async function fetchTokenOnboardingOptions(): Promise<TokenOnboardingOption[]> {
  const url = `${walletApi.baseUrl}/api/admin/chains/token-onboarding-options`;
  const result = await requestJson<ApiResponse<TokenOnboardingOption[]>>(url, { method: 'GET' });
  return result.data || [];
}

export async function createToken(request: CreateTokenRequest): Promise<WalletTokenConfig> {
  const url = `${walletApi.baseUrl}/api/admin/tokens`;
  const result = await requestJson<ApiResponse<WalletTokenConfig>>(url, {
    method: 'POST',
    body: JSON.stringify(request)
  });
  if (!result.data) throw new Error(result.error || '新增代币失败');
  return result.data;
}

export async function createErc20Token(request: CreateErc20TokenRequest): Promise<WalletTokenConfig> {
  const url = `${walletApi.baseUrl}/api/admin/tokens/erc20`;
  const result = await requestJson<ApiResponse<WalletTokenConfig>>(url, {
    method: 'POST',
    body: JSON.stringify(request)
  });
  if (!result.data) throw new Error(result.error || '新增 ERC20 代币失败');
  return result.data;
}

export interface CreateWithdrawRequest {
  userId: number;
  to: string;
  amount: string;
  tokenId: number;
  chainId: number;
  chainType: SupportedChainType;
}

/**
 * backendModule: wallet
 * apiPath: /api/user/withdraw
 */
export async function createWithdraw(request: CreateWithdrawRequest): Promise<CreateWithdrawResponse> {
  const url = `${walletApi.baseUrl}/api/user/withdraw`;
  const result = await requestJson<ApiResponse<CreateWithdrawResponse>>(url, {
    method: 'POST',
    body: JSON.stringify(request)
  });
  if (!result.data) {
    throw new Error(result.error || '发起提现失败');
  }
  return result.data;
}

/**
 * backendModule: wallet
 * apiPath: /api/user/{id}/withdraws
 */
export async function fetchWithdrawList(
  userId: number,
  params?: {
    status?: WithdrawStatus;
    limit?: number;
    offset?: number;
  }
): Promise<WithdrawListResponse> {
  const search = new URLSearchParams();
  if (params?.status) search.set('status', params.status);
  if (params?.limit !== undefined) search.set('limit', String(params.limit));
  if (params?.offset !== undefined) search.set('offset', String(params.offset));

  const suffix = search.toString() ? `?${search.toString()}` : '';
  const url = `${walletApi.baseUrl}/api/user/${userId}/withdraws${suffix}`;
  const result = await requestJson<ApiResponse<WithdrawListResponse>>(url, {
    method: 'GET'
  });

  if (!result.data) {
    throw new Error(result.error || '获取提现记录失败');
  }
  return result.data;
}

/**
 * backendModule: wallet
 * apiPath: /api/withdraws/{withdrawId}
 */
export async function fetchWithdrawDetail(withdrawId: number): Promise<WithdrawDetail> {
  const url = `${walletApi.baseUrl}/api/withdraws/${withdrawId}`;
  const result = await requestJson<ApiResponse<WithdrawDetail>>(url, { method: 'GET' });
  if (!result.data) throw new Error(result.error || '获取提现详情失败');
  return result.data;
}

/**
 * backendModule: wallet (optional)
 * apiPath: /api/withdraws/pending
 */
export async function fetchPendingWithdraws(): Promise<WithdrawItem[]> {
  const url = `${walletApi.baseUrl}/api/withdraws/pending`;
  const result = await requestJson<ApiResponse<{ withdraws: WithdrawItem[]; count: number }>>(url, {
    method: 'GET'
  });
  return result.data?.withdraws || [];
}

export async function fetchEvmNonceDiagnostics(params?: { chainId?: number }): Promise<EvmNonceDiagnostic[]> {
  const search = new URLSearchParams();
  if (params?.chainId !== undefined) search.set('chainId', String(params.chainId));
  const suffix = search.toString() ? `?${search.toString()}` : '';
  const url = `${walletApi.baseUrl}/api/admin/evm/nonce-diagnostics${suffix}`;
  const result = await requestJson<ApiResponse<{ diagnostics: EvmNonceDiagnostic[]; count: number }>>(url, {
    method: 'GET'
  });
  return result.data?.diagnostics || [];
}

export async function retryWithdrawBroadcast(withdrawId: number): Promise<WithdrawItem | null> {
  const url = `${walletApi.baseUrl}/api/admin/withdraws/${withdrawId}/retry-broadcast`;
  const result = await requestJson<ApiResponse<{ withdraw: WithdrawItem | null }>>(url, {
    method: 'POST'
  });
  return result.data?.withdraw || null;
}
