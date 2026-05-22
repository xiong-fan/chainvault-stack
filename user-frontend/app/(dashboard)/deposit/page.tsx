'use client';

import { useState } from 'react';
import { RefreshCcw, WalletCards } from 'lucide-react';

import { Surface } from '@/components/ui/surface';
import { Button } from '@/components/ui/button';
import { ChainAddressList } from '@/components/deposit/chain-addresses';
import { DepositPendingList } from '@/components/deposit/recent-deposits';
import { ErrorState, LoadingState } from '@/components/ui/loading';
import { useUserSession } from '@/lib/auth/user-session-context';
import { usePendingDeposits, useWalletAddress } from '@/lib/hooks/use-wallet';
import { CHAIN_OPTIONS, formatChainTypeLabel } from '@/lib/chains';
import { SupportedChainType } from '@/lib/types';

export default function DepositPage() {
  const { userId } = useUserSession();
  const [activeChain, setActiveChain] = useState<SupportedChainType>('evm');

  const evmQuery = useWalletAddress(userId, 'evm');
  const solanaQuery = useWalletAddress(userId, 'solana');
  const btcQuery = useWalletAddress(userId, 'btc');
  const pendingQuery = usePendingDeposits(userId);

  const activeAddress =
    activeChain === 'evm' ? evmQuery : activeChain === 'solana' ? solanaQuery : btcQuery;

  if (!userId) {
    return null;
  }

  return (
    <div className="grid gap-5">
      <Surface title="充值" subtitle="选择网络并复制你的专属充值地址">
        <p className="text-sm text-muted-foreground">
          请确认转账网络与充值地址一致。转错网络可能导致资产无法找回。
        </p>
      </Surface>

      <Surface title="选择链" subtitle="EVM / Solana / BTC">
        <div className="grid gap-2">
          <div className="flex gap-2 flex-wrap">
            {CHAIN_OPTIONS.map((item) => (
              <Button
                key={item.value}
                variant={activeChain === item.value ? 'solid' : 'outline'}
                onClick={() => setActiveChain(item.value)}
                type="button"
              >
                {formatChainTypeLabel(item.value)} ({item.chainId})
              </Button>
            ))}
          </div>

          <div className="rounded-lg border border-border/60 p-3 text-sm">
            {activeAddress.isLoading || activeAddress.isFetching ? (
              <LoadingState label={`加载 ${formatChainTypeLabel(activeChain)} 地址...`} />
            ) : activeAddress.isError ? (
              <ErrorState message={activeAddress.error?.message || '地址加载失败'} />
            ) : activeAddress.data ? (
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-muted-foreground">{formatChainTypeLabel(activeChain)} 地址</p>
                  <p className="break-all text-sm font-mono">{activeAddress.data.address}</p>
                </div>
                <Button
                  onClick={() => {
                    void navigator.clipboard.writeText(activeAddress.data?.address || '');
                  }}
                  type="button"
                >
                  复制地址
                </Button>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">未获取到地址</div>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              className="inline-flex h-10 items-center justify-center rounded-lg border border-border text-sm font-medium hover:bg-muted"
              onClick={() => void activeAddress.refetch()}
            >
              <RefreshCcw className="mr-2 h-4 w-4" />
              刷新当前链地址
            </button>
            <button
              type="button"
              className="inline-flex h-10 items-center justify-center rounded-lg border border-border text-sm font-medium hover:bg-muted"
              onClick={() => void pendingQuery.refetch()}
            >
              <WalletCards className="mr-2 h-4 w-4" />
              刷新充值快照
            </button>
          </div>
        </div>
      </Surface>

      <ChainAddressList
        evmAddress={evmQuery.data}
        solanaAddress={solanaQuery.data}
        btcAddress={btcQuery.data}
        onRefresh={(chainType) => {
          if (chainType === 'evm') void evmQuery.refetch();
          if (chainType === 'solana') void solanaQuery.refetch();
          if (chainType === 'btc') void btcQuery.refetch();
        }}
      />

      <Surface title="充值说明" subtitle="入金确认后会更新账户余额">
        <p className="text-sm text-muted-foreground">
          不同网络确认速度不同。提交转账后，请在充值汇总和交易记录中查看状态变化。
        </p>
      </Surface>

      {pendingQuery.isLoading || pendingQuery.isFetching ? (
        <LoadingState label="加载充值快照..." />
      ) : pendingQuery.isError ? (
        <ErrorState message={pendingQuery.error?.message || '加载充值快照失败'} />
      ) : (
        <DepositPendingList items={pendingQuery.data || []} />
      )}
    </div>
  );
}
