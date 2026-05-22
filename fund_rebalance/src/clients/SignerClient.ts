import { Ed25519Signer } from '../utils/crypto';
import { RiskControlClient } from './RiskControlClient';
import { SignTransactionData, SignTransactionRequest } from '../types';

interface SignerApiResponse<T> {
  success: boolean;
  message?: string;
  data?: T;
  error?: string;
}

export class SignerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly signer: Ed25519Signer,
    private readonly riskControlClient: RiskControlClient
  ) {}

  async signTransaction(request: SignTransactionRequest, operationId: string): Promise<SignTransactionData> {
    const timestamp = Date.now();

    // 签名仍走 risk_control -> signer 双签，但归集必须标记 businessType=collect，避免套用用户提现限额。
    const riskResult = await this.riskControlClient.requestTransactionRiskAssessment({
      operation_id: operationId,
      transaction: {
        from: request.address,
        to: request.to,
        amount: request.amount,
        chainId: request.chainId,
        chainType: request.chainType,
        nonce: request.nonce,
        ...(request.tokenAddress && { tokenAddress: request.tokenAddress }),
        ...(request.tokenType && { tokenType: request.tokenType }),
        ...(request.blockhash && { blockhash: request.blockhash }),
        ...(request.lastValidBlockHeight && { lastValidBlockHeight: request.lastValidBlockHeight }),
        ...(request.fee && { fee: request.fee }),
        ...(request.businessType && { businessType: request.businessType })
      },
      timestamp
    });

    // wallet_signature 的 JSON 字段顺序必须和 signer/src/utils/signatureValidator.ts 保持一致。
    const walletSignature = this.signer.signMessage(JSON.stringify(this.buildSignaturePayload(operationId, request, timestamp)));

    // signer 不接受 fund_rebalance 自定义模型，只接受现有 sign-transaction 请求格式。
    const response = await fetch(`${this.baseUrl}/api/signer/sign-transaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...request,
        tokenAddress: request.tokenAddress ?? null,
        fee: request.fee ?? null,
        operation_id: operationId,
        timestamp,
        risk_signature: riskResult.risk_signature,
        wallet_signature: walletSignature
      })
    });

    const result = await response.json().catch(() => ({})) as SignerApiResponse<SignTransactionData>;
    if (!response.ok || !result.success || !result.data) {
      throw new Error(`signer failed: ${response.status} - ${result.error || result.message || 'unknown error'}`);
    }

    return result.data;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  private buildSignaturePayload(
    operationId: string,
    request: SignTransactionRequest,
    timestamp: number
  ): Record<string, unknown> {
    // 签名字段顺序必须和 risk_control / signer 的 SignatureValidator 保持一致。
    return {
      operation_id: operationId,
      chainType: request.chainType,
      from: request.address,
      to: request.to,
      amount: request.amount,
      tokenAddress: request.tokenAddress ?? null,
      tokenType: request.tokenType ?? null,
      chainId: request.chainId,
      nonce: request.nonce,
      blockhash: request.blockhash ?? null,
      lastValidBlockHeight: request.lastValidBlockHeight ?? null,
      fee: request.fee ?? null,
      timestamp
    };
  }
}
