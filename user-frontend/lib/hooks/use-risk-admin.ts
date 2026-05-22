'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createAddressRisk,
  fetchAddressRisks,
  fetchPendingRiskReviews,
  fetchRiskAdminUsers,
  fetchWithdrawRiskRules,
  submitManualReview,
  updateAddressRiskEnabled,
  updateRiskAdminUserType,
  updateWithdrawRiskRule
} from '@/lib/api/risk-api';
import type { AddressRisk, AdminUserType, WithdrawRiskRule } from '@/types/api/risk';

export const riskAdminKeys = {
  rules: () => ['risk-admin', 'withdraw-risk-rules'] as const,
  addresses: () => ['risk-admin', 'address-risks'] as const,
  reviews: () => ['risk-admin', 'pending-reviews'] as const,
  users: () => ['risk-admin', 'users'] as const
};

export function useWithdrawRiskRules(enabled = true) {
  return useQuery({
    queryKey: riskAdminKeys.rules(),
    enabled,
    queryFn: fetchWithdrawRiskRules
  });
}

export function useUpdateWithdrawRiskRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<WithdrawRiskRule> }) => updateWithdrawRiskRule(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: riskAdminKeys.rules() });
    }
  });
}

export function useAddressRisks(enabled = true) {
  return useQuery({
    queryKey: riskAdminKeys.addresses(),
    enabled,
    queryFn: fetchAddressRisks
  });
}

export function useCreateAddressRisk() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createAddressRisk,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: riskAdminKeys.addresses() });
    }
  });
}

export function useUpdateAddressRiskEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: AddressRisk['enabled'] }) => updateAddressRiskEnabled(id, enabled),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: riskAdminKeys.addresses() });
    }
  });
}

export function usePendingRiskReviews(enabled = true) {
  return useQuery({
    queryKey: riskAdminKeys.reviews(),
    enabled,
    queryFn: fetchPendingRiskReviews
  });
}

export function useSubmitManualReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: submitManualReview,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: riskAdminKeys.reviews() });
    }
  });
}

export function useRiskAdminUsers(enabled = true) {
  return useQuery({
    queryKey: riskAdminKeys.users(),
    enabled,
    queryFn: fetchRiskAdminUsers
  });
}

export function useUpdateRiskAdminUserType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, userType }: { userId: number; userType: AdminUserType }) =>
      updateRiskAdminUserType(userId, userType),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: riskAdminKeys.users() });
    }
  });
}
