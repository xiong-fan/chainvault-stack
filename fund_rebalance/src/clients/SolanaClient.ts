import { SolanaBlockhash, SolanaFeeQuote, SolanaTransactionReceipt } from '../types';

interface RpcResponse<T> {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface TokenAccountBalance {
  value?: {
    amount?: string;
  };
}

interface LatestBlockhashResponse {
  value: {
    blockhash: string;
    lastValidBlockHeight: number;
  };
}

interface TransactionResponse {
  slot: number;
  meta?: {
    err?: unknown;
    fee?: number;
  } | null;
}

const SOL_TRANSFER_SIGNATURE_FEE_LAMPORTS = 5000n;
const SPL_TRANSFER_SIGNATURE_FEE_LAMPORTS = 5000n;
const ASSOCIATED_TOKEN_ACCOUNT_RENT_BUFFER_LAMPORTS = 2039280n;

export class SolanaClient {
  private rpcStats: Record<string, number> = {};

  constructor(
    private readonly rpcUrl: string,
    private readonly backupRpcUrl?: string
  ) {}

  async getNativeBalance(address: string): Promise<bigint> {
    const result = await this.rpc<{ value: number }>('getBalance', [address]);
    return BigInt(result.value);
  }

  async getTokenAccountBalance(ataAddress: string): Promise<bigint> {
    const result = await this.rpc<TokenAccountBalance>('getTokenAccountBalance', [ataAddress]);
    return BigInt(result.value?.amount || '0');
  }

  quoteNativeTransfer(): SolanaFeeQuote {
    // 当前 signer 构造的是单签名 SOL 转账，手续费按本地链/主网常见 5000 lamports 预估。
    return { estimatedFee: SOL_TRANSFER_SIGNATURE_FEE_LAMPORTS };
  }

  quoteTokenTransfer(): SolanaFeeQuote {
    // signer 会用 idempotent 指令创建目标 ATA；目标 ATA 不存在时付款方还需要承担租金。
    return {
      estimatedFee: SPL_TRANSFER_SIGNATURE_FEE_LAMPORTS + ASSOCIATED_TOKEN_ACCOUNT_RENT_BUFFER_LAMPORTS
    };
  }

  async getLatestBlockhash(): Promise<SolanaBlockhash> {
    const result = await this.rpc<LatestBlockhashResponse>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    return {
      blockhash: result.value.blockhash,
      lastValidBlockHeight: String(result.value.lastValidBlockHeight)
    };
  }

  async sendRawTransaction(signedTransaction: string): Promise<string> {
    return this.rpc<string>('sendTransaction', [
      signedTransaction,
      {
        encoding: 'base64',
        skipPreflight: false,
        preflightCommitment: 'confirmed'
      }
    ]);
  }

  async getReceipt(signature: string): Promise<SolanaTransactionReceipt | null> {
    const result = await this.rpc<TransactionResponse | null>('getTransaction', [
      signature,
      {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0
      }
    ]).catch(() => null);

    if (!result) return null;

    return {
      status: result.meta?.err ? 'failed' : 'success',
      slot: result.slot,
      feeLamports: BigInt(result.meta?.fee || 0),
      err: result.meta?.err
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.rpc<string>('getHealth', []);
      return true;
    } catch {
      try {
        await this.rpc<number>('getSlot', [{ commitment: 'confirmed' }]);
        return true;
      } catch {
        return false;
      }
    }
  }

  flushRpcStats(): Record<string, number> {
    const stats = { ...this.rpcStats };
    this.rpcStats = {};
    return stats;
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    this.countRpc(method);
    const payload = {
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params
    };

    const primaryError = await this.postRpc<T>(this.rpcUrl, payload).catch(error => error);
    if (!(primaryError instanceof Error)) {
      return primaryError;
    }

    if (this.backupRpcUrl) {
      return this.postRpc<T>(this.backupRpcUrl, payload);
    }

    throw primaryError;
  }

  private async postRpc<T>(url: string, payload: Record<string, unknown>): Promise<T> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000)
    });
    const result = await response.json().catch(() => ({})) as RpcResponse<T>;
    if (!response.ok || result.error || result.result === undefined) {
      throw new Error(`solana rpc ${String(payload.method)} failed: ${response.status} - ${result.error?.message || 'unknown error'}`);
    }
    return result.result;
  }

  private countRpc(method: string): void {
    this.rpcStats[method] = (this.rpcStats[method] || 0) + 1;
  }
}
