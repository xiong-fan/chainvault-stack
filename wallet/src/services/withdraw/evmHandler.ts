import { chainConfigManager } from '../../utils/chains';
import { GasEstimationService } from '../../utils/gasEstimation';
import { HotWalletService } from '../hotWalletService';
import {
  IWithdrawHandler,
  WithdrawContext,
  GasEstimationResult,
  TransactionParams,
  SignRequest,
  SignedTransactionResult
} from './types';

/**
 * EVM 链提现处理器
 */
export class EvmWithdrawHandler implements IWithdrawHandler {
  private gasEstimationService: GasEstimationService;
  private hotWalletService: HotWalletService;

  constructor(
    gasEstimationService: GasEstimationService,
    hotWalletService: HotWalletService
  ) {
    this.gasEstimationService = gasEstimationService;
    this.hotWalletService = hotWalletService;
  }

  async estimateGas(context: WithdrawContext, tokenInfo: any): Promise<GasEstimationResult> {
    return await this.gasEstimationService.estimateEvmTransferGas({
      chainId: context.chainId,
      from: context.hotWallet.address,
      to: context.to,
      amount: context.actualAmount.toString(),
      tokenAddress: tokenInfo.is_native ? null : tokenInfo.token_address,
      tokenType: tokenInfo.token_type || (tokenInfo.is_native ? 'native' : 'erc20'),
      fallbackGasLimit: tokenInfo.is_native ? 50000n : 100000n
    });
  }

  async prepareTransactionParams(context: WithdrawContext, tokenInfo: any): Promise<TransactionParams> {
    // EVM 链：获取 gas 估算
    const gasEstimation = await this.estimateGas(context, tokenInfo);
    return { gasEstimation };
  }

  buildSignRequest(
    context: WithdrawContext,
    transactionParams: TransactionParams,
    tokenInfo: any
  ): SignRequest {
    const gasEstimation = transactionParams.gasEstimation!;

    const signRequest: SignRequest = {
      address: context.hotWallet.address,
      to: context.to,
      amount: context.actualAmount.toString(),
      userId: context.userId,
      tokenId: tokenInfo.id,
      tokenSymbol: context.tokenSymbol,
      ...(gasEstimation.gasLimit && { gas: gasEstimation.gasLimit }),
      ...(gasEstimation.maxFeePerGas && { maxFeePerGas: gasEstimation.maxFeePerGas }),
      ...(gasEstimation.maxPriorityFeePerGas && { maxPriorityFeePerGas: gasEstimation.maxPriorityFeePerGas }),
      nonce: context.hotWallet.nonce,
      chainId: context.chainId,
      chainType: 'evm',
      type: 2, // 使用 EIP-1559
      tokenType: tokenInfo.token_type || (tokenInfo.is_native ? 'native' : 'erc20')
    };

    // 只有非原生代币才设置 tokenAddress
    if (!tokenInfo.is_native && tokenInfo.token_address) {
      signRequest.tokenAddress = tokenInfo.token_address;
    }

    return signRequest;
  }

  async sendTransaction(
    signedTransaction: string,
    context: WithdrawContext
  ): Promise<string> {
    const chain = chainConfigManager.getChainByChainId(context.chainId);
    const rpcUrls = chainConfigManager.getRpcUrls(chain);
    let lastError: unknown;

    for (let rpcIndex = 0; rpcIndex < rpcUrls.length; rpcIndex++) {
      const rpcUrl = rpcUrls[rpcIndex]!;
      const maxRetries = this.isPrimaryRpcAttempt(rpcIndex, rpcUrls.length) ? 2 : 1;

      for (let retry = 1; retry <= maxRetries; retry++) {
        try {
          const publicClient = chainConfigManager.createEvmPublicClient(chain, rpcUrl);
          const txHash = await publicClient.sendRawTransaction({
            serializedTransaction: signedTransaction as `0x${string}`
          });

          console.log('✅ EVM 交易已发送', {
            chainId: context.chainId,
            txHash,
            rpcIndex,
            retry
          });

          return txHash;
        } catch (error) {
          lastError = error;

          if (this.isRpcRateLimitError(error) && retry < maxRetries) {
            const delayMs = retry * 800;
            console.warn('⚠️ EVM RPC 广播被限流，短暂等待后重试', {
              chainId: context.chainId,
              rpcIndex,
              retry,
              delayMs
            });
            await this.sleep(delayMs);
            continue;
          }

          if (this.isRpcRateLimitError(error) && rpcIndex < rpcUrls.length - 1) {
            console.warn('⚠️ EVM RPC 广播被限流，切换备用 RPC', {
              chainId: context.chainId,
              failedRpcIndex: rpcIndex,
              nextRpcIndex: rpcIndex + 1
            });
            break;
          }

          throw error;
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'EVM交易广播失败'));
  }

  /**
   * EVM 提现的 nonce 闭环：
   * 1. 签名前预占 nonce，避免并发提现复用。
   * 2. nonce too low 时同步链上 pending nonce，只重新签名并广播一次。
   * 3. 签名失败或未广播成功的普通错误会尝试回退本次预占。
   */
  async signAndSendTransaction(
    context: WithdrawContext,
    transactionParams: TransactionParams,
    tokenInfo: any,
    signTransaction: (signRequest: SignRequest) => Promise<SignedTransactionResult>
  ): Promise<{
    signedTransaction: string;
    transactionHash: string;
    nonce: number;
  }> {
    const maxAttempts = 2;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const reservedNonce = await this.hotWalletService.reserveNonce(
        context.hotWallet.address,
        context.chainId
      );
      context.hotWallet.nonce = reservedNonce;

      let signedResult: SignedTransactionResult | undefined;
      let broadcastStarted = false;

      try {
        const signRequest = this.buildSignRequest(context, transactionParams, tokenInfo);
        signedResult = await signTransaction(signRequest);

        broadcastStarted = true;
        const txHash = await this.sendTransaction(signedResult.signedTransaction, context);
        await this.afterSendTransaction(txHash, context, transactionParams);

        return {
          signedTransaction: signedResult.signedTransaction,
          transactionHash: txHash,
          nonce: reservedNonce
        };
      } catch (error) {
        lastError = error;

        if (!broadcastStarted) {
          await this.hotWalletService.releaseReservedNonce(
            context.hotWallet.address,
            context.chainId,
            reservedNonce
          );
        }

        if (broadcastStarted && this.isNonceTooLowError(error) && attempt < maxAttempts) {
          const chainNonce = await this.hotWalletService.syncPendingNonceFromChain(
            context.hotWallet.address,
            context.chainId
          );
          console.warn('⚠️ EVM 广播返回 nonce too low，已同步链上pending nonce并准备重试一次:', {
            address: context.hotWallet.address,
            chainId: context.chainId,
            failedNonce: reservedNonce,
            chainPendingNonce: chainNonce
          });
          continue;
        }

        if (broadcastStarted && this.shouldReleaseNonceAfterBroadcastError(error)) {
          await this.hotWalletService.releaseReservedNonce(
            context.hotWallet.address,
            context.chainId,
            reservedNonce
          );
          console.warn('↩️ EVM 广播未返回 txHash，本次 nonce 预占已回退:', {
            address: context.hotWallet.address,
            chainId: context.chainId,
            reservedNonce,
            error: this.collectErrorText(error).slice(0, 500)
          });
        }

        throw error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'EVM交易发送失败'));
  }

  async afterSendTransaction(
    txHash: string,
    context: WithdrawContext,
    transactionParams: TransactionParams
  ): Promise<void> {
    // 标记 nonce 已使用
    await this.hotWalletService.markNonceUsed(
      context.hotWallet.address,
      context.chainId,
      context.hotWallet.nonce
    );
  }

  private isNonceTooLowError(error: unknown): boolean {
    const text = this.collectErrorText(error).toLowerCase();
    return text.includes('nonce too low') ||
      text.includes('nonce has already been used') ||
      text.includes('already known nonce') ||
      text.includes('account nonce too low');
  }

  private isRpcRateLimitError(error: unknown): boolean {
    const maybeStatus = typeof error === 'object' && error !== null ? (error as any).status : undefined;
    const text = this.collectErrorText(error).toLowerCase();
    return maybeStatus === 429 ||
      text.includes('status: 429') ||
      text.includes('too many requests') ||
      text.includes('rate limit');
  }

  private shouldReleaseNonceAfterBroadcastError(error: unknown): boolean {
    const maybeStatus = typeof error === 'object' && error !== null ? (error as any).status : undefined;
    const text = this.collectErrorText(error).toLowerCase();

    if (this.isNonceTooLowError(error)) {
      return false;
    }

    // 这些错误表示 RPC 明确没有返回 txHash。回退本次预占，避免 DB nonce 空跳。
    return maybeStatus === 429 ||
      maybeStatus === 403 ||
      text.includes('status: 429') ||
      text.includes('status: 403') ||
      text.includes('too many requests') ||
      text.includes('rate limit') ||
      text.includes('forbidden') ||
      text.includes('unauthorized') ||
      text.includes('network error') ||
      text.includes('connection refused') ||
      text.includes('econnrefused') ||
      text.includes('enotfound') ||
      text.includes('fetch failed') ||
      text.includes('failed to fetch');
  }

  private isPrimaryRpcAttempt(rpcIndex: number, rpcCount: number): boolean {
    return rpcIndex === 0 || rpcCount === 1;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private collectErrorText(error: unknown): string {
    if (error instanceof Error) {
      return `${error.name} ${error.message} ${error.stack || ''}`;
    }

    if (typeof error === 'string') {
      return error;
    }

    try {
      return JSON.stringify(error);
    } catch {
      return String(error ?? '');
    }
  }
}
