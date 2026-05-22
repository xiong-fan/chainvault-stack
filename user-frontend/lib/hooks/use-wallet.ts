'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createToken,
  createErc20Token,
  createWithdraw,
  fetchAdminTokens,
  fetchAvailableTokens,
  fetchBalanceDetails,
  fetchBalanceStats,
  fetchEvmNonceDiagnostics,
  fetchPendingDeposits,
  fetchPendingWithdraws,
  fetchTokenOnboardingOptions,
  fetchTotalBalances,
  fetchTokenBalance,
  fetchWalletAddress,
  fetchWithdrawDetail,
  fetchWithdrawList,
  retryWithdrawBroadcast
} from '@/lib/api/wallet-api';
import { SupportedChainType, WithdrawStatus } from '@/lib/types';
import { getWalletApiKeys } from './use-wallet-keys';
import type { CreateErc20TokenRequest, CreateTokenRequest } from '@/types/api/wallet';

export function useTotalBalances(userId?: number) {
  return useQuery({
    queryKey: getWalletApiKeys.totalBalances(userId),
    enabled: !!userId,
    queryFn: () => fetchTotalBalances(userId!)
  });
}

export function useBalanceStats(userId?: number) {
  return useQuery({
    queryKey: getWalletApiKeys.balanceStats(userId),
    enabled: !!userId,
    queryFn: () => fetchBalanceStats(userId!)
  });
}

export function useBalanceDetails(userId?: number) {
  return useQuery({
    queryKey: getWalletApiKeys.balanceDetails(userId),
    enabled: !!userId,
    queryFn: () => fetchBalanceDetails(userId!)
  });
}

export function usePendingDeposits(userId?: number) {
  return useQuery({
    queryKey: getWalletApiKeys.pendingDeposits(userId),
    enabled: !!userId,
    refetchInterval: 15000,
    refetchOnWindowFocus: true,
    queryFn: () => fetchPendingDeposits(userId!)
  });
}

export function useWalletAddress(userId?: number, chainType: SupportedChainType = 'evm') {
  return useQuery({
    queryKey: getWalletApiKeys.walletAddress(userId, chainType),
    enabled: !!userId,
    queryFn: () => fetchWalletAddress(userId!, chainType)
  });
}

export function useTokenBalance(userId?: number, symbol?: string, enabled = false) {
  return useQuery({
    queryKey: getWalletApiKeys.tokenDetail(userId, symbol),
    enabled: Boolean(userId && symbol && enabled),
    queryFn: () => fetchTokenBalance(userId!, symbol!)
  });
}

export function useAdminTokens(params?: { chainType?: SupportedChainType; chainId?: number; tokenSymbol?: string }) {
  return useQuery({
    queryKey: getWalletApiKeys.adminTokens(params),
    queryFn: () => fetchAdminTokens(params)
  });
}

export function useAvailableTokens(params?: { chainType?: SupportedChainType; chainId?: number }) {
  return useQuery({
    queryKey: getWalletApiKeys.availableTokens(params),
    queryFn: () => fetchAvailableTokens(params)
  });
}

export function useTokenOnboardingOptions() {
  return useQuery({
    queryKey: getWalletApiKeys.tokenOnboardingOptions(),
    queryFn: fetchTokenOnboardingOptions
  });
}

export function useCreateToken() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: CreateTokenRequest) => createToken(request),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['wallet', 'admin', 'tokens'] });
      queryClient.invalidateQueries({ queryKey: ['wallet', 'tokens'] });
    }
  });
}

export function useCreateErc20Token() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: CreateErc20TokenRequest) => createErc20Token(request),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['wallet', 'admin', 'tokens'] });
      queryClient.invalidateQueries({ queryKey: ['wallet', 'tokens'] });
    }
  });
}

export function useWithdrawList(userId?: number, params?: { status?: WithdrawStatus; limit?: number; offset?: number }) {
  return useQuery({
    queryKey: getWalletApiKeys.withdrawList(userId, params),
    enabled: !!userId,
    queryFn: () => fetchWithdrawList(userId!, params)
  });
}

export function useWithdrawDetail(withdrawId?: number) {
  return useQuery({
    queryKey: getWalletApiKeys.withdrawDetail(withdrawId),
    enabled: !!withdrawId,
    queryFn: () => fetchWithdrawDetail(withdrawId!)
  });
}

export function usePendingWithdrawList() {
  return useQuery({
    queryKey: getWalletApiKeys.pendingWithdraws(),
    queryFn: () => fetchPendingWithdraws()
  });
}

export function useEvmNonceDiagnostics(enabled = true, chainId?: number) {
  return useQuery({
    queryKey: getWalletApiKeys.evmNonceDiagnostics(chainId),
    enabled,
    refetchInterval: 15000,
    queryFn: () => fetchEvmNonceDiagnostics({ chainId })
  });
}

export function useRetryWithdrawBroadcast() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: retryWithdrawBroadcast,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['wallet', 'evm', 'nonce-diagnostics'] });
      queryClient.invalidateQueries({ queryKey: getWalletApiKeys.pendingWithdraws() });
    }
  });
}

export function useCreateWithdraw(userId?: number) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: createWithdraw,
    onSuccess: () => {
      if (!userId) return;
      queryClient.invalidateQueries({ queryKey: getWalletApiKeys.withdrawList(userId) });
      queryClient.invalidateQueries({ queryKey: getWalletApiKeys.totalBalances(userId) });
      queryClient.invalidateQueries({ queryKey: getWalletApiKeys.balanceStats(userId) });
      queryClient.invalidateQueries({ queryKey: getWalletApiKeys.balanceDetails(userId) });
      queryClient.invalidateQueries({ queryKey: getWalletApiKeys.pendingDeposits(userId) });
    }
  });
}
