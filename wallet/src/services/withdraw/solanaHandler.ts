import { chainConfigManager } from '../../utils/chains';
import {
  IWithdrawHandler,
  WithdrawContext,
  GasEstimationResult,
  TransactionParams,
  SignRequest
} from './types';

/**
 * Solana 链提现处理器
 */
export class SolanaWithdrawHandler implements IWithdrawHandler {
  async estimateGas(context: WithdrawContext, tokenInfo: any): Promise<GasEstimationResult> {
    // Solana 固定费用（5000 lamports）
    return {
      fee: '5000'
    };
  }

  async prepareTransactionParams(context: WithdrawContext, tokenInfo: any): Promise<TransactionParams> {
    // Solana 链：获取最新的 blockhash
    console.log('🔗 获取 Solana blockhash...');
    const solanaRpc = chainConfigManager.getSolanaRpc();
    const latestBlockhash = await ((solanaRpc as any).getLatestBlockhash().send());

    const solanaBlockhash = latestBlockhash.value.blockhash;
    const solanaLastValidBlockHeight = latestBlockhash.value.lastValidBlockHeight.toString();
    console.log('✅ Solana blockhash:', solanaBlockhash);
    console.log('✅ Solana lastValidBlockHeight:', solanaLastValidBlockHeight);

    return {
      blockhash: solanaBlockhash,
      lastValidBlockHeight: solanaLastValidBlockHeight
    };
  }

  buildSignRequest(
    context: WithdrawContext,
    transactionParams: TransactionParams,
    tokenInfo: any
  ): SignRequest {
    const signRequest: SignRequest = {
      address: context.hotWallet.address,
      to: context.to,
      amount: context.actualAmount.toString(),
      userId: context.userId,
      tokenId: tokenInfo.id,
      tokenSymbol: context.tokenSymbol,
      ...(transactionParams.blockhash && { blockhash: transactionParams.blockhash }),
      ...(transactionParams.lastValidBlockHeight && { lastValidBlockHeight: transactionParams.lastValidBlockHeight }),
      ...(transactionParams.fee && { fee: transactionParams.fee }),
      tokenType: tokenInfo.token_type || (tokenInfo.is_native ? 'sol-native' : 'spl-token'),
      chainId: context.chainId,
      chainType: 'solana'
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
    // Solana 交易发送
    console.log('📤 发送 Solana 交易到网络...');
    const solanaRpc = chainConfigManager.getSolanaRpc();

    // signedTransaction 是 base64 编码的签名交易
    const txSignature = await ((solanaRpc as any).sendTransaction(
      signedTransaction,
      {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        encoding: 'base64'
      }
    ).send());

    console.log(`✅ Solana 交易已发送，签名: ${txSignature}`);

    return txSignature;
  }

  async afterSendTransaction(
    txHash: string,
    context: WithdrawContext,
    transactionParams: TransactionParams
  ): Promise<void> {
    // Solana 不需要 nonce 管理
    // 无需额外操作
  }
}
