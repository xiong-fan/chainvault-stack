'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';

import { useUserSession } from '@/lib/auth/user-session-context';
import { useAvailableTokens, useBalanceDetails, useCreateWithdraw, useWithdrawDetail, useWithdrawList } from '@/lib/hooks/use-wallet';
import { formatCurrencyAmount } from '@/lib/format/number';
import { Surface } from '@/components/ui/surface';
import { LoadingState, ErrorState } from '@/components/ui/loading';
import { Button } from '@/components/ui/button';
import { WithdrawForm } from '@/components/withdraw/withdraw-form';
import { WithdrawRecordsTable } from '@/components/withdraw/withdraw-records';
import { CHAIN_OPTIONS, formatChainTypeLabel } from '@/lib/chains';
import type { CreateWithdrawResponse } from '@/types/api/wallet';
import { WITHDRAW_STATUS_META } from '@/types/domain/withdraw';

export default function WithdrawPage() {
  const { userId } = useUserSession();
  const [currentWithdrawId, setCurrentWithdrawId] = useState<number | undefined>(undefined);

  const withdrawMutation = useCreateWithdraw(userId);
  const listQuery = useWithdrawList(userId, { limit: 20, offset: 0 });
  const detailQuery = useWithdrawDetail(currentWithdrawId);
  const tokensQuery = useAvailableTokens();
  const balanceDetailsQuery = useBalanceDetails(userId);

  const latest = listQuery.data?.withdraws || [];

  const latestCreateResult = withdrawMutation.data as
    | CreateWithdrawResponse
    | undefined;

  const submitHint = useMemo(() => {
    if (!withdrawMutation.isError) return '提交提现后可在下方看到最新提现状态';
    const rawMessage = withdrawMutation.error?.message || '提现提交失败';
    if (rawMessage.includes('403')) {
      return '风控拒绝：请调整金额、地址、代币或联系管理员';
    }
    if (rawMessage.includes('400')) {
      return '参数校验失败：请确认金额大于 0、地址格式和账户状态';
    }
    if (rawMessage.includes('503')) {
      return '钱包服务依赖异常（signer/risk 可能不可用），请稍后重试';
    }
    return rawMessage;
  }, [withdrawMutation.error, withdrawMutation.isError]);

  if (!userId) {
    return null;
  }

  return (
    <div className="grid gap-4">
      <Surface title="提现" subtitle="提交链上提现并跟踪状态">
        <div className="text-sm text-muted-foreground space-y-2">
          <p>
            提现会经过账户校验和风控审核。请确认目标地址、网络和金额无误。
          </p>
          <p>
            可用链：
            {CHAIN_OPTIONS.map((item) => (
              <span key={item.value} className="mx-1">
                {formatChainTypeLabel(item.value)}({item.chainId})
              </span>
            ))}
          </p>
        </div>
      </Surface>

      <Surface title="提交提现" subtitle="填写网络、币种、地址和数量">
        <WithdrawForm
          onSubmit={async (values) => {
            await withdrawMutation.mutateAsync({
              userId,
              to: values.to,
              amount: values.amount,
              tokenId: values.tokenId,
              chainId: values.chainId,
              chainType: values.chainType
            });
            return { ok: true };
          }}
          isPending={withdrawMutation.isPending}
          tokens={tokensQuery.data || []}
          tokensLoading={tokensQuery.isLoading || tokensQuery.isFetching}
          balances={balanceDetailsQuery.data || []}
          balancesLoading={balanceDetailsQuery.isLoading || balanceDetailsQuery.isFetching}
        />

        <p className="mt-3 text-sm text-muted-foreground">{submitHint}</p>

        {withdrawMutation.isPending ? <LoadingState label="提交中，等待钱包服务响应" /> : null}
        {tokensQuery.isError ? <ErrorState message={tokensQuery.error?.message || '可提现代币加载失败'} /> : null}
        {withdrawMutation.isError ? <ErrorState message={withdrawMutation.error?.message || '提现提交失败'} /> : null}

        {latestCreateResult ? (
          <div className="mt-4 rounded-lg border border-border/60 p-3">
            <h3 className="text-sm font-medium">最新提现结果</h3>
            <div className="mt-2 grid gap-1 text-sm text-muted-foreground">
              <div>提现ID：{latestCreateResult.withdrawId}</div>
              <div>请求金额：{formatCurrencyAmount(latestCreateResult.withdrawAmount)}</div>
              <div>实际扣费后：{formatCurrencyAmount(latestCreateResult.actualAmount)}</div>
              <div>手续费：{formatCurrencyAmount(latestCreateResult.fee)}</div>
              <div>txHash：{latestCreateResult.transactionHash || '未返回'}</div>
              {latestCreateResult.signedTransaction ? (
                <div>签名数据长度：{latestCreateResult.signedTransaction.length}</div>
              ) : null}
              {latestCreateResult.gasEstimation?.networkCongestion ? (
                <div>网络拥堵：{latestCreateResult.gasEstimation.networkCongestion}</div>
              ) : null}
            </div>

            <Button
              type="button"
              variant="outline"
              className="mt-3"
              onClick={() => setCurrentWithdrawId(latestCreateResult.withdrawId)}
            >
              查看详情
            </Button>
          </div>
        ) : null}
      </Surface>

      {currentWithdrawId && detailQuery.data ? (
        <Surface title={`提现详情 #${currentWithdrawId}`} subtitle="处理状态与费用明细">
          <div className="grid gap-2 text-sm">
            <div>目标地址：{detailQuery.data.withdraw.to_address}</div>
            <div>金额：{formatCurrencyAmount(detailQuery.data.withdraw.amount)}</div>
            <div>费用：{formatCurrencyAmount(detailQuery.data.withdraw.fee)}</div>
            <div>
              状态：
              {WITHDRAW_STATUS_META[detailQuery.data.withdraw.status]?.label || detailQuery.data.withdraw.status}
            </div>
            <div>
              链：{detailQuery.data.withdraw.chain_type} / chainId {detailQuery.data.withdraw.chain_id}
            </div>
            <div>创建时间：{new Date(detailQuery.data.withdraw.created_at).toLocaleString()}</div>
            {detailQuery.data.withdraw.error_message ? (
              <div className="text-destructive">错误信息：{detailQuery.data.withdraw.error_message}</div>
            ) : null}
            <div className="text-xs text-muted-foreground">关联记账记录：{detailQuery.data.credits.length}</div>
          </div>
        </Surface>
      ) : null}

      {listQuery.isLoading || listQuery.isFetching ? (
        <LoadingState label="加载提现记录..." />
      ) : (
        <WithdrawRecordsTable
          items={latest}
          isLoading={false}
          isError={false}
          error={undefined}
        />
      )}

      {latest.length === 0 ? (
        <Surface title="说明">
          <p className="text-sm text-muted-foreground">
            当前无提现记录。提交后可在此查看状态流转：
            user_withdraw_request 进入签名、待上链、处理中、已完成或失败状态。
          </p>
          <Link href="/records" className="text-sm underline">
            去交易记录页筛选查看
          </Link>
        </Surface>
      ) : null}
    </div>
  );
}
