import { v4 as uuidv4 } from 'uuid';
import { RiskControlClient } from './RiskControlClient';
import { Ed25519Signer, SignaturePayload } from '../utils/crypto';
import {
  CreditRecord,
  FundTaskRecord,
  FundTaskStatus,
  ServiceCursorRecord,
  SolanaTokenAccountRecord,
  SolanaTransactionRecord,
  TokenRecord,
  TransactionRecord,
  WalletNonceRecord,
  WalletRecord
} from '../types';

type DatabaseAction = 'select' | 'insert' | 'update' | 'delete';
type OperationType = 'read' | 'write' | 'sensitive';

interface GatewayResponse {
  success: boolean;
  operation_id: string;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export class DbGatewayClient {
  constructor(
    private readonly baseUrl: string,
    private readonly signer: Ed25519Signer,
    private readonly riskControlClient: RiskControlClient
  ) {}

  async getCollectableEvmTokens(chainId: number): Promise<TokenRecord[]> {
    // db_gateway 只提供通用 select 能力，collect_amount 的数值过滤放在服务侧做。
    const rows = await this.select<TokenRecord>('tokens', {
      chain_type: 'evm',
      chain_id: chainId,
      status: 1
    });

    return rows.filter(token => {
      try {
        return BigInt(token.collect_amount || '0') > 0n;
      } catch {
        return false;
      }
    });
  }

  async getCollectableSolanaTokens(chainId: number): Promise<TokenRecord[]> {
    const rows = await this.select<TokenRecord>('tokens', {
      chain_type: 'solana',
      chain_id: chainId,
      status: 1
    });

    return rows.filter(token => {
      try {
        return BigInt(token.collect_amount || '0') > 0n;
      } catch {
        return false;
      }
    });
  }

  async getActiveUserWallets(chainType: 'evm' | 'solana' = 'evm'): Promise<WalletRecord[]> {
    return this.select<WalletRecord>('wallets', {
      wallet_type: 'user',
      chain_type: chainType,
      is_active: 1
    });
  }

  async getActiveHotWallets(chainType: 'evm' | 'solana' = 'evm'): Promise<WalletRecord[]> {
    return this.select<WalletRecord>('wallets', {
      wallet_type: 'hot',
      chain_type: chainType,
      is_active: 1
    });
  }

  async getWalletNonces(chainId: number): Promise<WalletNonceRecord[]> {
    return this.select<WalletNonceRecord>('wallet_nonces', { chain_id: chainId });
  }

  async getServiceCursor(serviceName: string, cursorName: string): Promise<ServiceCursorRecord | null> {
    const rows = await this.select<ServiceCursorRecord>('service_cursors', {
      service_name: serviceName,
      cursor_name: cursorName
    });
    return rows[0] || null;
  }

  async createServiceCursor(data: ServiceCursorRecord): Promise<void> {
    await this.execute('service_cursors', 'insert', 'write', data);
  }

  async updateServiceCursor(serviceName: string, cursorName: string, data: Partial<ServiceCursorRecord>): Promise<void> {
    await this.execute('service_cursors', 'update', 'write', data, {
      service_name: serviceName,
      cursor_name: cursorName
    });
  }

  async getDepositTransactionsAfterCursor(params: {
    lastBlockNo: number;
    lastRowId: number;
    limit: number;
    statuses: string[];
  }): Promise<TransactionRecord[]> {
    const rows = await this.select<TransactionRecord>('transactions', {
      type: 'deposit',
      status: params.statuses
    });

    // db_gateway 当前只支持简单条件，这里用区块高度 + 行号在服务侧做稳定游标过滤。
    return rows
      .filter(row => row.block_no !== null && row.block_no !== undefined)
      .filter(row => {
        const blockNo = Number(row.block_no);
        return blockNo > params.lastBlockNo || (blockNo === params.lastBlockNo && row.id > params.lastRowId);
      })
      .sort((a, b) => {
        const blockDiff = Number(a.block_no || 0) - Number(b.block_no || 0);
        return blockDiff !== 0 ? blockDiff : a.id - b.id;
      })
      .slice(0, params.limit);
  }

  async getSolanaDepositTransactionsAfterCursor(params: {
    lastSlot: number;
    lastRowId: number;
    limit: number;
    statuses: string[];
  }): Promise<SolanaTransactionRecord[]> {
    const rows = await this.select<SolanaTransactionRecord>('solana_transactions', {
      type: 'deposit',
      status: params.statuses
    });

    // Solana 充值候选按 slot + id 推进，避免同 slot 多笔交易被重复或遗漏。
    return rows
      .filter(row => row.slot !== null && row.slot !== undefined)
      .filter(row => {
        const slot = Number(row.slot);
        return slot > params.lastSlot || (slot === params.lastSlot && row.id > params.lastRowId);
      })
      .sort((a, b) => {
        const slotDiff = Number(a.slot || 0) - Number(b.slot || 0);
        return slotDiff !== 0 ? slotDiff : a.id - b.id;
      })
      .slice(0, params.limit);
  }

  async getInventoryCredits(chainId: number, chainType: 'evm' | 'solana' = 'evm'): Promise<CreditRecord[]> {
    const rows = await this.select<CreditRecord>('credits', {
      chain_id: chainId,
      chain_type: chainType,
      status: 'finalized',
      credit_type: ['deposit', 'collect', 'rebalance', 'network_fee']
    });

    return rows;
  }

  async getSolanaTokenAccount(walletAddress: string, tokenMint: string): Promise<SolanaTokenAccountRecord | null> {
    const rows = await this.select<SolanaTokenAccountRecord>('solana_token_accounts', {
      wallet_address: walletAddress,
      token_mint: tokenMint
    });
    return rows[0] || null;
  }

  async getTasks(filters: {
    status?: string;
    tokenId?: number;
    address?: string;
    id?: number;
  } = {}): Promise<FundTaskRecord[]> {
    // address 可能匹配 from_address 或 to_address，网关不支持 OR 条件，所以这里拉回后过滤。
    const conditions: Record<string, unknown> = {};
    if (filters.status) conditions.status = filters.status;
    if (filters.tokenId !== undefined) conditions.token_id = filters.tokenId;
    if (filters.id !== undefined) conditions.id = filters.id;

    let tasks = await this.select<FundTaskRecord>('fund_tasks', Object.keys(conditions).length > 0 ? conditions : undefined);

    if (filters.address) {
      const normalized = filters.address.toLowerCase();
      tasks = tasks.filter(task =>
        task.from_address.toLowerCase() === normalized ||
        task.to_address.toLowerCase() === normalized
      );
    }

    return tasks.sort((a, b) => b.id - a.id);
  }

  async hasOpenTask(fromAddress: string, tokenId: number, chainId: number): Promise<boolean> {
    // 这里和数据库 partial unique index 双重保护：业务层少发请求，数据库层兜底防重复。
    const openStatuses: FundTaskStatus[] = ['planned', 'gas_funding', 'gas_pending', 'gas_funded', 'signing', 'pending', 'confirmed'];
    const rows = await this.select<FundTaskRecord>('fund_tasks', {
      from_address: fromAddress,
      token_id: tokenId,
      chain_id: chainId
    });

    return rows.some(task => openStatuses.includes(task.status));
  }

  async createTask(data: Omit<FundTaskRecord, 'id'>): Promise<number> {
    const result = await this.execute('fund_tasks', 'insert', 'sensitive', data);
    const lastId = (result as { lastID?: number }).lastID;
    if (lastId === undefined) {
      throw new Error('db gateway did not return fund task id');
    }
    return lastId;
  }

  async updateTask(id: number, data: Partial<FundTaskRecord>): Promise<void> {
    await this.execute('fund_tasks', 'update', 'sensitive', data, { id });
  }

  async insertCredit(data: Record<string, unknown>): Promise<void> {
    await this.execute('credits', 'insert', 'sensitive', data);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async select<T>(table: string, conditions?: Record<string, unknown>): Promise<T[]> {
    const data = await this.execute(table, 'select', 'read', undefined, conditions);
    return (Array.isArray(data) ? data : []) as T[];
  }

  private async execute(
    table: string,
    action: DatabaseAction,
    operationType: OperationType,
    data?: unknown,
    conditions?: unknown
  ): Promise<unknown> {
    // 每次 DB 操作用新的 operation_id，配合 db_gateway 的防重放校验。
    const operationId = uuidv4();
    const timestamp = Date.now();
    let finalData = data;
    let finalConditions = conditions;
    let riskSignature: string | undefined;

    if (operationType === 'sensitive') {
      // fund_tasks 和 credits 都是敏感写操作：先让 risk_control 对同一份 DB 操作签名。
      const riskResult = await this.riskControlClient.requestRiskAssessment({
        operation_id: operationId,
        operation_type: operationType,
        table,
        action,
        data: finalData,
        conditions: finalConditions,
        timestamp,
        context: this.extractContext(table, finalData)
      });

      riskSignature = riskResult.risk_signature;
      if (riskResult.db_operation?.data !== undefined) {
        finalData = riskResult.db_operation.data;
      }
      if (riskResult.db_operation?.conditions !== undefined) {
        finalConditions = riskResult.db_operation.conditions;
      }
    }

    const signaturePayload: SignaturePayload = {
      operation_id: operationId,
      operation_type: operationType,
      table,
      action,
      data: finalData || null,
      conditions: finalConditions || null,
      timestamp
    };

    // 业务签名必须覆盖最终 data/conditions；如果风控改写了数据，也要对改写后的内容签。
    const request = {
      operation_id: operationId,
      operation_type: operationType,
      table,
      action,
      data: finalData,
      conditions: finalConditions,
      business_signature: this.signer.sign(signaturePayload),
      ...(riskSignature && { risk_signature: riskSignature }),
      timestamp
    };

    const response = await fetch(`${this.baseUrl}/api/database/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
    });

    const result = await response.json().catch(() => ({})) as GatewayResponse;
    if (!response.ok || !result.success) {
      throw new Error(`db gateway ${action} ${table} failed: ${response.status} - ${result.error?.message || result.error?.details || 'unknown error'}`);
    }

    return result.data;
  }

  private extractContext(table: string, data: unknown): Record<string, unknown> {
    if (!data || typeof data !== 'object') return {};
    const row = data as Record<string, unknown>;

    if (table === 'credits') {
      // credits 的上下文用于黑名单、金额等风控规则判断。
      return {
        user_id: row.user_id,
        amount: row.amount,
        credit_type: row.credit_type,
        from_address: row.address,
        chain_type: row.chain_type,
        business_type: row.business_type
      };
    }

    if (table === 'fund_tasks') {
      // fund_tasks 上下文让风控能看到归集来源、目标和金额。
      return {
        amount: row.amount,
        credit_type: row.task_type,
        from_address: row.from_address,
        to_address: row.to_address,
        chain_type: row.chain_type
      };
    }

    return {};
  }
}
