import { WalletAddressResponse } from '@/types/api/wallet';
import { Surface } from '@/components/ui/surface';
import { Button } from '@/components/ui/button';
import { Clipboard } from 'lucide-react';

export function ChainAddressList({
  evmAddress,
  solanaAddress,
  btcAddress,
  onRefresh
}: {
  evmAddress?: WalletAddressResponse;
  solanaAddress?: WalletAddressResponse;
  btcAddress?: WalletAddressResponse;
  onRefresh: (chainType: 'evm' | 'solana' | 'btc') => void;
}) {
  const list: Array<{ chain: string; type: 'evm' | 'solana' | 'btc'; data?: WalletAddressResponse }> = [
    { chain: 'EVM', type: 'evm', data: evmAddress },
    { chain: 'Solana', type: 'solana', data: solanaAddress },
    { chain: 'BTC', type: 'btc', data: btcAddress }
  ];

  return (
    <Surface title="充值地址" subtitle="复制地址前请核对网络">
      <div className="grid gap-3">
        {list.map((item) => (
          <div
            key={item.type}
            className="rounded-lg border border-border/60 p-3"
          >
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">{item.chain}</div>
              <Button
                variant="outline"
                onClick={() => onRefresh(item.type)}
                type="button"
              >
                刷新
              </Button>
            </div>
            {item.data ? (
              <div className="mt-2 flex items-center justify-between gap-3">
                <div className="text-xs text-muted-foreground break-all">{item.data.address}</div>
                <button
                  className="inline-flex items-center rounded-md border border-border px-2 py-1 text-xs"
                  onClick={async () => {
                    await navigator.clipboard.writeText(item.data?.address || '');
                  }}
                  title="复制地址"
                  aria-label="复制地址"
                  type="button"
                >
                  <Clipboard className="h-3 w-3" />
                </button>
              </div>
            ) : (
              <div className="mt-2 text-sm text-muted-foreground">未创建地址</div>
            )}
          </div>
        ))}
      </div>
    </Surface>
  );
}
