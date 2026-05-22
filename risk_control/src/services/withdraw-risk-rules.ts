import { AddressRiskModel, RiskAssessmentModel, WithdrawRiskRule, WithdrawRiskRuleModel } from '../db/models';
import { riskControlDB } from '../db/connection';
import { logger } from '../utils/logger';
import { RiskDecision } from '../types';

export interface WithdrawalRiskInput {
  operation_id: string;
  user_id?: number;
  from?: string;
  to: string;
  amount: string;
  chainType: 'evm' | 'btc' | 'solana';
  chainId?: number;
  tokenSymbol?: string;
  tokenId?: number;
  timestamp: number;
}

export interface WithdrawalRiskResult {
  decision: RiskDecision;
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  reasons: string[];
  rule?: WithdrawRiskRule;
  dailyUsedAmount: string;
  frequencyCount: number;
}

const ACTIVE_DECISIONS = new Set(['auto_approve', 'manual_review']);
const APPROVED_STATUSES = new Set(['approved']);

export class WithdrawalRiskRuleService {
  private addressRiskModel: AddressRiskModel;
  private assessmentModel: RiskAssessmentModel;
  private ruleModel: WithdrawRiskRuleModel;

  constructor() {
    this.addressRiskModel = new AddressRiskModel(riskControlDB);
    this.assessmentModel = new RiskAssessmentModel(riskControlDB);
    this.ruleModel = new WithdrawRiskRuleModel(riskControlDB);
  }

  async evaluate(input: WithdrawalRiskInput): Promise<WithdrawalRiskResult> {
    const reasons: string[] = [];

    const addressDecision = await this.evaluateAddress(input);
    if (addressDecision) {
      return {
        ...addressDecision,
        reasons: addressDecision.reasons,
        dailyUsedAmount: '0',
        frequencyCount: 0
      };
    }

    const rule = await this.ruleModel.findBestMatch({
      chainType: input.chainType,
      chainId: input.chainId,
      tokenSymbol: input.tokenSymbol,
      tokenId: input.tokenId
    });

    if (!rule) {
      return {
        decision: 'approve',
        risk_level: 'low',
        reasons: ['Normal withdrawal'],
        dailyUsedAmount: '0',
        frequencyCount: 0
      };
    }

    let amount: bigint;
    try {
      amount = BigInt(input.amount);
    } catch (error) {
      logger.warn('Invalid withdrawal amount for risk check', {
        operation_id: input.operation_id,
        amount: input.amount,
        error
      });
      return {
        decision: 'manual_review',
        risk_level: 'high',
        reasons: [`提现金额格式异常: ${input.amount}`],
        rule,
        dailyUsedAmount: '0',
        frequencyCount: 0
      };
    }

    if (amount < 0n) {
      return {
        decision: 'manual_review',
        risk_level: 'high',
        reasons: [`提现金额不能为负数: ${input.amount}`],
        rule,
        dailyUsedAmount: '0',
        frequencyCount: 0
      };
    }

    const singleLimit = this.parseRuleAmount(rule.single_withdraw_limit, 'single_withdraw_limit', rule);
    if (singleLimit !== null && singleLimit > 0n && amount > singleLimit) {
      reasons.push(`单笔提现金额超过限制: amount=${amount.toString()}, limit=${singleLimit.toString()}`);
    }

    const since24h = new Date(input.timestamp - 24 * 60 * 60 * 1000).toISOString();
    const dailyUsed = await this.sumUsedAmount(input, since24h);
    const dailyLimit = this.parseRuleAmount(rule.daily_withdraw_limit, 'daily_withdraw_limit', rule);
    if (dailyLimit !== null && dailyLimit > 0n && dailyUsed + amount > dailyLimit) {
      reasons.push(`单日提现累计超过限制: used=${dailyUsed.toString()}, current=${amount.toString()}, limit=${dailyLimit.toString()}`);
    }

    const windowSeconds = Number(rule.frequency_window_seconds || 0);
    let frequencyCount = 0;
    if (windowSeconds > 0 && rule.frequency_max_count > 0) {
      const sinceWindow = new Date(input.timestamp - windowSeconds * 1000).toISOString();
      frequencyCount = await this.countRecentWithdrawals(input, sinceWindow);
      if (frequencyCount >= rule.frequency_max_count) {
        reasons.push(`提现频率超过限制: count=${frequencyCount}, current=1, max=${rule.frequency_max_count}, window_seconds=${windowSeconds}`);
      }
    }

    if (reasons.length === 0) {
      return {
        decision: 'approve',
        risk_level: 'low',
        reasons: ['Normal withdrawal'],
        rule,
        dailyUsedAmount: dailyUsed.toString(),
        frequencyCount
      };
    }

    return {
      decision: rule.limit_action === 'reject' ? 'reject' : 'manual_review',
      risk_level: rule.limit_action === 'reject' ? 'critical' : 'high',
      reasons,
      rule,
      dailyUsedAmount: dailyUsed.toString(),
      frequencyCount
    };
  }

  private async evaluateAddress(input: WithdrawalRiskInput): Promise<Pick<WithdrawalRiskResult, 'decision' | 'risk_level' | 'reasons'> | null> {
    const addresses = [
      { label: '来源地址', value: input.from },
      { label: '目标地址', value: input.to }
    ];

    for (const address of addresses) {
      if (!address.value) continue;

      const riskInfo = await this.addressRiskModel.checkAddress(address.value, input.chainType);
      if (!riskInfo) continue;

      if (riskInfo.risk_type === 'blacklist' || riskInfo.risk_type === 'sanctioned') {
        return {
          decision: 'reject',
          risk_level: 'critical',
          reasons: [`${address.label}命中${riskInfo.risk_type}: ${riskInfo.reason || '未提供原因'}`]
        };
      }

      if (riskInfo.risk_type === 'suspicious') {
        return {
          decision: 'manual_review',
          risk_level: riskInfo.risk_level === 'high' ? 'high' : 'medium',
          reasons: [`${address.label}命中异常地址: ${riskInfo.reason || '未提供原因'}`]
        };
      }
    }

    return null;
  }

  private parseRuleAmount(value: string, field: string, rule: WithdrawRiskRule): bigint | null {
    try {
      return BigInt(value);
    } catch (error) {
      logger.warn('Invalid withdraw risk rule amount', {
        rule_id: rule.id,
        rule_name: rule.name,
        field,
        value,
        error
      });
      return null;
    }
  }

  private async sumUsedAmount(input: WithdrawalRiskInput, sinceIso: string): Promise<bigint> {
    const records = await this.findRecentAssessments(input, sinceIso);
    return records.reduce((sum, record) => sum + record.amount, 0n);
  }

  private async countRecentWithdrawals(input: WithdrawalRiskInput, sinceIso: string): Promise<number> {
    const records = await this.findRecentAssessments(input, sinceIso);
    return records.length;
  }

  private async findRecentAssessments(input: WithdrawalRiskInput, sinceIso: string): Promise<{ amount: bigint }[]> {
    const rows = await this.assessmentModel.findRecentWithdrawals({
      userId: input.user_id,
      chainType: input.chainType,
      chainId: input.chainId,
      tokenSymbol: input.tokenSymbol,
      tokenId: input.tokenId,
      sinceIso,
      excludeOperationId: input.operation_id
    });

    const amounts: { amount: bigint }[] = [];
    for (const row of rows) {
      if (!this.isActiveAssessment(row.decision, row.approval_status)) {
        continue;
      }

      const parsed = this.parseOperationData(row.operation_data);
      if (!parsed?.amount) {
        continue;
      }

      try {
        amounts.push({ amount: BigInt(parsed.amount) });
      } catch {
        logger.warn('Skipping risk assessment with invalid amount', {
          operation_id: row.operation_id,
          amount: parsed.amount
        });
      }
    }

    return amounts;
  }

  private isActiveAssessment(decision: string, approvalStatus?: string): boolean {
    return ACTIVE_DECISIONS.has(decision) || (approvalStatus ? APPROVED_STATUSES.has(approvalStatus) : false);
  }

  private parseOperationData(operationData: string): any | null {
    try {
      return JSON.parse(operationData);
    } catch {
      return null;
    }
  }
}
