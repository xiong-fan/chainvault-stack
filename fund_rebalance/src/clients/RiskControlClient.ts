export interface RiskAssessmentRequest {
  operation_id: string;
  operation_type: 'read' | 'write' | 'sensitive';
  table: string;
  action: 'select' | 'insert' | 'update' | 'delete';
  data?: unknown;
  conditions?: unknown;
  timestamp: number;
  context?: Record<string, unknown>;
}

export interface RiskAssessmentResponse {
  success: boolean;
  decision: string;
  risk_signature: string;
  timestamp: number;
  db_operation?: {
    table: string;
    action: string;
    data?: unknown;
    conditions?: unknown;
  };
  reasons?: string[];
}

export interface TransactionRiskRequest {
  operation_id: string;
  transaction: {
    from: string;
    to: string;
    amount: string;
    tokenAddress?: string;
    tokenType?: string;
    chainId: number;
    chainType: 'evm' | 'solana';
    nonce: number;
    blockhash?: string;
    lastValidBlockHeight?: string;
    fee?: string;
    businessType?: 'withdraw' | 'collect';
  };
  timestamp: number;
}

export interface TransactionRiskResponse {
  success: boolean;
  risk_signature: string;
  decision: 'approve' | 'freeze' | 'reject' | 'manual_review';
  timestamp: number;
  reasons?: string[];
}

export class RiskControlClient {
  constructor(private readonly baseUrl: string) {}

  async requestRiskAssessment(params: RiskAssessmentRequest): Promise<RiskAssessmentResponse> {
    // DB 敏感写操作风控：返回的 risk_signature 会被 db_gateway 验证。
    const response = await fetch(`${this.baseUrl}/api/assess`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });

    const result = await response.json().catch(() => ({})) as Partial<RiskAssessmentResponse> & {
      error?: { message?: string; details?: unknown };
      message?: string;
    };

    if (!response.ok && response.status !== 403 && response.status !== 202) {
      throw new Error(`risk assess failed: ${response.status} - ${result.error?.message || result.message || 'unknown error'}`);
    }

    if (!result.risk_signature) {
      throw new Error(`risk assess returned no signature: ${result.error?.message || result.message || 'unknown error'}`);
    }

    return result as RiskAssessmentResponse;
  }

  async requestTransactionRiskAssessment(params: TransactionRiskRequest): Promise<TransactionRiskResponse> {
    // 交易签名前风控：返回的 risk_signature 会被 signer 验证。
    const response = await fetch(`${this.baseUrl}/api/withdraw-risk-assessment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });

    const result = await response.json().catch(() => ({})) as Partial<TransactionRiskResponse> & {
      error?: { message?: string; details?: unknown };
      message?: string;
    };

    if (response.status === 403) {
      throw new Error(`risk rejected transaction: ${result.reasons?.join('; ') || result.error?.details || 'unknown reason'}`);
    }

    if (!response.ok) {
      throw new Error(`transaction risk assess failed: ${response.status} - ${result.error?.message || result.message || 'unknown error'}`);
    }

    if (result.decision !== 'approve') {
      throw new Error(`risk decision is ${result.decision}: ${result.reasons?.join('; ') || 'no reason'}`);
    }

    if (!result.risk_signature) {
      throw new Error('transaction risk assess returned no signature');
    }

    return result as TransactionRiskResponse;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      return response.ok;
    } catch {
      return false;
    }
  }
}
