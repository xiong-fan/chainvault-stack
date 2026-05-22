import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  formatGwei,
  http,
  parseAbi,
  PublicClient,
  TransactionReceipt
} from 'viem';
import { localhost } from 'viem/chains';
import config from '../config';
import { GasQuote } from '../types';

const erc20ReadAbi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)'
]);

export class EvmClient {
  private readonly client: PublicClient;
  private feeCache: {
    expiresAt: number;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
    gasPrice?: bigint;
  } | null = null;
  private rpcStats: Record<string, number> = {};

  constructor(rpcUrl: string) {
    this.client = createPublicClient({
      chain: localhost,
      transport: http(rpcUrl)
    });
  }

  async getNativeBalance(address: string): Promise<bigint> {
    this.countRpc('getBalance');
    return this.client.getBalance({ address: address as `0x${string}` });
  }

  async getErc20Balance(tokenAddress: string, owner: string): Promise<bigint> {
    this.countRpc('readContract.balanceOf');
    const result = await this.client.readContract({
      address: tokenAddress as `0x${string}`,
      abi: erc20ReadAbi,
      functionName: 'balanceOf',
      args: [owner as `0x${string}`]
    });
    return result;
  }

  async getPendingNonce(address: string): Promise<number> {
    // 使用 pending nonce，避免同一充值地址已有未确认交易时重复使用 nonce。
    this.countRpc('getTransactionCount');
    return this.client.getTransactionCount({
      address: address as `0x${string}`,
      blockTag: 'pending'
    });
  }

  async quoteNativeTransfer(from: string, to: string, amount: bigint): Promise<GasQuote> {
    // 原生币归集的 gas 通常是 21000；估算失败时用标准值兜底。
    this.countRpc('estimateGas.native');
    const gas = await this.client.estimateGas({
      account: from as `0x${string}`,
      to: to as `0x${string}`,
      value: amount > 0n ? amount : 1n
    }).catch(() => 21000n);

    return this.quoteGas(gas);
  }

  async quoteGasTopUpTransfer(from: string, to: string, amount: bigint): Promise<GasQuote> {
    return this.quoteNativeTransfer(from, to, amount > 0n ? amount : 1n);
  }

  async quoteErc20Transfer(from: string, tokenAddress: string, to: string, amount: bigint): Promise<GasQuote> {
    // ERC20 gas 估算需要构造 transfer calldata，因为实际交易是发往 token 合约。
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [to as `0x${string}`, amount]
    });

    this.countRpc('estimateGas.erc20');
    const gas = await this.client.estimateGas({
      account: from as `0x${string}`,
      to: tokenAddress as `0x${string}`,
      data
    }).catch(() => 100000n);

    return this.quoteGas(gas);
  }

  async sendRawTransaction(signedTransaction: string): Promise<string> {
    this.countRpc('sendRawTransaction');
    return this.client.sendRawTransaction({
      serializedTransaction: signedTransaction as `0x${string}`
    });
  }

  async getReceipt(txHash: string): Promise<TransactionReceipt | null> {
    try {
      this.countRpc('getTransactionReceipt');
      return await this.client.getTransactionReceipt({ hash: txHash as `0x${string}` });
    } catch {
      return null;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      this.countRpc('getBlockNumber');
      await this.client.getBlockNumber();
      return true;
    } catch {
      return false;
    }
  }

  flushRpcStats(): Record<string, number> {
    const stats = { ...this.rpcStats };
    this.rpcStats = {};
    return stats;
  }

  private async quoteGas(gas: bigint): Promise<GasQuote> {
    const cachedFee = this.getCachedFee();
    if (cachedFee?.maxFeePerGas && cachedFee.maxPriorityFeePerGas) {
      return {
        gas,
        maxFeePerGas: cachedFee.maxFeePerGas,
        maxPriorityFeePerGas: cachedFee.maxPriorityFeePerGas,
        estimatedFee: gas * cachedFee.maxFeePerGas
      };
    }
    if (cachedFee?.gasPrice) {
      return {
        gas,
        gasPrice: cachedFee.gasPrice,
        estimatedFee: gas * cachedFee.gasPrice
      };
    }

    try {
      // 优先使用 EIP-1559 费用模型；本地链或旧链不支持时再退回 gasPrice。
      this.countRpc('estimateFeesPerGas');
      const fees = await this.client.estimateFeesPerGas();
      if (fees.maxFeePerGas && fees.maxPriorityFeePerGas) {
        this.setCachedFee({
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas
        });
        return {
          gas,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
          estimatedFee: gas * fees.maxFeePerGas
        };
      }
    } catch {
      // Fall through to gas price.
    }

    this.countRpc('getGasPrice');
    const gasPrice = await this.client.getGasPrice();
    this.setCachedFee({ gasPrice });
    return {
      gas,
      gasPrice,
      estimatedFee: gas * gasPrice
    };
  }

  describeGas(quote: GasQuote): Record<string, string> {
    return {
      gas: quote.gas.toString(),
      estimatedFee: quote.estimatedFee.toString(),
      ...(quote.maxFeePerGas && { maxFeePerGas: quote.maxFeePerGas.toString(), maxFeePerGasGwei: formatGwei(quote.maxFeePerGas) }),
      ...(quote.maxPriorityFeePerGas && {
        maxPriorityFeePerGas: quote.maxPriorityFeePerGas.toString(),
        maxPriorityFeePerGasGwei: formatGwei(quote.maxPriorityFeePerGas)
      }),
      ...(quote.gasPrice && { gasPrice: quote.gasPrice.toString(), gasPriceGwei: formatGwei(quote.gasPrice) })
    };
  }

  private getCachedFee(): { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasPrice?: bigint } | null {
    if (!this.feeCache || this.feeCache.expiresAt <= Date.now()) {
      return null;
    }
    return this.feeCache;
  }

  private setCachedFee(fee: { maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint; gasPrice?: bigint }): void {
    this.feeCache = {
      ...fee,
      expiresAt: Date.now() + config.gasFeeCacheTtlSeconds * 1000
    };
  }

  private countRpc(method: string): void {
    this.rpcStats[method] = (this.rpcStats[method] || 0) + 1;
  }
}
