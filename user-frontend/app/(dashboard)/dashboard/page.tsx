'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { useUserSession } from '@/lib/auth/user-session-context';
import { useBalanceDetails, useBalanceStats, usePendingDeposits, useTotalBalances, useWithdrawList } from '@/lib/hooks/use-wallet';
import { DashboardCards } from '@/components/dashboard/cards';
import { RecentTransfers } from '@/components/dashboard/recent-transfers';
import { DashboardPortfolioChart } from '@/components/dashboard/portfolio-chart';
import { Surface } from '@/components/ui/surface';
import { ErrorSummary } from '@/components/dashboard/error-summary';
import { LoadingState } from '@/components/ui/loading';

const EMPTY_BALANCES: never[] = [];
const EMPTY_PENDING_DEPOSITS: never[] = [];

export default function DashboardPage() {
  const { userId } = useUserSession();
  const [selectedAssetSymbol, setSelectedAssetSymbol] = useState('ALL');

  const totalBalancesQuery = useTotalBalances(userId);
  const balanceStatsQuery = useBalanceStats(userId);
  const balanceDetailsQuery = useBalanceDetails(userId);
  const pendingDepositsQuery = usePendingDeposits(userId);
  const latestWithdrawQuery = useWithdrawList(userId, { limit: 5, offset: 0 });

  const balances = totalBalancesQuery.data || EMPTY_BALANCES;
  const pendingDeposits = pendingDepositsQuery.data || EMPTY_PENDING_DEPOSITS;
  const assetOptions = useMemo(() => {
    return Array.from(new Set([
      ...balances.map((item) => item.token_symbol),
      ...pendingDeposits.map((item) => item.token_symbol)
    ])).sort((a, b) => a.localeCompare(b));
  }, [balances, pendingDeposits]);
  const filteredBalances = useMemo(() => {
    if (selectedAssetSymbol === 'ALL') return balances;
    return balances.filter((item) => item.token_symbol === selectedAssetSymbol);
  }, [balances, selectedAssetSymbol]);
  const withdraws = latestWithdrawQuery.data?.withdraws || [];

  useEffect(() => {
    if (selectedAssetSymbol !== 'ALL' && !assetOptions.includes(selectedAssetSymbol)) {
      setSelectedAssetSymbol('ALL');
    }
  }, [assetOptions, selectedAssetSymbol]);

  return (
    <div className="grid gap-5">
      <Surface title="资产总览" subtitle="账户资产、充值进度和近期提现状态">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-2xl font-semibold">欢迎回来</h1>
            <p className="mt-1 text-sm text-muted-foreground">查看资产分布、入金状态和最近资金流动。</p>
          </div>
          <Link
            href="/deposit"
            className="inline-flex h-10 cursor-pointer items-center justify-center rounded-lg bg-foreground px-4 text-sm font-medium text-background transition duration-200 hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
          >
            充值
          </Link>
        </div>
      </Surface>

      {userId ? (
        <>
          <DashboardCards
            totalBalancesQuery={totalBalancesQuery}
            balanceStatsQuery={balanceStatsQuery}
            balanceDetailsQuery={balanceDetailsQuery}
            pendingDepositsQuery={pendingDepositsQuery}
            latestWithdraws={withdraws}
            assetOptions={assetOptions}
            selectedAssetSymbol={selectedAssetSymbol}
            onSelectedAssetSymbolChange={setSelectedAssetSymbol}
          />

          <div className="grid gap-4 xl:grid-cols-[1fr,1fr]">
            {totalBalancesQuery.isError ? (
              <ErrorSummary message={totalBalancesQuery.error?.message || '总资产聚合失败'} />
            ) : null}

            <DashboardPortfolioChart
              balances={filteredBalances}
              loading={totalBalancesQuery.isLoading || totalBalancesQuery.isFetching}
              error={totalBalancesQuery.isError ? totalBalancesQuery.error?.message : undefined}
              selectedAssetSymbol={selectedAssetSymbol}
            />

            <div className="grid gap-4">
              <RecentTransfers
                withdraws={withdraws}
                isLoading={latestWithdrawQuery.isLoading || latestWithdrawQuery.isFetching}
              />

              <Surface
                title="资产明细"
                subtitle={selectedAssetSymbol === 'ALL' ? '按币种汇总的账户余额' : `当前仅显示 ${selectedAssetSymbol} 资产`}
              >
                {totalBalancesQuery.isLoading || totalBalancesQuery.isFetching ? (
                  <LoadingState label="加载资产列表..." />
                ) : filteredBalances.length === 0 ? (
                  <div className="text-sm text-muted-foreground">暂无可展示资产</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                      <thead>
                        <tr className="text-left text-muted-foreground">
                          <th className="pb-2 pr-3">代币</th>
                          <th className="pb-2 pr-3">网络</th>
                          <th className="pb-2 pr-3">可用</th>
                          <th className="pb-2 pr-3">冻结</th>
                          <th className="pb-2 pr-3">总余额</th>
                          <th className="pb-2">地址数</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredBalances.map((item) => (
                          <tr key={`${item.chain_type || 'unknown'}:${item.chain_id || 'unknown'}:${item.token_symbol}`} className="border-t border-border/50">
                            <td className="py-2 pr-3 font-medium">{item.token_symbol}</td>
                            <td className="py-2 pr-3 text-muted-foreground">
                              {item.chain_type ? `${item.chain_type.toUpperCase()} ${item.chain_id || ''}` : '--'}
                            </td>
                            <td className="py-2 pr-3">{item.available_balance}</td>
                            <td className="py-2 pr-3">{item.frozen_balance}</td>
                            <td className="py-2 pr-3">{item.total_balance}</td>
                            <td className="py-2">{item.address_count}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Surface>
            </div>
          </div>
        </>
      ) : null}

      {pendingDepositsQuery.isError ? (
        <ErrorSummary message={pendingDepositsQuery.error?.message || '获取充值中余额失败'} />
      ) : null}

      <div className="flex justify-end">
        <Link
          href="/withdraw"
          className="inline-flex h-10 cursor-pointer items-center justify-center rounded-lg bg-foreground px-4 text-sm font-medium text-background transition duration-200 hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
        >
          进入提现
        </Link>
      </div>

      <Surface title="资金提醒" subtitle="充值和提现状态会随处理进度更新">
        <p className="text-sm text-muted-foreground">
          充值到账、提现审核和链上确认可能需要一些时间。你可以在交易记录中查看最新状态。
        </p>
      </Surface>
    </div>
  );
}
