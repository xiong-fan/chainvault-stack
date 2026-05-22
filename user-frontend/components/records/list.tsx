import { WithdrawItem } from '@/types/api/wallet';
import { Surface } from '@/components/ui/surface';
import { StatusBadge } from '@/components/withdraw/status-badge';
import { ErrorState } from '@/components/ui/loading';
import { formatCurrencyAmount, shortenText } from '@/lib/format/number';
import { getWithdrawStatusMeta } from '@/types/domain/withdraw';

export function RecordsList({
  rows,
  loading,
  error,
  pendingDeposits,
  statusFilter,
  keyword
}: {
  rows: WithdrawItem[];
  loading: boolean;
  error?: Error | null;
  pendingDeposits: { token_symbol: string; pending_amount: string; transaction_count: number }[];
  statusFilter?: string;
  keyword?: string;
}) {
  if (loading) {
    return <div className="text-sm text-muted-foreground">加载中...</div>;
  }

  if (error) {
    return <ErrorState message={error.message || '获取记录失败'} />;
  }

  return (
    <div className="grid gap-4">
      <Surface title="记录筛选" subtitle="当前筛选条件">
        <p className="text-sm text-muted-foreground">
          状态：{statusFilter || '全部'}；关键词：{keyword || '未设置'}
        </p>
      </Surface>

      {pendingDeposits.length > 0 ? (
        <Surface title="充值中">
          <div className="grid gap-2">
            {pendingDeposits.map((item) => (
              <div key={item.token_symbol} className="rounded-lg border border-border/60 px-3 py-2">
                <div className="text-sm font-medium">{item.token_symbol}</div>
                <div className="text-xs text-muted-foreground">
                  {item.pending_amount} · {item.transaction_count} 笔
                </div>
              </div>
            ))}
          </div>
        </Surface>
      ) : null}

      <Surface title="提现记录" subtitle="按时间倒序展示">
        {rows.length === 0 ? (
          <div className="text-sm text-muted-foreground">暂无数据</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="pb-2 pr-3">ID</th>
                  <th className="pb-2 pr-3">状态</th>
                  <th className="pb-2 pr-3">类型</th>
                  <th className="pb-2 pr-3">金额</th>
                  <th className="pb-2 pr-3">地址</th>
                  <th className="pb-2 pr-3">错误信息</th>
                  <th className="pb-2">时间</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const status = getWithdrawStatusMeta(row.status);
                  return (
                    <tr key={row.id} className="border-t border-border/50">
                      <td className="py-2 pr-3">#{row.id}</td>
                      <td className="py-2 pr-3">
                        <StatusBadge label={status.label} tone={status.tone} />
                      </td>
                      <td className="py-2 pr-3">{status.label}</td>
                      <td className="py-2 pr-3">{formatCurrencyAmount(row.amount)}</td>
                      <td className="py-2 pr-3">{shortenText(row.to_address, 10, 6)}</td>
                      <td className="py-2 pr-3 text-rose-500">{row.error_message ?? '--'}</td>
                      <td className="py-2">{new Date(row.created_at).toLocaleString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Surface>
    </div>
  );
}
