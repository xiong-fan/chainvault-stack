import { DatabaseConnection } from '../connection';

// 交易接口定义
export interface Transaction {
  id?: number;
  block_hash?: string;
  block_no?: number;
  tx_hash: string;
  from_addr: string;
  to_addr: string;
  token_addr?: string;
  amount: string;
  type: 'deposit' | 'withdraw' | 'collect' | 'rebalance';
  status: 'pending' | 'confirmed' | 'failed';
  created_at?: string;
}

// 创建交易请求接口
export interface CreateTransactionRequest {
  block_hash?: string;
  block_no?: number;
  tx_hash: string;
  from_addr: string;
  to_addr: string;
  token_addr?: string;
  amount: string;
  type: 'deposit' | 'withdraw' | 'collect' | 'rebalance';
  status?: 'pending' | 'confirmed' | 'failed';
}

// 交易更新接口
export interface UpdateTransactionRequest {
  status?: 'pending' | 'confirmed' | 'failed';
  amount?: string;
}

// 交易查询选项
export interface TransactionQueryOptions {
  from_addr?: string;
  to_addr?: string;
  token_addr?: string;
  type?: 'deposit' | 'withdraw' | 'collect' | 'rebalance';
  status?: 'pending' | 'confirmed' | 'failed';
  limit?: number | undefined;
  offset?: number | undefined;
  orderBy?: 'created_at' | 'amount' | 'type' | 'block_no';
  orderDirection?: 'ASC' | 'DESC';
}

// 交易数据模型类
export class TransactionModel {
  private db: DatabaseConnection;

  constructor(database: DatabaseConnection) {
    this.db = database;
  }

  // 根据ID查找交易
  async findById(id: number): Promise<Transaction | null> {
    const transaction = await this.db.queryOne<Transaction>(
      'SELECT * FROM transactions WHERE id = ?',
      [id]
    );
    return transaction || null;
  }

  // 根据交易哈希查找交易
  async findByHash(tx_hash: string): Promise<Transaction | null> {
    const transaction = await this.db.queryOne<Transaction>(
      'SELECT * FROM transactions WHERE tx_hash = ?',
      [tx_hash]
    );
    return transaction || null;
  }

  // 根据地址获取交易记录
  async findByAddress(address: string, options?: TransactionQueryOptions): Promise<Transaction[]> {
    let sql = 'SELECT * FROM transactions WHERE from_addr = ? OR to_addr = ?';
    const params: any[] = [address, address];

    // 添加过滤条件
    if (options?.type) {
      sql += ' AND type = ?';
      params.push(options.type);
    }

    if (options?.status) {
      sql += ' AND status = ?';
      params.push(options.status);
    }

    // 添加排序
    const orderBy = options?.orderBy || 'created_at';
    const orderDirection = options?.orderDirection || 'DESC';
    sql += ` ORDER BY ${orderBy} ${orderDirection}`;

    // 添加分页
    if (options?.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
      
      if (options?.offset) {
        sql += ' OFFSET ?';
        params.push(options.offset);
      }
    }

    return await this.db.query<Transaction>(sql, params);
  }

  // 获取用户充值中的余额：EVM 走 transactions 确认数，Solana 走 solana_transactions/solana_slots 槽位状态。
  async getUserPendingDepositBalances(user_id: number): Promise<{
    chain_id: number | null;
    chain_type: string | null;
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
  }[]> {
    const sql = `
      SELECT
        COALESCE(c.chain_id, tk.chain_id) as chain_id,
        COALESCE(c.chain_type, tk.chain_type) as chain_type,
        c.token_id,
        c.token_symbol,
        c.amount,
        c.status as credit_status,
        c.block_number,
        c.tx_hash,
        c.address,
        c.created_at,
        c.updated_at,
        COALESCE(t.confirmation_count, 0) as evm_confirmation_count,
        COALESCE(t.status, c.status) as evm_transaction_status,
        st.status as solana_transaction_status,
        ss.status as solana_slot_status,
        COALESCE(tk.decimals, 18) as decimals
      FROM credits c
      LEFT JOIN tokens tk ON c.token_id = tk.id
      LEFT JOIN transactions t
        ON COALESCE(c.chain_type, tk.chain_type) = 'evm'
       AND LOWER(c.tx_hash) = LOWER(t.tx_hash)
      LEFT JOIN solana_transactions st
        ON COALESCE(c.chain_type, tk.chain_type) = 'solana'
       AND c.tx_hash = st.tx_hash
       AND st.type = 'deposit'
      LEFT JOIN solana_slots ss
        ON COALESCE(c.chain_type, tk.chain_type) = 'solana'
       AND c.block_number = ss.slot
      WHERE c.user_id = ?
        AND c.credit_type = 'deposit'
        AND c.status IN ('confirmed', 'safe')
        AND CAST(c.amount AS REAL) > 0
      ORDER BY c.block_number DESC, c.created_at DESC, c.id DESC
    `;
    
    const rows = await this.db.query<{
      chain_id: number | null;
      chain_type: string | null;
      token_id: number;
      token_symbol: string;
      amount: string;
      credit_status: 'confirmed' | 'safe';
      block_number: number | null;
      tx_hash: string;
      address: string;
      created_at: string | null;
      updated_at: string | null;
      evm_confirmation_count: number;
      evm_transaction_status: 'confirmed' | 'safe';
      solana_transaction_status: 'confirmed' | 'finalized' | null;
      solana_slot_status: 'confirmed' | 'finalized' | 'skipped' | null;
      decimals: number;
    }>(sql, [user_id]);

    const requiredConfirmations = Number.parseInt(process.env.CONFIRMATION_BLOCKS || '32', 10);
    const grouped = new Map<string, {
      chain_id: number | null;
      chain_type: string | null;
      token_id: number;
      token_symbol: string;
      decimals: number;
      raw_amount: bigint;
      transaction_count: number;
      scanned_count: number;
      confirming_count: number;
      safe_count: number;
      latest_confirmation_count: number;
      latest_status: 'confirmed' | 'safe';
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
    }>();

    for (const row of rows) {
      const key = `${row.chain_type || 'unknown'}:${row.chain_id ?? 'unknown'}:${row.token_id}`;
      const isSolana = row.chain_type === 'solana';
      const status = row.evm_transaction_status === 'safe' || row.credit_status === 'safe' ? 'safe' : 'confirmed';
      const confirmationCount = isSolana
        ? this.getSolanaPendingConfirmationCount(row.solana_slot_status, row.solana_transaction_status)
        : Number(row.evm_confirmation_count || 0);
      const requiredConfirmations = isSolana ? 1 : Number.parseInt(process.env.CONFIRMATION_BLOCKS || '32', 10);
      const progressLabel = isSolana
        ? this.getSolanaPendingProgressLabel(row.solana_slot_status, row.solana_transaction_status)
        : (status === 'safe' ? '确认中' : '已扫描');
      const existing = grouped.get(key) || {
        chain_id: row.chain_id,
        chain_type: row.chain_type,
        token_id: row.token_id,
        token_symbol: row.token_symbol,
        decimals: row.decimals,
        raw_amount: 0n,
        transaction_count: 0,
        scanned_count: 0,
        confirming_count: 0,
        safe_count: 0,
        latest_confirmation_count: 0,
        latest_status: status,
        deposits: []
      };

      existing.raw_amount += BigInt(row.amount);
      existing.transaction_count += 1;
      existing.scanned_count += status === 'confirmed' ? 1 : 0;
      existing.confirming_count += progressLabel === '确认中' ? 1 : 0;
      existing.safe_count += status === 'safe' ? 1 : 0;
      if (confirmationCount >= existing.latest_confirmation_count) {
        existing.latest_confirmation_count = confirmationCount;
        existing.latest_status = status;
      }

      existing.deposits.push({
        tx_hash: row.tx_hash,
        amount: this.formatMinimalUnitAmount(BigInt(row.amount), row.decimals),
        status,
        confirmation_count: confirmationCount,
        required_confirmations: Number.isFinite(requiredConfirmations) ? requiredConfirmations : null,
        progress_label: progressLabel,
        block_number: row.block_number,
        address: row.address,
        created_at: row.created_at,
        updated_at: row.updated_at
      });

      grouped.set(key, existing);
    }

    return Array.from(grouped.values()).map(row => ({
      chain_id: row.chain_id,
      chain_type: row.chain_type,
      token_id: row.token_id,
      token_symbol: row.token_symbol,
      pending_amount: this.formatMinimalUnitAmount(row.raw_amount, row.decimals),
      transaction_count: row.transaction_count,
      scanned_count: row.scanned_count,
      confirming_count: row.confirming_count,
      safe_count: row.safe_count,
      latest_status: row.latest_status,
      latest_confirmation_count: row.latest_confirmation_count,
      required_confirmations: row.chain_type === 'solana'
        ? 1
        : (Number.isFinite(Number.parseInt(process.env.CONFIRMATION_BLOCKS || '32', 10))
            ? Number.parseInt(process.env.CONFIRMATION_BLOCKS || '32', 10)
            : null),
      deposits: row.deposits
    }));
  }

  private getSolanaPendingConfirmationCount(
    slotStatus?: 'confirmed' | 'finalized' | 'skipped' | null,
    transactionStatus?: 'confirmed' | 'finalized' | null
  ): number {
    return slotStatus === 'finalized' || transactionStatus === 'finalized' ? 1 : 0;
  }

  private getSolanaPendingProgressLabel(
    slotStatus?: 'confirmed' | 'finalized' | 'skipped' | null,
    transactionStatus?: 'confirmed' | 'finalized' | null
  ): string {
    if (slotStatus === 'finalized' || transactionStatus === 'finalized') {
      return '等待入账';
    }
    if (slotStatus === 'confirmed' || transactionStatus === 'confirmed') {
      return '确认中';
    }
    return '已扫描';
  }

  private formatMinimalUnitAmount(amount: bigint, decimals: number): string {
    const negative = amount < 0n;
    const absAmount = negative ? -amount : amount;
    const scale = 10n ** BigInt(decimals);
    const whole = absAmount / scale;
    const fraction = absAmount % scale;
    const fractionText = fraction.toString().padStart(decimals, '0').slice(0, 6).padEnd(6, '0');
    return `${negative ? '-' : ''}${whole.toString()}.${fractionText}`;
  }

  // 获取所有交易
  async findAll(options?: TransactionQueryOptions): Promise<Transaction[]> {
    let sql = 'SELECT * FROM transactions WHERE 1=1';
    const params: any[] = [];

    // 添加过滤条件
    if (options?.from_addr) {
      sql += ' AND from_addr = ?';
      params.push(options.from_addr);
    }

    if (options?.to_addr) {
      sql += ' AND to_addr = ?';
      params.push(options.to_addr);
    }

    if (options?.token_addr) {
      sql += ' AND token_addr = ?';
      params.push(options.token_addr);
    }

    if (options?.type) {
      sql += ' AND type = ?';
      params.push(options.type);
    }

    if (options?.status) {
      sql += ' AND status = ?';
      params.push(options.status);
    }

    // 添加排序
    const orderBy = options?.orderBy || 'created_at';
    const orderDirection = options?.orderDirection || 'DESC';
    sql += ` ORDER BY ${orderBy} ${orderDirection}`;

    // 添加分页
    if (options?.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
      
      if (options?.offset) {
        sql += ' OFFSET ?';
        params.push(options.offset);
      }
    }

    return await this.db.query<Transaction>(sql, params);
  }

  // 检查交易是否存在
  async exists(id: number): Promise<boolean> {
    const result = await this.db.queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM transactions WHERE id = ?',
      [id]
    );
    
    return (result?.count || 0) > 0;
  }

  // 检查交易哈希是否已存在
  async hashExists(tx_hash: string): Promise<boolean> {
    const result = await this.db.queryOne<{ count: number }>(
      'SELECT COUNT(*) as count FROM transactions WHERE tx_hash = ?',
      [tx_hash]
    );
    
    return (result?.count || 0) > 0;
  }

}
