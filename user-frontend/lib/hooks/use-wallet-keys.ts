import { SupportedChainType, WithdrawStatus } from '@/lib/types';

export const getWalletApiKeys = {
  totalBalances: (userId?: number) => ['wallet', 'balances', 'total', userId] as const,
  balanceStats: (userId?: number) => ['wallet', 'balances', 'stats', userId] as const,
  balanceDetails: (userId?: number) => ['wallet', 'balances', 'details', userId] as const,
  pendingDeposits: (userId?: number) => ['wallet', 'deposits', 'pending', userId] as const,
  walletAddress: (userId?: number, chainType?: SupportedChainType) =>
    ['wallet', 'address', userId, chainType] as const,
  tokenDetail: (userId?: number, symbol?: string) =>
    ['wallet', 'balance', 'token', userId, symbol] as const,
  adminTokens: (params?: { chainType?: SupportedChainType; chainId?: number; tokenSymbol?: string }) =>
    ['wallet', 'admin', 'tokens', params?.chainType || 'all', params?.chainId || 'all', params?.tokenSymbol || 'all'] as const,
  tokenOnboardingOptions: () => ['wallet', 'admin', 'chains', 'token-onboarding-options'] as const,
  availableTokens: (params?: { chainType?: SupportedChainType; chainId?: number }) =>
    ['wallet', 'tokens', params?.chainType || 'all', params?.chainId || 'all'] as const,
  withdrawList: (userId?: number, params?: { status?: WithdrawStatus; limit?: number; offset?: number }) =>
    ['wallet', 'withdraws', userId, params?.status || 'all', params?.limit || 20, params?.offset || 0] as const,
  withdrawDetail: (withdrawId?: number) => ['wallet', 'withdraw', 'detail', withdrawId] as const,
  pendingWithdraws: () => ['wallet', 'withdraws', 'pending'] as const,
  evmNonceDiagnostics: (chainId?: number) => ['wallet', 'evm', 'nonce-diagnostics', chainId || 'all'] as const
};
