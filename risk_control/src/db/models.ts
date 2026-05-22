import { RiskControlDB } from './connection';
import { logger } from '../utils/logger';

/**
 * 风控评估记录
 */
export interface RiskAssessment {
  id?: number;
  operation_id: string;
  table_name?: string;  // 可为空，用于非数据库操作（如提现）
  record_id?: number;
  action: string;
  user_id?: number;

  operation_data: string;
  suggest_operation_data?: string;
  suggest_reason?: string;

  risk_level: 'low' | 'medium' | 'high' | 'critical';
  decision: 'auto_approve' | 'manual_review' | 'deny';
  approval_status?: 'pending' | 'approved' | 'rejected';
  reasons?: string;

  risk_signature?: string;
  expires_at?: string;

  created_at?: string;
  updated_at?: string;
}

/**
 * 人工审批记录
 */
export interface RiskManualReview {
  id?: number;
  assessment_id: number;
  operation_id: string;

  approver_user_id: number;
  approver_username?: string;
  approved: 0 | 1;

  modified_data?: string;
  comment?: string;
  ip_address?: string;
  user_agent?: string;

  created_at?: string;
}

/**
 * 地址风险记录
 */
export interface AddressRisk {
  id?: number;
  address: string;
  chain_type: 'evm' | 'btc' | 'solana';

  risk_type: 'blacklist' | 'whitelist' | 'suspicious' | 'sanctioned';
  risk_level: 'low' | 'medium' | 'high';
  reason?: string;
  source: 'manual' | 'auto' | 'chainalysis' | 'ofac';

  enabled: 0 | 1;

  created_at?: string;
  updated_at?: string;
}

/**
 * 提现风控规则
 */
export interface WithdrawRiskRule {
  id?: number;
  name: string;

  chain_type?: 'evm' | 'btc' | 'solana' | null;
  chain_id?: number | null;
  token_symbol?: string | null;
  token_id?: number | null;

  single_withdraw_limit: string;
  daily_withdraw_limit: string;
  frequency_window_seconds: number;
  frequency_max_count: number;
  limit_action: 'manual_review' | 'reject';

  enabled: 0 | 1;
  priority: number;

  created_at?: string;
  updated_at?: string;
}

/**
 * 风控评估模型
 */
export class RiskAssessmentModel {
  constructor(private db: RiskControlDB) {}

  /**
   * 创建风控评估记录
   */
  async create(data: Omit<RiskAssessment, 'id' | 'created_at' | 'updated_at'>): Promise<number> {
    const sql = `
      INSERT INTO risk_assessments (
        operation_id, table_name, record_id, action, user_id,
        operation_data, suggest_operation_data, suggest_reason,
        risk_level, decision, approval_status, reasons,
        risk_signature, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
      data.operation_id,
      data.table_name ?? null,  // 允许为 null
      data.record_id ?? null,
      data.action,
      data.user_id ?? null,
      data.operation_data,
      data.suggest_operation_data ?? null,
      data.suggest_reason ?? null,
      data.risk_level,
      data.decision,
      data.approval_status ?? null,
      data.reasons ?? null,
      data.risk_signature ?? null,
      data.expires_at ?? null
    ];

    const id = await this.db.insert(sql, params);
    logger.info('Risk assessment created', { id, operation_id: data.operation_id });
    return id;
  }

  /**
   * 根据 operation_id 查找评估记录
   */
  async findByOperationId(operationId: string): Promise<RiskAssessment | null> {
    const sql = 'SELECT * FROM risk_assessments WHERE operation_id = ?';
    return await this.db.queryOne<RiskAssessment>(sql, [operationId]);
  }

  /**
   * 根据 ID 查找评估记录
   */
  async findById(id: number): Promise<RiskAssessment | null> {
    const sql = 'SELECT * FROM risk_assessments WHERE id = ?';
    return await this.db.queryOne<RiskAssessment>(sql, [id]);
  }

  /**
   * 查询待人工审核的记录
   */
  async findPendingReviews(limit: number = 50): Promise<RiskAssessment[]> {
    const sql = `
      SELECT * FROM risk_assessments
      WHERE decision = 'manual_review'
      AND approval_status = 'pending'
      ORDER BY created_at DESC
      LIMIT ?
    `;
    return await this.db.query<RiskAssessment>(sql, [limit]);
  }

  /**
   * 查询已批准的记录（用于通知业务层）
   */
  async findApproved(limit: number = 100): Promise<RiskAssessment[]> {
    const sql = `
      SELECT * FROM risk_assessments
      WHERE approval_status = 'approved'
      ORDER BY created_at ASC
      LIMIT ?
    `;
    return await this.db.query<RiskAssessment>(sql, [limit]);
  }

  /**
   * 查询近期提现风控记录，用于单日限额和频率限制。
   * operation_data 可能来自不同提现入口，链和币种字段在服务层做兼容解析。
   */
  async findRecentWithdrawals(params: {
    userId?: number;
    chainType?: string;
    chainId?: number;
    tokenSymbol?: string;
    tokenId?: number;
    sinceIso: string;
    excludeOperationId?: string;
  }): Promise<RiskAssessment[]> {
    let sql = `
      SELECT *
      FROM risk_assessments
      WHERE (
          action = 'withdraw'
          OR (table_name = 'withdraws' AND action = 'insert')
        )
        AND created_at >= ?
    `;
    const values: any[] = [params.sinceIso];

    if (params.excludeOperationId) {
      sql += ' AND operation_id != ?';
      values.push(params.excludeOperationId);
    }

    if (params.userId !== undefined) {
      sql += ' AND (user_id = ? OR json_extract(operation_data, "$.user_id") = ? OR json_extract(operation_data, "$.userId") = ?)';
      values.push(params.userId, params.userId, params.userId);
    }

    if (params.chainType) {
      sql += ' AND (json_extract(operation_data, "$.chainType") IS NULL OR json_extract(operation_data, "$.chainType") = ? OR json_extract(operation_data, "$.chain_type") = ?)';
      values.push(params.chainType, params.chainType);
    }

    if (params.chainId !== undefined) {
      sql += ' AND (json_extract(operation_data, "$.chainId") IS NULL OR json_extract(operation_data, "$.chainId") = ? OR json_extract(operation_data, "$.chain_id") = ?)';
      values.push(params.chainId, params.chainId);
    }

    if (params.tokenSymbol) {
      sql += ' AND (json_extract(operation_data, "$.tokenSymbol") IS NULL OR UPPER(json_extract(operation_data, "$.tokenSymbol")) = UPPER(?))';
      values.push(params.tokenSymbol);
    }

    if (params.tokenId !== undefined) {
      sql += ' AND (json_extract(operation_data, "$.tokenId") IS NULL OR json_extract(operation_data, "$.tokenId") = ? OR json_extract(operation_data, "$.token_id") = ?)';
      values.push(params.tokenId, params.tokenId);
    }

    sql += ' ORDER BY created_at DESC';

    return await this.db.query<RiskAssessment>(sql, values);
  }

  /**
   * 更新审批状态
   */
  async updateApprovalStatus(
    operationId: string,
    status: 'approved' | 'rejected'
  ): Promise<number> {
    const sql = `
      UPDATE risk_assessments
      SET approval_status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE operation_id = ?
    `;
    return await this.db.run(sql, [status, operationId]);
  }

  /**
   * 更新 record_id (业务记录创建后关联)
   */
  async updateRecordId(operationId: string, recordId: number): Promise<number> {
    const sql = `
      UPDATE risk_assessments
      SET record_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE operation_id = ?
    `;
    return await this.db.run(sql, [recordId, operationId]);
  }

  /**
   * 通用更新方法
   */
  async update(id: number, data: Partial<Omit<RiskAssessment, 'id' | 'created_at' | 'updated_at'>>): Promise<number> {
    const fields: string[] = [];
    const values: any[] = [];

    // 动态构建 SET 子句
    if (data.operation_data !== undefined) {
      fields.push('operation_data = ?');
      values.push(data.operation_data);
    }
    if (data.risk_signature !== undefined) {
      fields.push('risk_signature = ?');
      values.push(data.risk_signature);
    }
    if (data.expires_at !== undefined) {
      fields.push('expires_at = ?');
      values.push(data.expires_at);
    }
    if (data.approval_status !== undefined) {
      fields.push('approval_status = ?');
      values.push(data.approval_status);
    }
    if (data.decision !== undefined) {
      fields.push('decision = ?');
      values.push(data.decision);
    }
    if (data.risk_level !== undefined) {
      fields.push('risk_level = ?');
      values.push(data.risk_level);
    }
    if (data.reasons !== undefined) {
      fields.push('reasons = ?');
      values.push(data.reasons);
    }
    if (data.user_id !== undefined) {
      fields.push('user_id = ?');
      values.push(data.user_id);
    }

    if (fields.length === 0) {
      return 0; // 没有字段需要更新
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    const sql = `
      UPDATE risk_assessments
      SET ${fields.join(', ')}
      WHERE id = ?
    `;

    return await this.db.run(sql, values);
  }
}

/**
 * 人工审批模型
 */
export class RiskManualReviewModel {
  constructor(private db: RiskControlDB) {}

  /**
   * 创建审批记录
   */
  async create(data: Omit<RiskManualReview, 'id' | 'created_at'>): Promise<number> {
    const sql = `
      INSERT INTO risk_manual_reviews (
        assessment_id, operation_id, approver_user_id, approver_username,
        approved, modified_data, comment, ip_address, user_agent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
      data.assessment_id,
      data.operation_id,
      data.approver_user_id,
      data.approver_username ?? null,
      data.approved,
      data.modified_data ?? null,
      data.comment ?? null,
      data.ip_address ?? null,
      data.user_agent ?? null
    ];

    const id = await this.db.insert(sql, params);
    logger.info('Manual review created', { id, operation_id: data.operation_id });
    return id;
  }

  /**
   * 根据 operation_id 查找审批记录
   */
  async findByOperationId(operationId: string): Promise<RiskManualReview[]> {
    const sql = `
      SELECT * FROM risk_manual_reviews
      WHERE operation_id = ?
      ORDER BY created_at DESC
    `;
    return await this.db.query<RiskManualReview>(sql, [operationId]);
  }

  /**
   * 根据 assessment_id 查找审批记录
   */
  async findByAssessmentId(assessmentId: number): Promise<RiskManualReview[]> {
    const sql = `
      SELECT * FROM risk_manual_reviews
      WHERE assessment_id = ?
      ORDER BY created_at DESC
    `;
    return await this.db.query<RiskManualReview>(sql, [assessmentId]);
  }
}

/**
 * 地址风险模型
 */
export class AddressRiskModel {
  constructor(private db: RiskControlDB) {}

  /**
   * 添加风险地址
   */
  async create(data: Omit<AddressRisk, 'id' | 'created_at' | 'updated_at'>): Promise<number> {
    const sql = `
      INSERT INTO address_risk_list (
        address, chain_type, risk_type, risk_level, reason, source, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

    const params = [
      data.address,
      data.chain_type,
      data.risk_type,
      data.risk_level,
      data.reason ?? null,
      data.source,
      data.enabled
    ];

    const id = await this.db.insert(sql, params);
    logger.info('Address risk added', { id, address: data.address });
    return id;
  }

  /**
   * 检查地址是否在风险列表中
   */
  async checkAddress(address: string, chainType: string): Promise<AddressRisk | null> {
    const sql = `
      SELECT * FROM address_risk_list
      WHERE LOWER(address) = LOWER(?)
      AND chain_type = ?
      AND enabled = 1
    `;
    return await this.db.queryOne<AddressRisk>(sql, [address, chainType]);
  }

  /**
   * 根据风险类型查询地址
   */
  async findByRiskType(riskType: string, chainType?: string): Promise<AddressRisk[]> {
    let sql = `
      SELECT * FROM address_risk_list
      WHERE risk_type = ? AND enabled = 1
    `;
    const params: any[] = [riskType];

    if (chainType) {
      sql += ' AND chain_type = ?';
      params.push(chainType);
    }

    sql += ' ORDER BY created_at DESC';

    return await this.db.query<AddressRisk>(sql, params);
  }

  async findAll(params?: {
    chainType?: string;
    riskType?: string;
    enabled?: 0 | 1;
    limit?: number;
  }): Promise<AddressRisk[]> {
    let sql = 'SELECT * FROM address_risk_list WHERE 1 = 1';
    const values: any[] = [];

    if (params?.chainType) {
      sql += ' AND chain_type = ?';
      values.push(params.chainType);
    }

    if (params?.riskType) {
      sql += ' AND risk_type = ?';
      values.push(params.riskType);
    }

    if (params?.enabled !== undefined) {
      sql += ' AND enabled = ?';
      values.push(params.enabled);
    }

    sql += ' ORDER BY enabled DESC, updated_at DESC, id DESC LIMIT ?';
    values.push(params?.limit ?? 100);

    return await this.db.query<AddressRisk>(sql, values);
  }

  /**
   * 启用/禁用地址风险
   */
  async toggleEnabled(id: number, enabled: 0 | 1): Promise<number> {
    const sql = `
      UPDATE address_risk_list
      SET enabled = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `;
    return await this.db.run(sql, [enabled, id]);
  }

  /**
   * 删除地址风险
   */
  async delete(id: number): Promise<number> {
    const sql = 'DELETE FROM address_risk_list WHERE id = ?';
    return await this.db.run(sql, [id]);
  }
}

/**
 * 提现风控规则模型
 */
export class WithdrawRiskRuleModel {
  constructor(private db: RiskControlDB) {}

  async findAll(): Promise<WithdrawRiskRule[]> {
    const sql = `
      SELECT *
      FROM withdraw_risk_rules
      ORDER BY enabled DESC, priority ASC, id ASC
    `;
    return await this.db.query<WithdrawRiskRule>(sql);
  }

  /**
   * 查找最匹配的提现规则。
   * 匹配策略：显式 chain/token 条件优先，priority 数值越小优先级越高。
   */
  async findBestMatch(params: {
    chainType?: string;
    chainId?: number;
    tokenSymbol?: string;
    tokenId?: number;
  }): Promise<WithdrawRiskRule | null> {
    const sql = `
      SELECT *
      FROM withdraw_risk_rules
      WHERE enabled = 1
        AND (chain_type IS NULL OR chain_type = ?)
        AND (chain_id IS NULL OR chain_id = ?)
        AND (token_symbol IS NULL OR UPPER(token_symbol) = UPPER(?))
        AND (token_id IS NULL OR token_id = ?)
      ORDER BY
        priority ASC,
        CASE WHEN chain_type IS NULL THEN 1 ELSE 0 END ASC,
        CASE WHEN chain_id IS NULL THEN 1 ELSE 0 END ASC,
        CASE WHEN token_id IS NULL THEN 1 ELSE 0 END ASC,
        CASE WHEN token_symbol IS NULL THEN 1 ELSE 0 END ASC,
        id ASC
      LIMIT 1
    `;

    return await this.db.queryOne<WithdrawRiskRule>(sql, [
      params.chainType ?? null,
      params.chainId ?? null,
      params.tokenSymbol ?? null,
      params.tokenId ?? null
    ]);
  }

  async update(id: number, data: Partial<Omit<WithdrawRiskRule, 'id' | 'created_at' | 'updated_at'>>): Promise<number> {
    const fields: string[] = [];
    const values: any[] = [];

    const add = (field: string, value: unknown) => {
      fields.push(`${field} = ?`);
      values.push(value);
    };

    if (data.name !== undefined) add('name', data.name);
    if (data.chain_type !== undefined) add('chain_type', data.chain_type);
    if (data.chain_id !== undefined) add('chain_id', data.chain_id);
    if (data.token_symbol !== undefined) add('token_symbol', data.token_symbol);
    if (data.token_id !== undefined) add('token_id', data.token_id);
    if (data.single_withdraw_limit !== undefined) add('single_withdraw_limit', data.single_withdraw_limit);
    if (data.daily_withdraw_limit !== undefined) add('daily_withdraw_limit', data.daily_withdraw_limit);
    if (data.frequency_window_seconds !== undefined) add('frequency_window_seconds', data.frequency_window_seconds);
    if (data.frequency_max_count !== undefined) add('frequency_max_count', data.frequency_max_count);
    if (data.limit_action !== undefined) add('limit_action', data.limit_action);
    if (data.enabled !== undefined) add('enabled', data.enabled);
    if (data.priority !== undefined) add('priority', data.priority);

    if (fields.length === 0) {
      return 0;
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    return await this.db.run(
      `UPDATE withdraw_risk_rules SET ${fields.join(', ')} WHERE id = ?`,
      values
    );
  }
}
