import { WithdrawItem } from '@/types/api/wallet';
import { Surface } from '@/components/ui/surface';
import { ErrorState } from '@/components/ui/loading';
import { StatusBadge } from '@/components/withdraw/status-badge';
import { shortenText, formatCurrencyAmount } from '@/lib/format/number';
import { getWithdrawStatusMeta } from '@/types/domain/withdraw';

export function WithdrawRecordsTable({
  items,
  isLoading,
  isError,
  error
}: {
  items: WithdrawItem[];
  isLoading: boolean;
  isError: boolean;
  error?: Error | null;
}) {
  if (isLoading) {
    return <div className="text-sm text-muted-foreground">加载中...</div>;
  }

  if (isError) {
    return <ErrorState message={error?.message || '加载提现记录失败'} />;
  }

  if (items.length === 0) {
    return <div className="text-sm text-muted-foreground">暂无记录</div>;
  }

  return (
    <Surface title="提现列表" subtitle="最近提交的提现请求">
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="pb-2 pr-3">ID</th>
              <th className="pb-2 pr-3">状态</th>
              <th className="pb-2 pr-3">地址</th>
              <th className="pb-2 pr-3">金额</th>
              <th className="pb-2 pr-3">链/类型</th>
              <th className="pb-2">时间</th>
            </tr>
          </thead>
          <tbody className="text-foreground">
            {items.map((item) => {
              const badge = getWithdrawStatusMeta(item.status);
              return (
                <tr key={item.id} className="border-t border-border/50">
                  <td className="py-2 pr-3">#{item.id}</td>
                  <td className="py-2 pr-3">
                    <StatusBadge label={badge.label} tone={badge.tone} />
                  </td>
                  <td className="py-2 pr-3">{shortenText(item.to_address, 10, 6)}</td>
                  <td className="py-2 pr-3">{formatCurrencyAmount(item.amount)}</td>
                  <td className="py-2 pr-3">{item.chain_type?.toUpperCase()} / chainId {item.chain_id}</td>
                  <td className="py-2">{new Date(item.created_at).toLocaleString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Surface>
  );
}
