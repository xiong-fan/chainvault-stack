export type ChainType = 'evm' | 'solana';
export type FundTaskStatus =
  | 'planned'
  | 'gas_funding'
  | 'gas_pending'
  | 'gas_funded'
  | 'signing'
  | 'pending'
  | 'confirmed'
  | 'finalized'
  | 'failed'
  | 'skipped';
export type FundTaskType = 'collect';
export type TransactionBusinessType = 'withdraw' | 'collect';

export interface TokenRecord {
  id: number;
  chain_type: string;
  chain_id: number;
  token_address: string | null;
  token_symbol: string;
  token_name?: string | null;
  token_type?: string | null;
  decimals: number;
  is_native: number | boolean;
  collect_amount: string;
  status: number;
}

export interface WalletRecord {
  id: number;
  user_id: number | null;
  address: string;
  device?: string | null;
  path?: string | null;
  chain_type: string;
  wallet_type: string;
  is_active: number;
  created_at?: string;
  updated_at?: string;
}

export interface WalletNonceRecord {
  id: number;
  address: string;
  chain_id: number;
  nonce: number;
  last_used_at?: string | null;
}

export interface FundTaskRecord {
  id: number;
  operation_id: string;
  task_type: FundTaskType;
  chain_type: ChainType;
  chain_id: number;
  token_id: number;
  token_symbol: string;
  from_address: string;
  to_address: string;
  amount: string;
  fee_amount: string;
  tx_hash?: string | null;
  nonce?: number | null;
  status: FundTaskStatus;
  error_message?: string | null;
  retry_count: number;
  metadata?: string | null;
  created_at: string;
  updated_at: string;
}

export interface TransactionRecord {
  id: number;
  block_hash?: string | null;
  block_no: number | null;
  tx_hash: string;
  from_addr?: string | null;
  to_addr?: string | null;
  token_addr?: string | null;
  amount?: string | null;
  type?: string | null;
  status?: string | null;
  confirmation_count?: number | null;
  created_at?: string;
  updated_at?: string;
}

export interface SolanaTransactionRecord {
  id: number;
  slot: number | null;
  tx_hash: string;
  from_addr?: string | null;
  to_addr?: string | null;
  token_mint?: string | null;
  amount?: string | null;
  type?: string | null;
  status?: string | null;
  block_time?: number | null;
  created_at?: string;
  updated_at?: string;
}

export interface SolanaTokenAccountRecord {
  id: number;
  user_id: number | null;
  wallet_id: number;
  wallet_address: string;
  token_mint: string;
  ata_address: string;
  created_at?: string;
  updated_at?: string;
}

export interface CreditRecord {
  id: number;
  user_id: number;
  address: string;
  token_id: number;
  token_symbol: string;
  amount: string;
  credit_type: string;
  business_type: string;
  reference_id: string;
  reference_type: string;
  chain_id: number | null;
  chain_type: string | null;
  status: string;
  block_number?: number | null;
  tx_hash?: string | null;
  event_index?: number | null;
  metadata?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface ServiceCursorRecord {
  service_name: string;
  cursor_name: string;
  cursor_block_no: number;
  cursor_row_id: number;
  metadata?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface GasQuote {
  gas: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
  estimatedFee: bigint;
}

export interface SolanaFeeQuote {
  estimatedFee: bigint;
}

export interface SolanaBlockhash {
  blockhash: string;
  lastValidBlockHeight: string;
}

export interface SolanaTransactionReceipt {
  status: 'success' | 'failed';
  slot: number;
  feeLamports: bigint;
  err?: unknown;
}

export interface CollectionCandidate {
  token: TokenRecord;
  fromWallet: WalletRecord;
  toWallet: WalletRecord;
}

export interface SignTransactionRequest {
  address: string;
  to: string;
  amount: string;
  tokenAddress?: string;
  gas?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  gasPrice?: string;
  nonce: number;
  type: 0 | 2;
  chainId: number;
  chainType: ChainType;
  tokenType?: string;
  fee?: string;
  blockhash?: string;
  lastValidBlockHeight?: string;
  businessType?: TransactionBusinessType;
}

export interface SignTransactionData {
  signedTransaction: string;
  transactionHash: string;
}
