import dotenv from 'dotenv';

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function bigintEnv(name: string, fallback?: bigint): bigint | undefined {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    const parsed = BigInt(raw);
    if (parsed < 0n) throw new Error();
    return parsed;
  } catch {
    throw new Error(`${name} must be a non-negative integer string`);
  }
}

export const config = {
  port: intEnv('PORT', 3010),
  dbGatewayBaseUrl: process.env.DB_GATEWAY_BASE_URL || 'http://localhost:3003',
  signerBaseUrl: process.env.SIGNER_BASE_URL || 'http://localhost:3001',
  riskControlUrl: process.env.RISK_CONTROL_URL || 'http://localhost:3004',
  evmRpcUrl: process.env.EVM_RPC_URL || 'http://127.0.0.1:8545',
  solanaRpcUrl: process.env.SOLANA_RPC_URL || 'http://127.0.0.1:8899',
  solanaRpcUrlBackup: process.env.SOLANA_RPC_URL_BACKUP || '',
  chainId: intEnv('CHAIN_ID', 31337),
  solanaChainId: intEnv('SOLANA_CHAIN_ID', 900),
  collectIntervalSeconds: intEnv('COLLECT_INTERVAL_SECONDS', 300),
  maxConcurrentTasks: intEnv('MAX_CONCURRENT_TASKS', 3),
  depositCandidateBatchSize: intEnv('DEPOSIT_CANDIDATE_BATCH_SIZE', 200),
  inventoryReconcileIntervalSeconds: intEnv('INVENTORY_RECONCILE_INTERVAL_SECONDS', 21600),
  receiptInitialCheckDelaySeconds: intEnv('RECEIPT_INITIAL_CHECK_DELAY_SECONDS', 30),
  receiptMaxCheckDelaySeconds: intEnv('RECEIPT_MAX_CHECK_DELAY_SECONDS', 180),
  gasFeeCacheTtlSeconds: intEnv('GAS_FEE_CACHE_TTL_SECONDS', 30),
  erc20GasTopUpEnabled: boolEnv('ERC20_GAS_TOP_UP_ENABLED', true),
  erc20GasTopUpBufferBps: intEnv('ERC20_GAS_TOP_UP_BUFFER_BPS', 15000),
  erc20GasTopUpMaxWei: bigintEnv('ERC20_GAS_TOP_UP_MAX_WEI'),
  erc20GasTopUpMinWei: bigintEnv('ERC20_GAS_TOP_UP_MIN_WEI', 0n) || 0n,
  solanaFeeTopUpEnabled: boolEnv('SOLANA_FEE_TOP_UP_ENABLED', true),
  solanaFeeTopUpBufferBps: intEnv('SOLANA_FEE_TOP_UP_BUFFER_BPS', 15000),
  solanaFeeTopUpMaxLamports: bigintEnv('SOLANA_FEE_TOP_UP_MAX_LAMPORTS'),
  solanaFeeTopUpMinLamports: bigintEnv('SOLANA_FEE_TOP_UP_MIN_LAMPORTS', 0n) || 0n,
  walletPrivateKey: required('WALLET_PRIVATE_KEY')
};

export default config;
