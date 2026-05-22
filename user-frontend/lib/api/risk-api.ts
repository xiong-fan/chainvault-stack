import { requestJson, walletApi } from './client';
import type { AddressRisk, AdminUserType, PendingRiskReview, RiskAdminUser, RiskApiResponse, WithdrawRiskRule } from '@/types/api/risk';

const riskApi = {
  baseUrl: walletApi.baseUrl
};

function unwrap<T>(result: RiskApiResponse<T>, fallback: string): T {
  if (result.data !== undefined) return result.data;
  const error = result.error;
  if (typeof error === 'string') throw new Error(error);
  throw new Error(error?.message || fallback);
}

export async function fetchWithdrawRiskRules(): Promise<WithdrawRiskRule[]> {
  const result = await requestJson<RiskApiResponse<WithdrawRiskRule[]>>(
    `${riskApi.baseUrl}/api/admin/risk/withdraw-risk-rules`,
    { method: 'GET' }
  );
  return result.data || [];
}

export async function updateWithdrawRiskRule(
  id: number,
  data: Partial<WithdrawRiskRule>
): Promise<WithdrawRiskRule | null> {
  const result = await requestJson<RiskApiResponse<WithdrawRiskRule | null>>(
    `${riskApi.baseUrl}/api/admin/risk/withdraw-risk-rules/${id}`,
    {
      method: 'PATCH',
      body: JSON.stringify(data)
    }
  );
  return unwrap(result, '更新提现风控规则失败');
}

export async function fetchAddressRisks(): Promise<AddressRisk[]> {
  const result = await requestJson<RiskApiResponse<AddressRisk[]>>(
    `${riskApi.baseUrl}/api/admin/risk/address-risks`,
    { method: 'GET' }
  );
  return result.data || [];
}

export async function createAddressRisk(data: {
  address: string;
  chain_type: AddressRisk['chain_type'];
  risk_type: AddressRisk['risk_type'];
  risk_level: AddressRisk['risk_level'];
  reason?: string;
  source?: AddressRisk['source'];
  enabled?: 0 | 1;
}): Promise<{ id: number }> {
  const result = await requestJson<RiskApiResponse<{ id: number }>>(
    `${riskApi.baseUrl}/api/admin/risk/address-risks`,
    {
      method: 'POST',
      body: JSON.stringify(data)
    }
  );
  return unwrap(result, '新增风险地址失败');
}

export async function updateAddressRiskEnabled(id: number, enabled: 0 | 1): Promise<{ id: number; enabled: 0 | 1 }> {
  const result = await requestJson<RiskApiResponse<{ id: number; enabled: 0 | 1 }>>(
    `${riskApi.baseUrl}/api/admin/risk/address-risks/${id}/enabled`,
    {
      method: 'PATCH',
      body: JSON.stringify({ enabled })
    }
  );
  return unwrap(result, '更新风险地址状态失败');
}

export async function fetchPendingRiskReviews(): Promise<PendingRiskReview[]> {
  const result = await requestJson<RiskApiResponse<PendingRiskReview[]>>(
    `${riskApi.baseUrl}/api/admin/risk/pending-reviews`,
    { method: 'GET' }
  );
  return result.data || [];
}

export async function submitManualReview(data: {
  operation_id: string;
  approved: boolean;
  approver_user_id: number;
  approver_username?: string;
  comment?: string;
}): Promise<{ success?: boolean; message?: string }> {
  return await requestJson<{ success?: boolean; message?: string }>(
    `${riskApi.baseUrl}/api/admin/risk/manual-review`,
    {
      method: 'POST',
      body: JSON.stringify(data)
    }
  );
}

export async function fetchRiskAdminUsers(): Promise<RiskAdminUser[]> {
  const result = await requestJson<RiskApiResponse<RiskAdminUser[]>>(
    `${riskApi.baseUrl}/api/admin/users`,
    { method: 'GET' }
  );
  return result.data || [];
}

export async function updateRiskAdminUserType(
  userId: number,
  userType: AdminUserType
): Promise<{ userId: number; userType: AdminUserType }> {
  const result = await requestJson<RiskApiResponse<{ userId: number; userType: AdminUserType }>>(
    `${riskApi.baseUrl}/api/admin/users/${userId}/type`,
    {
      method: 'PATCH',
      body: JSON.stringify({ userType })
    }
  );
  return unwrap(result, '更新用户类型失败');
}
