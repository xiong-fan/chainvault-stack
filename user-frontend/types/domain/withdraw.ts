export type WithdrawApiStatus =
  | 'user_withdraw_request'
  | 'signing'
  | 'pending'
  | 'processing'
  | 'confirmed'
  | 'failed'
  | 'manual_review'
  | 'manual_reviewing'
  | 'risk_reviewing'
  | 'rejected';

export const WITHDRAW_STATUS_META: Record<
  WithdrawApiStatus,
  {
    label: string;
    tone: 'default' | 'success' | 'warning' | 'danger';
    flowOrder?: number;
  }
> = {
  user_withdraw_request: {
    label: '待提交',
    tone: 'warning',
    flowOrder: 1
  },
  signing: {
    label: '签名中',
    tone: 'warning',
    flowOrder: 2
  },
  pending: {
    label: '待上链',
    tone: 'warning',
    flowOrder: 3
  },
  processing: {
    label: '处理中',
    tone: 'warning',
    flowOrder: 4
  },
  confirmed: {
    label: '已完成',
    tone: 'success',
    flowOrder: 5
  },
  failed: {
    label: '失败',
    tone: 'danger',
    flowOrder: 6
  },
  manual_review: {
    label: '人工审核',
    tone: 'warning',
    flowOrder: 2.5
  },
  manual_reviewing: {
    label: '人工审核',
    tone: 'warning',
    flowOrder: 2.5
  },
  risk_reviewing: {
    label: '风控复核',
    tone: 'warning',
    flowOrder: 2.2
  },
  rejected: {
    label: '已拒绝',
    tone: 'danger',
    flowOrder: 6.5
  }
};

export const API_WITHDRAW_STATUS_FILTERS: WithdrawApiStatus[] = [
  'user_withdraw_request',
  'signing',
  'pending',
  'processing',
  'confirmed',
  'failed',
  'manual_review',
  'manual_reviewing',
  'risk_reviewing',
  'rejected'
];

export type WithdrawStatusMeta = (typeof WITHDRAW_STATUS_META)[WithdrawApiStatus];

export function getWithdrawStatusMeta(status?: string | null): WithdrawStatusMeta {
  if (status && status in WITHDRAW_STATUS_META) {
    return WITHDRAW_STATUS_META[status as WithdrawApiStatus];
  }

  return {
    label: status || 'unknown',
    tone: 'default'
  };
}

export const WALLET_BACKEND_MODULE = 'wallet';

export const WALLET_WITHDRAW_ENDPOINTS = {
  submit: '/api/user/withdraw',
  list: '/api/user/{id}/withdraws',
  detail: '/api/withdraws/{withdrawId}'
} as const;
