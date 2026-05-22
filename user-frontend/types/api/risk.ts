export interface RiskApiResponse<T = unknown> {
  success?: boolean;
  data?: T;
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  } | string;
}

export interface WithdrawRiskRule {
  id: number;
  name: string;
  chain_type?: 'evm' | 'btc' | 'solana' | null;
  chain_id?: number | null;
  token_symbol?: string | null;
  token_id?: number | null;
  single_withdraw_limit: string;
  daily_withdraw_limit: string;
  frequency_window_seconds: number;
  frequency_max_count: number;
  limit_action: 'manual_review' | 'reject';
  enabled: 0 | 1;
  priority: number;
  created_at?: string;
  updated_at?: string;
}

export interface AddressRisk {
  id: number;
  address: string;
  chain_type: 'evm' | 'btc' | 'solana';
  risk_type: 'blacklist' | 'whitelist' | 'suspicious' | 'sanctioned';
  risk_level: 'low' | 'medium' | 'high';
  reason?: string | null;
  source: 'manual' | 'auto' | 'chainalysis' | 'ofac';
  enabled: 0 | 1;
  created_at?: string;
  updated_at?: string;
}

export interface PendingRiskReview {
  id: number;
  operation_id: string;
  table_name?: string | null;
  action: string;
  user_id?: number | null;
  operation_data: Record<string, unknown>;
  suggest_operation_data?: Record<string, unknown> | null;
  suggest_reason?: string | null;
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  reasons: string[];
  created_at?: string;
}

export type AdminUserType = 'normal' | 'customer_service' | 'risk_operator' | 'support' | 'admin' | 'sys_admin';

export interface RiskAdminUser {
  id: number;
  username: string;
  email: string | null;
  phone?: string | null;
  user_type: AdminUserType;
  status: number;
  kyc_status: number;
  created_at?: string;
  updated_at?: string;
  last_login_at?: string | null;
}
