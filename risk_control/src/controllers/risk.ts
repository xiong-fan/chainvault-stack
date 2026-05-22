import { Request, Response } from 'express';
import { RiskAssessmentService } from '../services/risk-assessment';
import { ManualReviewService } from '../services/manual-review';
import { RiskAssessmentRequest } from '../types';
import { logger } from '../utils/logger';
import { riskControlDB } from '../db/connection';
import { RiskAssessmentModel, AddressRiskModel, WithdrawRiskRuleModel } from '../db/models';
import { WithdrawalRiskRuleService } from '../services/withdraw-risk-rules';

export class RiskController {
  private manualReviewService: ManualReviewService;
  private riskAssessmentModel: RiskAssessmentModel;
  private addressRiskModel: AddressRiskModel;
  private withdrawRiskRuleModel: WithdrawRiskRuleModel;
  private withdrawalRiskRuleService: WithdrawalRiskRuleService;

  constructor(private riskService: RiskAssessmentService) {
    this.manualReviewService = new ManualReviewService(riskService);
    this.riskAssessmentModel = new RiskAssessmentModel(riskControlDB);
    this.addressRiskModel = new AddressRiskModel(riskControlDB);
    this.withdrawRiskRuleModel = new WithdrawRiskRuleModel(riskControlDB);
    this.withdrawalRiskRuleService = new WithdrawalRiskRuleService();
  }

  /**
   * 评估操作风险
   */
  assessRisk = async (req: Request, res: Response) => {
    try {
      const request = req.body as RiskAssessmentRequest;

      if (!request.operation_id || !request.operation_type || !request.table || !request.action || !request.timestamp) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'Missing required fields',
            details: 'operation_id, operation_type, table, action, and timestamp are required'
          }
        });
      }

      // 执行风控评估
      const assessment = await this.riskService.assessRisk(request);

      // 根据决策返回不同的状态码
      if (assessment.decision === 'reject') {
        return res.status(403).json(assessment);
      }

      if (assessment.decision === 'manual_review') {
        return res.status(202).json(assessment);
      }

      // approve 或 freeze 都返回 200
      return res.status(200).json(assessment);

    } catch (error) {
      logger.error('Risk assessment endpoint error', {
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack,
          name: error.name
        } : String(error),
        body: req.body
      });
      return res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error',
          details: error instanceof Error ? error.message : 'Unknown error'
        }
      });
    }
  };

  /**
   * 提交人工审核结果
   */
  submitManualReview = async (req: Request, res: Response) => {
    try {
      const { operation_id, approver_user_id, approver_username, approved, modified_data, comment } = req.body;

      if (!operation_id || approver_user_id === undefined || approved === undefined) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'Missing required fields',
            details: 'operation_id, approver_user_id, and approved are required'
          }
        });
      }

      const result = await this.manualReviewService.submitReview({
        operation_id,
        approver_user_id,
        approver_username,
        approved,
        modified_data,
        comment,
        ip_address: req.ip,
        user_agent: req.get('User-Agent')
      });

      if (!result.success) {
        return res.status(400).json(result);
      }

      return res.status(200).json(result);

    } catch (error) {
      logger.error('Submit manual review endpoint error', {
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack,
          name: error.name
        } : String(error),
        body: req.body
      });
      return res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error',
          details: error instanceof Error ? error.message : 'Unknown error'
        }
      });
    }
  };

  /**
   * 获取待审核列表
   */
  getPendingReviews = async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const result = await this.manualReviewService.getPendingReviews(limit);

      return res.status(200).json(result);

    } catch (error) {
      logger.error('Get pending reviews endpoint error', {
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack,
          name: error.name
        } : String(error)
      });
      return res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error',
          details: error instanceof Error ? error.message : 'Unknown error'
        }
      });
    }
  };

  /**
   * 获取审核历史
   */
  getReviewHistory = async (req: Request, res: Response) => {
    try {
      const { operation_id } = req.params;

      if (!operation_id) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'Missing operation_id parameter'
          }
        });
      }

      const result = await this.manualReviewService.getReviewHistory(operation_id);

      return res.status(200).json(result);

    } catch (error) {
      logger.error('Get review history endpoint error', {
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack,
          name: error.name
        } : String(error)
      });
      return res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error',
          details: error instanceof Error ? error.message : 'Unknown error'
        }
      });
    }
  };

  getWithdrawRiskRules = async (_req: Request, res: Response) => {
    try {
      const rules = await this.withdrawRiskRuleModel.findAll();
      return res.status(200).json({ success: true, data: rules });
    } catch (error) {
      logger.error('Get withdraw risk rules endpoint error', { error });
      return res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error',
          details: error instanceof Error ? error.message : 'Unknown error'
        }
      });
    }
  };

  updateWithdrawRiskRule = async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_REQUEST', message: 'Invalid rule id' }
        });
      }

      const allowedFields = [
        'name',
        'chain_type',
        'chain_id',
        'token_symbol',
        'token_id',
        'single_withdraw_limit',
        'daily_withdraw_limit',
        'frequency_window_seconds',
        'frequency_max_count',
        'limit_action',
        'enabled',
        'priority'
      ];
      const data: Record<string, unknown> = {};
      for (const field of allowedFields) {
        if (Object.prototype.hasOwnProperty.call(req.body, field)) {
          data[field] = req.body[field];
        }
      }

      if (data.single_withdraw_limit !== undefined) data.single_withdraw_limit = String(data.single_withdraw_limit);
      if (data.daily_withdraw_limit !== undefined) data.daily_withdraw_limit = String(data.daily_withdraw_limit);
      if (data.frequency_window_seconds !== undefined) data.frequency_window_seconds = Number(data.frequency_window_seconds);
      if (data.frequency_max_count !== undefined) data.frequency_max_count = Number(data.frequency_max_count);
      if (data.enabled !== undefined) data.enabled = Number(data.enabled) ? 1 : 0;
      if (data.priority !== undefined) data.priority = Number(data.priority);
      if (data.limit_action !== undefined && !['manual_review', 'reject'].includes(String(data.limit_action))) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_REQUEST', message: 'limit_action must be manual_review or reject' }
        });
      }

      await this.withdrawRiskRuleModel.update(id, data as any);
      const rules = await this.withdrawRiskRuleModel.findAll();
      return res.status(200).json({ success: true, data: rules.find(rule => rule.id === id) || null });
    } catch (error) {
      logger.error('Update withdraw risk rule endpoint error', { error, body: req.body });
      return res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error',
          details: error instanceof Error ? error.message : 'Unknown error'
        }
      });
    }
  };

  getAddressRisks = async (req: Request, res: Response) => {
    try {
      const enabled = req.query.enabled === undefined ? undefined : (req.query.enabled === '1' ? 1 : 0);
      const addresses = await this.addressRiskModel.findAll({
        chainType: req.query.chain_type as string | undefined,
        riskType: req.query.risk_type as string | undefined,
        enabled,
        limit: req.query.limit ? Number(req.query.limit) : 100
      });
      return res.status(200).json({ success: true, data: addresses });
    } catch (error) {
      logger.error('Get address risks endpoint error', { error });
      return res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error',
          details: error instanceof Error ? error.message : 'Unknown error'
        }
      });
    }
  };

  createAddressRisk = async (req: Request, res: Response) => {
    try {
      const { address, chain_type, risk_type, risk_level, reason, source, enabled } = req.body;
      if (!address || !chain_type || !risk_type) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_REQUEST', message: 'address, chain_type and risk_type are required' }
        });
      }

      const id = await this.addressRiskModel.create({
        address,
        chain_type,
        risk_type,
        risk_level: risk_level || 'medium',
        reason,
        source: source || 'manual',
        enabled: enabled === undefined ? 1 : Number(enabled) ? 1 : 0
      });

      return res.status(201).json({ success: true, data: { id } });
    } catch (error) {
      logger.error('Create address risk endpoint error', { error, body: req.body });
      return res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error',
          details: error instanceof Error ? error.message : 'Unknown error'
        }
      });
    }
  };

  updateAddressRiskEnabled = async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      const enabled = Number(req.body.enabled) ? 1 : 0;
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_REQUEST', message: 'Invalid address risk id' }
        });
      }

      await this.addressRiskModel.toggleEnabled(id, enabled);
      return res.status(200).json({ success: true, data: { id, enabled } });
    } catch (error) {
      logger.error('Update address risk enabled endpoint error', { error, body: req.body });
      return res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error',
          details: error instanceof Error ? error.message : 'Unknown error'
        }
      });
    }
  };

  /**
   * 对提现进行风险评估并签名
   */
  withdrawRiskAssessment = async (req: Request, res: Response) => {
    try {
      logger.info('📥 Risk: 收到提现风控评估请求', {
        body: req.body,
        operation_id: req.body?.operation_id
      });

      const { operation_id, transaction, timestamp } = req.body;

      // 验证必需参数
      if (!operation_id || !transaction || !timestamp) {
        logger.warn('❌ Risk: 缺少必需参数', {
          has_operation_id: !!operation_id,
          has_transaction: !!transaction,
          has_timestamp: !!timestamp
        });
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'Missing required fields',
            details: 'operation_id, transaction, and timestamp are required'
          }
        });
      }

      logger.info('📋 Risk: 解析交易参数', {
        operation_id,
        transaction: JSON.stringify(transaction, null, 2),
        timestamp
      });

      const {
        from,
        to,
        amount,
        userId,
        tokenId,
        tokenSymbol,
        tokenAddress,
        tokenType,
        chainId,
        chainType,
        nonce,
        blockhash,
        lastValidBlockHeight,
        fee,
        businessType
      } = transaction;
      const normalizedBusinessType = businessType === 'collect' ? 'collect' : 'withdraw';

      logger.info('📋 Risk: 提取的交易字段', {
        from,
        to,
        amount,
        userId: userId || null,
        tokenId: tokenId || null,
        tokenSymbol: tokenSymbol || null,
        tokenAddress: tokenAddress || null,
        tokenType: tokenType || null,
        chainId,
        chainType,
        nonce,
        blockhash: blockhash || null,
        lastValidBlockHeight: lastValidBlockHeight || null,
        fee: fee || null,
        businessType: normalizedBusinessType
      });

      if (!from || !to || !amount || chainId === undefined || nonce === undefined) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'Missing transaction fields',
            details: 'from, to, amount, chainId, and nonce are required'
          }
        });
      }

      const normalizedChainType: 'evm' | 'btc' | 'solana' =
        chainType === 'solana' ? 'solana' : chainType === 'btc' ? 'btc' : 'evm';

      logger.info('🔍 Risk: 规范化链类型', {
        original: chainType,
        normalized: normalizedChainType
      });

      // 检查该 operation_id 是否已存在评估记录（人工审核通过的情况）
      logger.info('🔍 Risk: 检查已存在的评估记录', { operation_id });
      const existingAssessment = await this.riskAssessmentModel.findByOperationId(operation_id);

      if (existingAssessment) {
        // 如果已经存在评估记录，且审批状态为 approved（人工审核通过）
        if (existingAssessment.approval_status === 'approved') {
          logger.info('Operation already approved by manual review, reusing signature', {
            operation_id,
            decision: existingAssessment.decision,
            approval_status: existingAssessment.approval_status
          });

          // 重新生成签名（因为现在有了 from 和 nonce）
          logger.info('📝 Risk: 构建签名载荷（人工审核通过）', {
            operation_id,
            chainType: normalizedChainType,
            from,
            to,
            amount,
            tokenAddress: tokenAddress || null,
            tokenType: tokenType || null,
            chainId,
            nonce,
            blockhash: blockhash || null,
            lastValidBlockHeight: lastValidBlockHeight || null,
            fee: fee || null,
            timestamp
          });

          const signaturePayload = this.buildSignaturePayload({
            operation_id,
            chainType: normalizedChainType,
            from,
            to,
            amount,
            tokenAddress,
            tokenType,
            chainId,
            nonce,
            blockhash,
            lastValidBlockHeight,
            fee,
            timestamp
          });
          
          logger.info('📋 Risk 签名载荷（对象）:', signaturePayload);
          const signPayload = JSON.stringify(signaturePayload);
          logger.info('📋 Risk 签名载荷（JSON字符串）:', signPayload);

          logger.info('🔐 Risk: 开始生成签名');
          const riskSignature = this.riskService.signMessage(signPayload);
          logger.info('✅ Risk: 签名生成成功', {
            signature: riskSignature,
            signatureLength: riskSignature.length
          });

          // 更新评估记录，添加新的签名
          await this.riskAssessmentModel.update(existingAssessment.id!, {
            operation_data: JSON.stringify({
              ...this.buildSignaturePayload({
                operation_id,
                chainType: normalizedChainType,
                from,
                to,
                amount,
                tokenAddress,
                tokenType,
                chainId,
                nonce,
                blockhash,
                lastValidBlockHeight,
                fee,
                timestamp
              })
            }),
            risk_signature: riskSignature,
            expires_at: new Date(timestamp + 5 * 60 * 1000).toISOString()
          });

          logger.info('✅ Risk: 返回人工审核通过的响应', {
            operation_id,
            risk_signature: riskSignature,
            decision: 'approve'
          });

          return res.status(200).json({
            success: true,
            risk_signature: riskSignature,
            decision: 'approve',
            timestamp,
            reasons: ['Manual review approved']
          });
        }
      }

      // 风控检查
      logger.info('🔍 Risk: 开始风控检查', {
        operation_id,
        from,
        to,
        amount,
        chainType: normalizedChainType,
        businessType: normalizedBusinessType
      });

      const withdrawalRisk = normalizedBusinessType === 'collect'
        ? {
            decision: 'approve' as const,
            reasons: ['System fund collection bypasses user withdraw limits'],
            risk_level: 'low' as const
          }
        : await this.withdrawalRiskRuleService.evaluate({
            operation_id,
            user_id: userId,
            from,
            to,
            amount,
            chainType: normalizedChainType,
            chainId,
            tokenSymbol,
            tokenId,
            timestamp
          });
      const decision = withdrawalRisk.decision;
      const reasons = withdrawalRisk.reasons;
      const riskLevel = withdrawalRisk.risk_level;

      // 如果被拒绝，直接返回，不生成签名
      if (decision === 'reject') {
        logger.info('📝 Risk: 构建拒绝操作的签名载荷', {
          operation_id,
          chainType: normalizedChainType,
          from,
          to,
          amount,
          tokenAddress: tokenAddress || null,
          tokenType: tokenType || null,
          chainId,
          nonce,
          blockhash: blockhash || null,
          lastValidBlockHeight: lastValidBlockHeight || null,
          fee: fee || null,
          timestamp
        });

        const denySignaturePayload = this.buildSignaturePayload({
          operation_id,
          chainType: normalizedChainType,
          from,
          to,
          amount,
          tokenAddress,
          tokenType,
          chainId,
          nonce,
          blockhash,
          lastValidBlockHeight,
          fee,
          timestamp
        });

        logger.info('📋 Risk 拒绝操作的签名载荷:', denySignaturePayload);

        const existingDeniedAssessment = await this.riskAssessmentModel.findByOperationId(operation_id);
        const deniedAssessmentData = {
          operation_id,
          table_name: undefined,
          action: normalizedBusinessType,
          user_id: userId,
          operation_data: JSON.stringify(denySignaturePayload),
          risk_level: riskLevel,
          decision: 'deny',
          approval_status: undefined,
          reasons: reasons.length > 0 ? JSON.stringify(reasons) : undefined,
          risk_signature: undefined,  // 不生成签名
          expires_at: undefined
        } as const;

        if (existingDeniedAssessment?.id) {
          await this.riskAssessmentModel.update(existingDeniedAssessment.id, deniedAssessmentData);
        } else {
          await this.riskAssessmentModel.create(deniedAssessmentData);
        }

        logger.info('Transaction risk assessment completed - REJECTED', {
          operation_id,
          businessType: normalizedBusinessType,
          from,
          to,
          amount,
          decision,
          risk_level: riskLevel,
          reasons
        });

        // 返回 403 状态码
        return res.status(403).json({
          success: false,
          decision,
          timestamp,
          reasons,
          error: {
            code: 'RISK_REJECTED',
            message: normalizedBusinessType === 'collect' ? '归集被风控拒绝' : '提现被风控拒绝',
            details: reasons.join('; ')
          }
        });
      }

      if (decision === 'manual_review') {
        const reviewPayload = this.buildSignaturePayload({
          operation_id,
          chainType: normalizedChainType,
          from,
          to,
          amount,
          tokenAddress,
          tokenType,
          chainId,
          nonce,
          blockhash,
          lastValidBlockHeight,
          fee,
          timestamp
        });

        const existingReviewAssessment = await this.riskAssessmentModel.findByOperationId(operation_id);
        const reviewAssessmentData = {
          operation_id,
          table_name: undefined,
          action: normalizedBusinessType,
          user_id: userId,
          operation_data: JSON.stringify({
            ...reviewPayload,
            user_id: userId ?? null,
            userId: userId ?? null,
            token_id: tokenId ?? null,
            tokenId: tokenId ?? null,
            tokenSymbol: tokenSymbol ?? null,
            businessType: normalizedBusinessType
          }),
          risk_level: riskLevel,
          decision: 'manual_review',
          approval_status: 'pending',
          reasons: reasons.length > 0 ? JSON.stringify(reasons) : undefined,
          risk_signature: undefined,
          expires_at: undefined
        } as const;

        if (existingReviewAssessment?.id) {
          await this.riskAssessmentModel.update(existingReviewAssessment.id, reviewAssessmentData);
        } else {
          await this.riskAssessmentModel.create(reviewAssessmentData);
        }

        logger.info('Transaction risk assessment requires manual review', {
          operation_id,
          businessType: normalizedBusinessType,
          from,
          to,
          amount,
          risk_level: riskLevel,
          reasons
        });

        return res.status(202).json({
          success: true,
          decision,
          timestamp,
          reasons
        });
      }

      // 通过风控检查，生成签名（复用 RiskAssessmentService 的 signer）
      logger.info('📝 Risk: 构建签名载荷（自动通过）', {
        operation_id,
        chainType: normalizedChainType,
        from,
        to,
        amount,
        tokenAddress: tokenAddress || null,
        tokenType: tokenType || null,
        chainId,
        nonce,
        blockhash: blockhash || null,
        lastValidBlockHeight: lastValidBlockHeight || null,
        fee: fee || null,
        timestamp
      });

      const signaturePayload = this.buildSignaturePayload({
        operation_id,
        chainType: normalizedChainType,
        from,
        to,
        amount,
        tokenAddress,
        tokenType,
        chainId,
        nonce,
        blockhash,
        lastValidBlockHeight,
        fee,
        timestamp
      });
      
      logger.info('📋 Risk 签名载荷（对象）:', signaturePayload);
      const signPayload = JSON.stringify(signaturePayload);
      logger.info('📋 Risk 签名载荷（JSON字符串）:', signPayload);

      logger.info('🔐 Risk: 开始生成签名');
      const riskSignature = this.riskService.signMessage(signPayload);
      logger.info('✅ Risk: 签名生成成功', {
        signature: riskSignature,
        signatureLength: riskSignature.length
      });

      // 记录到数据库
      // 计算签名过期时间（5分钟后）
      const expiresAt = new Date(timestamp + 5 * 60 * 1000).toISOString();

      const existingApprovedAssessment = await this.riskAssessmentModel.findByOperationId(operation_id);
      const approvedAssessmentData = {
        operation_id,
        table_name: undefined,  // 提现不对应具体数据库表
        action: normalizedBusinessType,
        user_id: userId,
        operation_data: JSON.stringify(
          {
            ...this.buildSignaturePayload({
            operation_id,
            chainType: normalizedChainType,
            from,
            to,
            amount,
            tokenAddress,
            tokenType,
            chainId,
            nonce,
            blockhash,
            lastValidBlockHeight,
            fee,
            timestamp
            }),
            user_id: userId ?? null,
            userId: userId ?? null,
            token_id: tokenId ?? null,
            tokenId: tokenId ?? null,
            tokenSymbol: tokenSymbol ?? null,
            businessType: normalizedBusinessType
          }
        ),
        risk_level: riskLevel,
        decision: decision === 'approve' ? 'auto_approve' : 'manual_review',
        reasons: reasons.length > 0 ? JSON.stringify(reasons) : undefined,
        risk_signature: riskSignature,
        expires_at: expiresAt
      } as const;

      if (existingApprovedAssessment?.id) {
        await this.riskAssessmentModel.update(existingApprovedAssessment.id, approvedAssessmentData);
      } else {
        await this.riskAssessmentModel.create(approvedAssessmentData);
      }

      logger.info('Transaction risk assessment completed - APPROVED', {
        operation_id,
        businessType: normalizedBusinessType,
        from,
        to,
        amount,
        decision,
        risk_level: riskLevel
      });

      logger.info('✅ Risk: 返回自动通过的响应', {
        operation_id,
        risk_signature: riskSignature,
        decision,
        timestamp,
        reasons: reasons.length > 0 ? reasons : undefined
      });

      return res.status(200).json({
        success: true,
        risk_signature: riskSignature,
        decision,
        timestamp,
        reasons
      });

    } catch (error) {
      logger.error('Withdraw risk assessment endpoint error', {
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack,
          name: error.name
        } : String(error),
        body: req.body
      });
      return res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error',
          details: error instanceof Error ? error.message : String(error)
        }
      });
    }
  };

  /**
   * 根据 operation_id 查询风控评估结果
   */
  getAssessmentByOperationId = async (req: Request, res: Response) => {
    try {
      const { operation_id } = req.params;

      if (!operation_id) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'INVALID_REQUEST',
            message: 'Missing operation_id parameter'
          }
        });
      }

      const assessment = await this.riskAssessmentModel.findByOperationId(operation_id);

      if (!assessment) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Assessment not found',
            details: `No assessment found for operation_id: ${operation_id}`
          }
        });
      }

      return res.status(200).json({
        success: true,
        data: assessment
      });

    } catch (error) {
      logger.error('Get assessment by operation_id endpoint error', {
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack,
          name: error.name
        } : String(error),
        params: req.params
      });
      return res.status(500).json({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error',
          details: error instanceof Error ? error.message : 'Unknown error'
        }
      });
    }
  };

  private buildSignaturePayload(params: {
    operation_id: string;
    chainType: 'evm' | 'btc' | 'solana';
    from: string;
    to: string;
    amount: string;
    tokenAddress?: string;
    tokenType?: string;
    chainId: number;
    nonce: number;
    blockhash?: string;
    lastValidBlockHeight?: string;
    fee?: string;
    timestamp: number;
  }): Record<string, any> {
    return {
      operation_id: params.operation_id,
      chainType: params.chainType,
      from: params.from,
      to: params.to,
      amount: params.amount,
      tokenAddress: params.tokenAddress ?? null,
      tokenType: params.tokenType ?? null,
      chainId: params.chainId,
      nonce: params.nonce,
      blockhash: params.blockhash ?? null,
      lastValidBlockHeight: params.lastValidBlockHeight ?? null,
      fee: params.fee ?? null,
      timestamp: params.timestamp
    };
  }
}
