'use client';

import { useMemo, useState } from 'react';
import { LoadingState, ErrorState } from '@/components/ui/loading';
import { formatCurrencyAmount } from '@/lib/format/number';
import { shortenText } from '@/lib/format/number';
import { BalanceDetailItem, BalanceStats, TokenBalanceItem, PendingDepositItem, WithdrawItem } from '@/types/api/wallet';
import { Activity, AlertTriangle, ArrowDownCircle, ArrowUpCircle, ChevronDown, Layers, Link2, Wallet } from 'lucide-react';

type InsightType = 'chains' | 'tokens' | 'addresses' | 'positive' | 'pending';

interface DashboardCardsProps {
  totalBalancesQuery: {
    isLoading: boolean;
    isError: boolean;
    error?: Error | null;
    data?: TokenBalanceItem[];
  };
  balanceStatsQuery: {
    isLoading: boolean;
    isError: boolean;
    error?: Error | null;
    data?: BalanceStats;
  };
  balanceDetailsQuery: {
    isLoading: boolean;
    isError: boolean;
    error?: Error | null;
    data?: BalanceDetailItem[];
  };
  pendingDepositsQuery: {
    isLoading: boolean;
    isError: boolean;
    error?: Error | null;
    data?: PendingDepositItem[];
  };
  latestWithdraws: WithdrawItem[];
  assetOptions: string[];
  selectedAssetSymbol: string;
  onSelectedAssetSymbolChange: (symbol: string) => void;
}

function sumBalanceField(totalBalances: TokenBalanceItem[] | undefined, field: 'total_balance' | 'available_balance' | 'frozen_balance') {
  if (!totalBalances || totalBalances.length === 0) return 0;
  return totalBalances.reduce((acc, item) => {
    const parsed = Number.parseFloat(item[field] || '0');
    return Number.isNaN(parsed) ? acc : acc + parsed;
  }, 0);
}

function getTotalDisplay(totalBalances?: TokenBalanceItem[]) {
  return sumBalanceField(totalBalances, 'total_balance').toFixed(6);
}

function getScopedStats(balances: TokenBalanceItem[], details: BalanceDetailItem[], fallback: BalanceStats) {
  if (balances.length === 0 && details.length === 0) {
    return {
      chainCount: 0,
      tokenCount: 0,
      addressCount: 0,
      positiveBalanceCount: 0
    };
  }

  const chains = new Set<string>();
  const addresses = new Set<string>();

  balances.forEach((item) => {
    chains.add(`${item.chain_type || 'unknown'}:${item.chain_id || 'unknown'}`);
  });
  details.forEach((item) => {
    chains.add(`${item.chain_type || 'unknown'}:${item.chain_id || 'unknown'}`);
    addresses.add(`${item.chain_type || 'unknown'}:${item.chain_id || 'unknown'}:${item.address}`);
  });

  const positiveBalanceCount = details.length > 0
    ? details.filter((item) => Number.parseFloat(item.total_balance_formatted || '0') > 0).length
    : balances.filter((item) => Number.parseFloat(item.total_balance || '0') > 0).length;

  return {
    chainCount: chains.size || fallback.chain_count,
    tokenCount: new Set(balances.map((item) => item.token_symbol)).size || fallback.token_count,
    addressCount: addresses.size || balances.reduce((acc, item) => acc + item.address_count, 0) || fallback.address_count,
    positiveBalanceCount
  };
}

function getPendingDepositDisplay(pendingDeposits?: PendingDepositItem[]) {
  if (!pendingDeposits || pendingDeposits.length === 0) return '0';

  const total = pendingDeposits.reduce((acc, item) => {
    const parsed = Number.parseFloat(item.pending_amount || '0');
    return Number.isNaN(parsed) ? acc : acc + parsed;
  }, 0);

  return `${total.toFixed(6)} (all assets)`;
}

function getPendingDepositCounts(pendingDeposits?: PendingDepositItem[]) {
  const items = pendingDeposits || [];
  return items.reduce(
    (acc, item) => ({
      scanned: acc.scanned + (item.scanned_count || 0),
      confirming: acc.confirming + (item.confirming_count || 0) + (item.safe_count || 0),
      finalizing: acc.finalizing + (item.transaction_count || 0)
    }),
    { scanned: 0, confirming: 0, finalizing: 0 }
  );
}

function parseApproximateToday(withdraws: WithdrawItem[]) {
  // 当前 wallet API 无法直接返回“今日入金/今日提现”，故用近似值替代：
  // - 今日入金：使用 pending 入金金额聚合（全局）
  // - 今日提现：最近 7 条提现记录中已确认数量
  const todayWithdrawCount = withdraws.filter((item) => item.status === 'confirmed').slice(0, 7).length;
  return {
    todayWithdrawApproxCount: todayWithdrawCount
  };
}

function formatUpdatedAt(value?: string | null) {
  if (!value) return '--';

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;

  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(parsed);
}

function OverviewMetric({
  label,
  value,
  icon: Icon,
  active,
  onClick
}: {
  label: string;
  value: string | number;
  icon: typeof Layers;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`min-h-[76px] cursor-pointer rounded-md border px-3 py-3 text-left transition duration-200 hover:border-primary/60 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 ${
        active ? 'border-primary/80 bg-muted/50' : 'border-border/70 bg-muted/25'
      }`}
    >
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{label}</span>
        <Icon className="h-4 w-4" />
      </div>
      <div className="mt-3 font-mono text-xl font-semibold tabular-nums text-foreground">{value}</div>
    </button>
  );
}

function chainLabel(chainType?: string | null, chainId?: number | null) {
  if (!chainType && !chainId) return '--';
  return `${chainType ? chainType.toUpperCase() : 'UNKNOWN'}${chainId ? ` ${chainId}` : ''}`;
}

function EmptyInsight() {
  return <div className="px-4 py-6 text-sm text-muted-foreground">暂无可展示明细</div>;
}

function AssetInsightPanel({
  activeInsight,
  balances,
  details,
  pendingDeposits
}: {
  activeInsight: InsightType;
  balances: TokenBalanceItem[];
  details: BalanceDetailItem[];
  pendingDeposits: PendingDepositItem[];
}) {
  const chainRows = useMemo(() => {
    const map = new Map<string, {
      chain_type: string | null | undefined;
      chain_id: number | null | undefined;
      tokenSymbols: Set<string>;
      addresses: Set<string>;
      positiveItems: number;
    }>();

    details.forEach((item) => {
      const key = `${item.chain_type || 'unknown'}:${item.chain_id || 'unknown'}`;
      const existing = map.get(key) || {
        chain_type: item.chain_type,
        chain_id: item.chain_id,
        tokenSymbols: new Set<string>(),
        addresses: new Set<string>(),
        positiveItems: 0
      };

      existing.tokenSymbols.add(item.token_symbol);
      existing.addresses.add(item.address);
      if (Number.parseFloat(item.total_balance_formatted || '0') > 0) {
        existing.positiveItems += 1;
      }
      map.set(key, existing);
    });

    return Array.from(map.values());
  }, [details]);

  const addressRows = useMemo(() => {
    const map = new Map<string, {
      chain_type: string | null | undefined;
      chain_id: number | null | undefined;
      address: string;
      tokenSymbols: Set<string>;
      positiveItems: number;
    }>();

    details.forEach((item) => {
      const key = `${item.chain_type || 'unknown'}:${item.chain_id || 'unknown'}:${item.address}`;
      const existing = map.get(key) || {
        chain_type: item.chain_type,
        chain_id: item.chain_id,
        address: item.address,
        tokenSymbols: new Set<string>(),
        positiveItems: 0
      };

      existing.tokenSymbols.add(item.token_symbol);
      if (Number.parseFloat(item.total_balance_formatted || '0') > 0) {
        existing.positiveItems += 1;
      }
      map.set(key, existing);
    });

    return Array.from(map.values());
  }, [details]);

  const positiveRows = details.filter((item) => Number.parseFloat(item.total_balance_formatted || '0') > 0);

  const titleMap: Record<InsightType, string> = {
    chains: '链分布',
    tokens: '币种分布',
    addresses: '地址分布',
    positive: '正余额项目',
    pending: '充值中'
  };

  const countMap: Record<InsightType, number> = {
    chains: chainRows.length,
    tokens: balances.length,
    addresses: addressRows.length,
    positive: positiveRows.length,
    pending: pendingDeposits.length
  };

  return (
    <div className="border-t border-border/70">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div>
          <p className="text-sm font-medium">{titleMap[activeInsight]}</p>
          <p className="text-xs text-muted-foreground">点击上方指标切换明细</p>
        </div>
        <div className="rounded-full border border-border/70 px-2.5 py-1 font-mono text-xs text-muted-foreground tabular-nums">
          {countMap[activeInsight]} rows
        </div>
      </div>

      <div className="overflow-x-auto border-t border-border/70">
        {activeInsight === 'chains' && (
          chainRows.length === 0 ? <EmptyInsight /> : (
            <table className="min-w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">网络</th>
                  <th className="px-4 py-2 font-medium">币种数</th>
                  <th className="px-4 py-2 font-medium">地址数</th>
                  <th className="px-4 py-2 font-medium">正余额项</th>
                </tr>
              </thead>
              <tbody>
                {chainRows.map((row) => (
                  <tr key={`${row.chain_type || 'unknown'}:${row.chain_id || 'unknown'}`} className="border-t border-border/50">
                    <td className="px-4 py-2 font-medium">{chainLabel(row.chain_type, row.chain_id)}</td>
                    <td className="px-4 py-2 font-mono tabular-nums">{row.tokenSymbols.size}</td>
                    <td className="px-4 py-2 font-mono tabular-nums">{row.addresses.size}</td>
                    <td className="px-4 py-2 font-mono tabular-nums">{row.positiveItems}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}

        {activeInsight === 'tokens' && (
          balances.length === 0 ? <EmptyInsight /> : (
            <table className="min-w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">代币</th>
                  <th className="px-4 py-2 font-medium">网络</th>
                  <th className="px-4 py-2 font-medium">可用</th>
                  <th className="px-4 py-2 font-medium">冻结</th>
                  <th className="px-4 py-2 font-medium">总余额</th>
                  <th className="px-4 py-2 font-medium">地址数</th>
                </tr>
              </thead>
              <tbody>
                {balances.map((item) => (
                  <tr key={`${item.chain_type || 'unknown'}:${item.chain_id || 'unknown'}:${item.token_symbol}`} className="border-t border-border/50">
                    <td className="px-4 py-2 font-medium">{item.token_symbol}</td>
                    <td className="px-4 py-2 text-muted-foreground">{chainLabel(item.chain_type, item.chain_id)}</td>
                    <td className="px-4 py-2 font-mono tabular-nums">{item.available_balance}</td>
                    <td className="px-4 py-2 font-mono tabular-nums">{item.frozen_balance}</td>
                    <td className="px-4 py-2 font-mono tabular-nums">{item.total_balance}</td>
                    <td className="px-4 py-2 font-mono tabular-nums">{item.address_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}

        {activeInsight === 'addresses' && (
          addressRows.length === 0 ? <EmptyInsight /> : (
            <table className="min-w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">地址</th>
                  <th className="px-4 py-2 font-medium">网络</th>
                  <th className="px-4 py-2 font-medium">币种数</th>
                  <th className="px-4 py-2 font-medium">正余额项</th>
                </tr>
              </thead>
              <tbody>
                {addressRows.map((row) => (
                  <tr key={`${row.chain_type || 'unknown'}:${row.chain_id || 'unknown'}:${row.address}`} className="border-t border-border/50">
                    <td className="px-4 py-2 font-mono tabular-nums">{shortenText(row.address, 10, 8)}</td>
                    <td className="px-4 py-2 text-muted-foreground">{chainLabel(row.chain_type, row.chain_id)}</td>
                    <td className="px-4 py-2 font-mono tabular-nums">{row.tokenSymbols.size}</td>
                    <td className="px-4 py-2 font-mono tabular-nums">{row.positiveItems}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}

        {activeInsight === 'positive' && (
          positiveRows.length === 0 ? <EmptyInsight /> : (
            <table className="min-w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">代币</th>
                  <th className="px-4 py-2 font-medium">网络</th>
                  <th className="px-4 py-2 font-medium">地址</th>
                  <th className="px-4 py-2 font-medium">可用</th>
                  <th className="px-4 py-2 font-medium">总余额</th>
                </tr>
              </thead>
              <tbody>
                {positiveRows.map((item) => (
                  <tr key={`${item.chain_type || 'unknown'}:${item.chain_id || 'unknown'}:${item.address}:${item.token_id}`} className="border-t border-border/50">
                    <td className="px-4 py-2 font-medium">{item.token_symbol}</td>
                    <td className="px-4 py-2 text-muted-foreground">{chainLabel(item.chain_type, item.chain_id)}</td>
                    <td className="px-4 py-2 font-mono tabular-nums">{shortenText(item.address, 10, 8)}</td>
                    <td className="px-4 py-2 font-mono tabular-nums">{item.available_balance_formatted}</td>
                    <td className="px-4 py-2 font-mono tabular-nums">{item.total_balance_formatted}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}

        {activeInsight === 'pending' && (
          pendingDeposits.length === 0 ? <EmptyInsight /> : (
            <table className="min-w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">代币</th>
                  <th className="px-4 py-2 font-medium">网络</th>
                  <th className="px-4 py-2 font-medium">待确认金额</th>
                  <th className="px-4 py-2 font-medium">阶段</th>
                  <th className="px-4 py-2 font-medium">交易</th>
                  <th className="px-4 py-2 font-medium">确认数</th>
                </tr>
              </thead>
              <tbody>
                {pendingDeposits.flatMap((item) => (
                  item.deposits.map((deposit, index) => (
                    <tr key={`${item.chain_type || 'unknown'}:${item.chain_id || 'unknown'}:${item.token_id}:${deposit.tx_hash}:${index}`} className="border-t border-border/50">
                      <td className="px-4 py-2 font-medium">{item.token_symbol}</td>
                      <td className="px-4 py-2 text-muted-foreground">{chainLabel(item.chain_type, item.chain_id)}</td>
                      <td className="px-4 py-2 font-mono tabular-nums">{deposit.amount}</td>
                      <td className="px-4 py-2">{deposit.progress_label}</td>
                      <td className="px-4 py-2 font-mono tabular-nums">{shortenText(deposit.tx_hash, 10, 8)}</td>
                      <td className="px-4 py-2 font-mono tabular-nums">
                        {deposit.required_confirmations ? `${deposit.confirmation_count}/${deposit.required_confirmations}` : deposit.confirmation_count}
                      </td>
                    </tr>
                  ))
                ))}
              </tbody>
            </table>
          )
        )}
      </div>
    </div>
  );
}

export function DashboardCards({
  totalBalancesQuery,
  balanceStatsQuery,
  balanceDetailsQuery,
  pendingDepositsQuery,
  latestWithdraws,
  assetOptions,
  selectedAssetSymbol,
  onSelectedAssetSymbolChange
}: DashboardCardsProps) {
  const [activeInsight, setActiveInsight] = useState<InsightType | null>(null);

  if (totalBalancesQuery.isLoading || balanceStatsQuery.isLoading || balanceDetailsQuery.isLoading || pendingDepositsQuery.isLoading) {
    return <LoadingState label="加载仪表盘数据..." />;
  }

  if (totalBalancesQuery.isError) {
    return <ErrorState message={totalBalancesQuery.error?.message || '获取总资产失败'} />;
  }

  const balances = totalBalancesQuery.data || [];
  const details = balanceDetailsQuery.data || [];
  const stats = balanceStatsQuery.data || {
    user_id: 0,
    chain_count: 0,
    token_count: 0,
    address_count: 0,
    positive_balance_count: 0,
    last_balance_update: null
  };
  const scopedBalances = selectedAssetSymbol === 'ALL'
    ? balances
    : balances.filter((item) => item.token_symbol === selectedAssetSymbol);
  const scopedDetails = selectedAssetSymbol === 'ALL'
    ? details
    : details.filter((item) => item.token_symbol === selectedAssetSymbol);
  const pendingDeposits = selectedAssetSymbol === 'ALL'
    ? pendingDepositsQuery.data || []
    : (pendingDepositsQuery.data || []).filter((item) => item.token_symbol === selectedAssetSymbol);
  const scopedStats = selectedAssetSymbol === 'ALL'
    ? {
        chainCount: stats.chain_count,
        tokenCount: stats.token_count,
        addressCount: stats.address_count,
        positiveBalanceCount: stats.positive_balance_count
      }
    : getScopedStats(scopedBalances, scopedDetails, stats);
  const total = getTotalDisplay(scopedBalances);
  const available = sumBalanceField(scopedBalances, 'available_balance').toFixed(6);
  const frozen = sumBalanceField(scopedBalances, 'frozen_balance').toFixed(6);
  const pending = getPendingDepositDisplay(pendingDeposits);
  const pendingCounts = getPendingDepositCounts(pendingDeposits);
  const approx = parseApproximateToday(latestWithdraws);
  const selectionLabel = selectedAssetSymbol === 'ALL' ? '全部币种' : selectedAssetSymbol;
  const toggleInsight = (type: InsightType) => {
    setActiveInsight((current) => current === type ? null : type);
  };

  return (
    <section className="card overflow-hidden">
      <div className="border-b border-border/70 px-4 py-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-sm text-muted-foreground">资产总览</p>
            <div className="mt-2 flex flex-wrap items-end gap-x-3 gap-y-1">
              <div className="font-mono text-4xl font-semibold leading-none tracking-normal tabular-nums md:text-5xl">
                {formatCurrencyAmount(total)}
              </div>
              <span className="pb-1 text-sm font-medium text-muted-foreground">{selectionLabel} 总余额</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span className="rounded-md border border-border/70 bg-muted/25 px-2.5 py-1">
                可用 <span className="font-mono text-foreground tabular-nums">{formatCurrencyAmount(available)}</span>
              </span>
              <span className="rounded-md border border-border/70 bg-muted/25 px-2.5 py-1">
                冻结 <span className="font-mono text-foreground tabular-nums">{formatCurrencyAmount(frozen)}</span>
              </span>
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <label className="relative block min-w-[180px]">
              <span className="sr-only">切换资产币种</span>
              <select
                value={selectedAssetSymbol}
                onChange={(event) => onSelectedAssetSymbolChange(event.target.value)}
                className="h-10 w-full cursor-pointer appearance-none rounded-md border border-border/70 bg-muted/25 px-3 pr-9 text-sm font-medium text-foreground outline-none transition duration-200 hover:border-primary/60 focus:border-primary/70 focus:ring-2 focus:ring-primary/30"
              >
                <option value="ALL">全部币种</option>
                {assetOptions.map((symbol) => (
                  <option key={symbol} value={symbol}>{symbol}</option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-3 top-3 h-4 w-4 text-muted-foreground" />
            </label>
            <div className="flex min-w-fit items-center gap-2 rounded-md border border-border/70 bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
              <Activity className="h-4 w-4 text-primary" />
              <span>最近更新</span>
              <span className="font-mono text-foreground tabular-nums">{formatUpdatedAt(stats.last_balance_update)}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-5">
        <OverviewMetric label="链数量" value={scopedStats.chainCount} icon={Link2} active={activeInsight === 'chains'} onClick={() => toggleInsight('chains')} />
        <OverviewMetric label="币种数量" value={scopedStats.tokenCount} icon={Layers} active={activeInsight === 'tokens'} onClick={() => toggleInsight('tokens')} />
        <OverviewMetric label="地址数量" value={scopedStats.addressCount} icon={Wallet} active={activeInsight === 'addresses'} onClick={() => toggleInsight('addresses')} />
        <OverviewMetric label="正余额项" value={scopedStats.positiveBalanceCount} icon={Activity} active={activeInsight === 'positive'} onClick={() => toggleInsight('positive')} />
        <button
          type="button"
          onClick={() => toggleInsight('pending')}
          aria-pressed={activeInsight === 'pending'}
          className={`min-h-[76px] cursor-pointer rounded-md border px-3 py-3 text-left transition duration-200 hover:border-primary/60 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 ${
            activeInsight === 'pending' ? 'border-primary/80 bg-muted/50' : 'border-border/70 bg-muted/25'
          }`}
        >
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>充值中</span>
            <ArrowDownCircle className="h-4 w-4 text-primary" />
          </div>
          <div className="mt-3 font-mono text-lg font-semibold tabular-nums text-foreground">{pending}</div>
          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
            <span>已扫描 {pendingCounts.scanned}</span>
            <span>确认中 {pendingCounts.confirming}</span>
            <span>等待入账 {pendingCounts.finalizing}</span>
          </div>
        </button>
      </div>

      {activeInsight && (
        <AssetInsightPanel
          activeInsight={activeInsight}
          balances={scopedBalances}
          details={scopedDetails}
          pendingDeposits={pendingDeposits}
        />
      )}

      <div className="grid border-t border-border/70 md:grid-cols-2">
        <div className="flex items-center gap-3 px-4 py-3">
          <ArrowUpCircle className="h-5 w-5 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">近期提现</p>
            <p className="text-xs text-muted-foreground">最近已确认 {approx.todayWithdrawApproxCount} 笔</p>
          </div>
        </div>
        <div className="flex items-center gap-3 border-t border-border/70 px-4 py-3 md:border-l md:border-t-0">
          <Wallet className="h-5 w-5 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">提现风控</p>
            <p className="mt-0.5 inline-flex items-center gap-1 text-xs text-muted-foreground">
              <AlertTriangle className="h-4 w-4" />
              大额提现可能进入额外审核
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
