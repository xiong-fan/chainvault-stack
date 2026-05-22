'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';

import { useUserSession } from '@/lib/auth/user-session-context';
import { usePendingDeposits, useWithdrawList } from '@/lib/hooks/use-wallet';
import { ErrorState, LoadingState } from '@/components/ui/loading';
import { RecordsList } from '@/components/records/list';
import { Surface } from '@/components/ui/surface';
import { API_WITHDRAW_STATUS_FILTERS, WithdrawApiStatus, WITHDRAW_STATUS_META } from '@/types/domain/withdraw';

const RECORD_STATUS_OPTIONS: Array<'' | WithdrawApiStatus> = [''].concat(
  API_WITHDRAW_STATUS_FILTERS
) as Array<'' | WithdrawApiStatus>;

const LABELS: Record<string, string> = {
  '': '全部',
  ...Object.fromEntries(
    API_WITHDRAW_STATUS_FILTERS.map((value) => [value, WITHDRAW_STATUS_META[value].label])
  )
};

export default function RecordsPage() {
  const { userId } = useUserSession();
  const params = useSearchParams();
  const initStatus = params.get('status') || '';

  const safeInitStatus =
    initStatus && (API_WITHDRAW_STATUS_FILTERS as readonly string[]).includes(initStatus)
      ? (initStatus as '' | WithdrawApiStatus)
      : '';

  const [statusFilter, setStatusFilter] = useState<'' | WithdrawApiStatus>(safeInitStatus);
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(0);
  const limit = 10;

  const pendingDepositsQuery = usePendingDeposits(userId);
  const recordsQuery = useWithdrawList(
    userId,
    statusFilter
      ? {
          status: statusFilter,
          limit,
          offset: page * limit
        }
      : {
          limit,
          offset: page * limit
        }
  );

  const rowsRaw = recordsQuery.data?.withdraws || [];
  const pagination = recordsQuery.data?.pagination;

  const filteredRows = rowsRaw.filter((item) => {
    const q = keyword.trim().toLowerCase();
    if (!q) return true;
    return (
      String(item.id).includes(q) ||
      item.to_address.toLowerCase().includes(q) ||
      (item.tx_hash ?? '').toLowerCase().includes(q)
    );
  });

  return (
    <div className="grid gap-4">
      <Surface title="交易记录" subtitle="筛选并查看账户资金流动">
        <div className="text-sm text-muted-foreground">
          通过状态、提现 ID、目标地址或交易哈希快速定位记录。
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-[140px_1fr_auto]">
          <select
            value={statusFilter}
            onChange={(e) => {
              const next = (e.target.value || '') as '' | WithdrawApiStatus;
              setStatusFilter(next);
              setPage(0);
            }}
            className="h-10 rounded-lg border border-border bg-background px-3"
          >
            {RECORD_STATUS_OPTIONS.map((value) => (
              <option key={value || 'all'} value={value}>
                {LABELS[value]}
              </option>
            ))}
          </select>

          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索提现ID / 目标地址 / txHash"
            className="h-10 rounded-lg border border-border bg-background px-3 text-sm"
          />

          <div className="text-sm text-muted-foreground flex items-center">
            {pagination ? (
              <span>
                第 {pagination.offset + 1} - {Math.min(pagination.offset + pagination.limit, pagination.total)} 条 / 共 {pagination.total} 条
              </span>
            ) : null}
          </div>
        </div>
      </Surface>

      {recordsQuery.isLoading || recordsQuery.isFetching ? (
        <LoadingState label="加载交易记录..." />
      ) : recordsQuery.isError ? (
        <ErrorState message={recordsQuery.error?.message || '查询交易记录失败'} />
      ) : (
        <RecordsList
          rows={filteredRows}
          loading={false}
          error={undefined}
          pendingDeposits={pendingDepositsQuery.data || []}
          statusFilter={statusFilter || 'all'}
          keyword={keyword}
        />
      )}

      <div className="flex justify-between text-sm">
        <button
          type="button"
          onClick={() => setPage((prev) => Math.max(0, prev - 1))}
          disabled={page === 0}
          className="rounded-lg border border-border px-3 py-2 disabled:opacity-50"
        >
          上一页
        </button>
        <button
          type="button"
          onClick={() => {
            if (pagination?.hasMore) {
              setPage((prev) => prev + 1);
            }
          }}
          disabled={!pagination?.hasMore}
          className="rounded-lg border border-border px-3 py-2 disabled:opacity-50"
        >
          下一页
        </button>
      </div>
    </div>
  );
}
