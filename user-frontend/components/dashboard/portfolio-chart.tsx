'use client';

import dynamic from 'next/dynamic';
import { useMemo } from 'react';
import { TokenBalanceItem } from '@/types/api/wallet';
import { Surface } from '@/components/ui/surface';

const EChartsReact = dynamic(() => import('echarts-for-react'), {
  ssr: false,
  loading: () => <div className="text-sm text-muted-foreground">图表加载中...</div>
});

function chartItemLabel(item: TokenBalanceItem, scopedBySymbol: boolean) {
  if (!scopedBySymbol) return item.token_symbol;
  if (!item.chain_type && !item.chain_id) return '未知网络';
  return `${item.chain_type ? item.chain_type.toUpperCase() : 'UNKNOWN'}${item.chain_id ? ` ${item.chain_id}` : ''}`;
}

function buildChartData(tokens: TokenBalanceItem[], scopedBySymbol: boolean) {
  const map = new Map<string, number>();

  tokens
    .filter((item) => Number.parseFloat(item.total_balance || '0') > 0)
    .forEach((item) => {
      const label = chartItemLabel(item, scopedBySymbol);
      const value = Number.parseFloat(item.total_balance || '0');
      map.set(label, (map.get(label) || 0) + value);
    });

  return Array.from(map.entries()).map(([name, value]) => ({ name, value }));
}

export function DashboardPortfolioChart({
  balances,
  loading,
  error,
  selectedAssetSymbol = 'ALL'
}: {
  balances?: TokenBalanceItem[];
  loading: boolean;
  error?: string;
  selectedAssetSymbol?: string;
}) {
  const isScoped = selectedAssetSymbol !== 'ALL';
  const data = useMemo(() => buildChartData(balances || [], isScoped), [balances, isScoped]);

  const options = useMemo(() => ({
    tooltip: {
      trigger: 'item',
      formatter: '{b}: {c}'
    },
    legend: {
      type: 'scroll',
      orient: 'horizontal',
      bottom: 0,
      textStyle: { color: 'inherit' }
    },
    series: [
      {
        type: 'pie',
        radius: ['35%', '72%'],
        avoidLabelOverlap: false,
        itemStyle: {
          borderRadius: 6
        },
        label: {
          show: true,
          formatter: '{b}: {d}%'
        },
        data
      }
    ]
  }), [data]);

  return (
    <Surface
      title={isScoped ? `${selectedAssetSymbol} 分布` : '资产分布'}
      subtitle={isScoped ? '按网络查看该币种余额' : '按币种查看账户占比'}
    >
      {loading ? (
        <div className="text-sm text-muted-foreground">加载中...</div>
      ) : error ? (
        <div className="text-sm text-destructive">{error}</div>
      ) : data.length === 0 ? (
        <div className="text-sm text-muted-foreground">暂无可展示的资产分布</div>
      ) : (
        <div className="h-80">
          <EChartsReact option={options} style={{ width: '100%', height: '100%' }} />
        </div>
      )}
    </Surface>
  );
}
