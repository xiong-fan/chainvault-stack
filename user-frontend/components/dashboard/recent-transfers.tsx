import Link from 'next/link';
import { WithdrawItem } from '@/types/api/wallet';
import { Surface } from '@/components/ui/surface';
import { shortenText, formatCurrencyAmount } from '@/lib/format/number';
import { StatusBadge } from '@/components/withdraw/status-badge';
import { getWithdrawStatusMeta } from '@/types/domain/withdraw';

export function RecentTransfers({ withdraws, isLoading }: { withdraws: WithdrawItem[]; isLoading: boolean }) {
  return (
    <Surface title="最近提现" subtitle="跟踪提现处理状态">
      {isLoading ? (
        <div className="text-sm text-muted-foreground">加载中...</div>
      ) : withdraws.length === 0 ? (
        <div className="text-sm text-muted-foreground">暂无提现记录</div>
      ) : (
        <div className="grid gap-2">
          {withdraws.slice(0, 5).map((item) => {
            const status = getWithdrawStatusMeta(item.status);
            return (
              <Link
                href={`/records?withdrawId=${item.id}`}
                key={item.id}
                className="rounded-lg border border-border/60 p-3 hover:bg-muted/30"
              >
                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">提现 #{item.id}</span>
                    <StatusBadge label={status.label} tone={status.tone} />
                  </div>
                  <div className="text-xs text-muted-foreground">
                    目标地址: {shortenText(item.to_address, 10, 6)}
                  </div>
                  <div className="text-sm font-medium">
                    {formatCurrencyAmount(item.amount)} {item.token_id ? '' : ''}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </Surface>
  );
}
