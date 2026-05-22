export interface ApiResponse<T = unknown> {
  message?: string;
  details?: unknown;
  success?: boolean;
  data?: T;
  error?: string;
}

export interface TokenBalanceItem {
  chain_id?: number | null;
  chain_type?: string | null;
  token_symbol: string;
  total_balance: string;
  available_balance: string;
  frozen_balance: string;
  address_count: number;
}

export interface WalletTokenConfig {
  id: number;
  chain_type: 'evm' | 'btc' | 'solana' | string;
  chain_id: number;
  token_address?: string | null;
  token_symbol: string;
  token_name?: string | null;
  token_type?: string | null;
  decimals: number;
  is_native: 0 | 1 | boolean;
  collect_amount: string;
  withdraw_fee: string;
  min_withdraw_amount: string;
  status: 0 | 1 | number;
  created_at?: string;
  updated_at?: string;
}

export interface CreateErc20TokenRequest {
  chain_id: number;
  token_address: string;
  collect_amount?: string;
  withdraw_fee?: string;
  min_withdraw_amount?: string;
}

export type TokenOnboardingType = 'erc20' | 'spl-token' | 'spl-token-2022';

export interface TokenOnboardingOption {
  chain_type: 'evm' | 'solana';
  chain_id: number;
  name: string;
  token_types: TokenOnboardingType[];
}

export interface CreateTokenRequest {
  chain_type: 'evm' | 'solana';
  chain_id: number;
  token_type: TokenOnboardingType;
  token_address: string;
  token_symbol?: string;
  token_name?: string;
  collect_amount?: string;
  withdraw_fee?: string;
  min_withdraw_amount?: string;
}

export interface BalanceStats {
  user_id: number;
  chain_count: number;
  token_count: number;
  address_count: number;
  positive_balance_count: number;
  last_balance_update: string | null;
}

export interface BalanceDetailItem {
  user_id: number;
  chain_id?: number | null;
  chain_type?: string | null;
  address: string;
  token_id: number;
  token_symbol: string;
  decimals: number;
  available_balance: string;
  frozen_balance: string;
  total_balance: string;
  available_balance_formatted: string;
  frozen_balance_formatted: string;
  total_balance_formatted: string;
}

export interface PendingDepositItem {
  chain_id?: number | null;
  chain_type?: string | null;
  token_id: number;
  token_symbol: string;
  pending_amount: string;
  transaction_count: number;
  scanned_count: number;
  confirming_count: number;
  safe_count: number;
  latest_status: 'confirmed' | 'safe';
  latest_confirmation_count: number;
  required_confirmations: number | null;
  deposits: {
    tx_hash: string;
    amount: string;
    status: 'confirmed' | 'safe';
    confirmation_count: number;
    required_confirmations: number | null;
    progress_label: string;
    block_number: number | null;
    address: string;
    created_at: string | null;
    updated_at: string | null;
  }[];
}

export interface TokenBalanceDetail {
  token_symbol: string;
  chain_details: {
    chain_id?: number | null;
    chain_type: string;
    address?: string;
    token_id: number;
    balance: string;
    decimals: number;
    normalized_balance: string;
  }[];
  total_normalized_balance: string;
  chain_count: number;
}

export type WithdrawRecordStatus =
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

export interface WithdrawItem {
  id: number;
  user_id: number;
  to_address: string;
  token_id: number;
  amount: string;
  fee: string;
  chain_id: number;
  chain_type: 'evm' | 'btc' | 'solana';
  from_address?: string;
  tx_hash?: string;
  status: WithdrawRecordStatus;
  error_message?: string | null;
  tx_raw?: string;
  gas_price?: string;
  max_fee_per_gas?: string;
  max_priority_fee_per_gas?: string;
  gas_used?: string;
  nonce?: number;
  created_at: string;
  updated_at: string;
}

export interface WithdrawListResponse {
  withdraws: WithdrawItem[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

export interface WithdrawDetail {
  withdraw: WithdrawItem;
  credits: Array<{
    id: number;
    user_id: number;
    token_id: number;
    amount: string;
    balance: string;
    reference_type: string;
    reference_id: number;
    created_at: string;
  }>;
}

export interface EvmNonceDiagnosticWithdraw {
  id: number;
  user_id: number;
  status: string;
  amount: string;
  token_id: number;
  token_symbol?: string | null;
  to_address: string;
  nonce?: number | null;
  tx_hash?: string | null;
  error_message?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface EvmNonceDiagnostic {
  address: string;
  chainId: number;
  chainType: 'evm';
  dbNonce: number;
  chainPendingNonce: number | null;
  state: 'ready' | 'skip' | 'diagnostic' | 'error';
  reason?: string;
  error?: string;
  openWithdraws: EvmNonceDiagnosticWithdraw[];
  queuedWithdraws: EvmNonceDiagnosticWithdraw[];
  suggestedActions: string[];
}

export interface WalletAddressResponse {
  id: number;
  user_id: number;
  address: string;
  chain_type: 'evm' | 'btc' | 'solana';
  wallet_type: string;
  path?: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateWithdrawResponse {
  signedTransaction?: string;
  transactionHash?: string;
  withdrawAmount: string;
  actualAmount: string;
  fee: string;
  withdrawId: number;
  gasEstimation?: {
    gasLimit?: string;
    maxFeePerGas?: string;
    maxPriorityFeePerGas?: string;
    networkCongestion?: 'low' | 'medium' | 'high';
  };
}
