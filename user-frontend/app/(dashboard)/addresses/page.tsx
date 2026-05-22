'use client';

import { useMemo } from 'react';

import { useUserSession } from '@/lib/auth/user-session-context';
import { useWalletAddress } from '@/lib/hooks/use-wallet';
import { ChainAddressList } from '@/components/deposit/chain-addresses';
import { Surface } from '@/components/ui/surface';
import { LoadingState } from '@/components/ui/loading';
import { ErrorSummary } from '@/components/dashboard/error-summary';

export default function AddressesPage() {
  const { userId } = useUserSession();

  const evmQuery = useWalletAddress(userId, 'evm');
  const solanaQuery = useWalletAddress(userId, 'solana');
  const btcQuery = useWalletAddress(userId, 'btc');

  const isLoading = evmQuery.isLoading || solanaQuery.isLoading || btcQuery.isLoading;

  const count = useMemo(() => {
    const list = [evmQuery.data, solanaQuery.data, btcQuery.data];
    return list.filter(Boolean).length;
  }, [evmQuery.data, solanaQuery.data, btcQuery.data]);

  if (!userId) {
    return null;
  }

  return (
    <div className="grid gap-4">
      <Surface title="地址管理" subtitle="查看各网络充值地址">
        <p className="text-sm text-muted-foreground">
          每个网络使用独立地址。充值前请确认网络、币种和地址完全匹配。
        </p>
      </Surface>

      {isLoading ? <LoadingState label="加载地址中..." /> : null}

      <ErrorSummary
        message={
          evmQuery.isError || solanaQuery.isError || btcQuery.isError
            ? '部分链地址读取失败，请尝试刷新对应链'
            : ''
        }
      />

      <ChainAddressList
        evmAddress={evmQuery.data}
        solanaAddress={solanaQuery.data}
        btcAddress={btcQuery.data}
        onRefresh={(type) => {
          if (type === 'evm') void evmQuery.refetch();
          if (type === 'solana') void solanaQuery.refetch();
          if (type === 'btc') void btcQuery.refetch();
        }}
      />

      <Surface title="地址统计" subtitle="三条主链">
        <p className="text-sm text-muted-foreground">已返回地址数：{count} / 3</p>
      </Surface>
    </div>
  );
}
