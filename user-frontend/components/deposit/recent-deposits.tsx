import { Surface } from '@/components/ui/surface';
import { PendingDepositItem } from '@/types/api/wallet';

function chainLabel(chainType?: string | null, chainId?: number | null) {
  if (!chainType && !chainId) return '--';
  return `${chainType ? chainType.toUpperCase() : 'UNKNOWN'}${chainId ? ` ${chainId}` : ''}`;
}

function shortenHash(value: string) {
  if (!value) return '--';
  return value.length <= 18 ? value : `${value.slice(0, 10)}...${value.slice(-8)}`;
}

function progressText(item: PendingDepositItem) {
  const required = item.required_confirmations;
  if (item.latest_status === 'safe') {
    return required ? `确认中 ${item.latest_confirmation_count}/${required}` : '确认中';
  }
  return required ? `已扫描 ${item.latest_confirmation_count}/${required}` : '已扫描';
}

export function DepositPendingList({
  items
}: {
  items: PendingDepositItem[];
}) {
  return (
    <Surface title="充值汇总" subtitle="等待确认的入金记录">
      {items.length === 0 ? (
        <div className="text-sm text-muted-foreground">暂无正在充值中的记录</div>
      ) : (
        <div className="grid gap-3">
          {items.map((item, idx) => (
            <div key={`${item.chain_type || 'unknown'}-${item.chain_id || 'unknown'}-${item.token_id}-${idx}`} className="rounded-md border border-border/60 px-3 py-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{item.token_symbol}</span>
                    <span className="rounded-md border border-border/60 px-2 py-0.5 text-xs text-muted-foreground">
                      {chainLabel(item.chain_type, item.chain_id)}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    已扫描 {item.scanned_count} · 确认中 {item.confirming_count + item.safe_count} · 等待最终入账 {item.transaction_count}
                  </div>
                </div>
                <div className="text-left sm:text-right">
                  <div className="font-mono text-sm font-semibold tabular-nums">{item.pending_amount}</div>
                  <div className="text-xs text-muted-foreground">{progressText(item)}</div>
                </div>
              </div>

              <div className="mt-3 overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead className="text-left text-muted-foreground">
                    <tr>
                      <th className="py-1 pr-3 font-medium">交易</th>
                      <th className="py-1 pr-3 font-medium">金额</th>
                      <th className="py-1 pr-3 font-medium">阶段</th>
                      <th className="py-1 pr-3 font-medium">确认数</th>
                    </tr>
                  </thead>
                  <tbody>
                    {item.deposits.map((deposit) => (
                      <tr key={`${deposit.tx_hash}-${deposit.block_number || 'block'}`} className="border-t border-border/40">
                        <td className="py-1.5 pr-3 font-mono tabular-nums">{shortenHash(deposit.tx_hash)}</td>
                        <td className="py-1.5 pr-3 font-mono tabular-nums">{deposit.amount}</td>
                        <td className="py-1.5 pr-3">{deposit.progress_label}</td>
                        <td className="py-1.5 pr-3 font-mono tabular-nums">
                          {deposit.required_confirmations ? `${deposit.confirmation_count}/${deposit.required_confirmations}` : deposit.confirmation_count}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">最终入账后会计入可用余额；确认策略保持当前链上最终确认逻辑。</p>
        </div>
      )}
    </Surface>
  );
}
