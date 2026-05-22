'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock3, Play, Plus, RefreshCw, ShieldAlert, ShieldCheck, UserCog, XCircle } from 'lucide-react';

import { useUserSession } from '@/lib/auth/user-session-context';
import { canAccessRiskControl, canManageUserTypes } from '@/lib/auth/roles';
import {
  useAddressRisks,
  useCreateAddressRisk,
  usePendingRiskReviews,
  useRiskAdminUsers,
  useSubmitManualReview,
  useUpdateAddressRiskEnabled,
  useUpdateRiskAdminUserType,
  useUpdateWithdrawRiskRule,
  useWithdrawRiskRules
} from '@/lib/hooks/use-risk-admin';
import { useEvmNonceDiagnostics, useRetryWithdrawBroadcast } from '@/lib/hooks/use-wallet';
import type { AddressRisk, AdminUserType, PendingRiskReview, RiskAdminUser, WithdrawRiskRule } from '@/types/api/risk';
import type { EvmNonceDiagnostic, EvmNonceDiagnosticWithdraw } from '@/types/api/wallet';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingState } from '@/components/ui/loading';
import { StatusBadge } from '@/components/ui/badge';
import { Surface } from '@/components/ui/surface';
import { TextField } from '@/components/ui/text-field';

const riskTone: Record<string, 'default' | 'success' | 'warning' | 'danger'> = {
  low: 'success',
  medium: 'warning',
  high: 'warning',
  critical: 'danger',
  blacklist: 'danger',
  sanctioned: 'danger',
  suspicious: 'warning',
  whitelist: 'success'
};

const adminUserTypeOptions: { value: AdminUserType; label: string }[] = [
  { value: 'normal', label: '普通用户' },
  { value: 'customer_service', label: '客服' },
  { value: 'risk_operator', label: '风控运营' },
  { value: 'support', label: '支持人员' },
  { value: 'admin', label: '管理员' },
  { value: 'sys_admin', label: '系统管理员' }
];

function getUserTypeLabel(userType: string) {
  return adminUserTypeOptions.find((item) => item.value === userType)?.label || userType;
}

function formatScope(rule: WithdrawRiskRule) {
  const parts = [
    rule.chain_type?.toUpperCase() || '全部链',
    rule.chain_id ? `chain ${rule.chain_id}` : null,
    rule.token_symbol || (rule.token_id ? `token ${rule.token_id}` : '全部代币')
  ].filter(Boolean);
  return parts.join(' / ');
}

function getOperationAmount(review: PendingRiskReview) {
  const amount = review.operation_data.amount;
  return typeof amount === 'string' || typeof amount === 'number' ? String(amount) : '--';
}

function getReviewTarget(review: PendingRiskReview) {
  const to = review.operation_data.to || review.operation_data.to_address;
  return typeof to === 'string' ? to : '--';
}

function formatShortAddress(value?: string | null) {
  if (!value) return '--';
  if (value.length <= 14) return value;
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function NonceWithdrawRow({
  item,
  mode,
  onRetry,
  isRetrying
}: {
  item: EvmNonceDiagnosticWithdraw;
  mode: 'blocking' | 'queued';
  onRetry?: (withdrawId: number) => void;
  isRetrying?: boolean;
}) {
  return (
    <tr className="border-t border-border/50 align-top">
      <td className="px-3 py-3">
        <div className="font-mono text-xs">#{item.id}</div>
        <div className="mt-1 text-xs text-muted-foreground">用户 {item.user_id}</div>
      </td>
      <td className="px-3 py-3">
        <StatusBadge
          label={mode === 'blocking' ? item.status : '待广播'}
          tone={mode === 'blocking' ? 'warning' : 'default'}
        />
      </td>
      <td className="px-3 py-3 font-mono text-xs tabular-nums">{item.nonce ?? '--'}</td>
      <td className="px-3 py-3">
        <div className="font-mono text-xs tabular-nums">{item.amount}</div>
        <div className="mt-1 text-xs text-muted-foreground">{item.token_symbol || `token ${item.token_id}`}</div>
      </td>
      <td className="max-w-[220px] px-3 py-3">
        <div className="truncate font-mono text-xs" title={item.to_address}>{formatShortAddress(item.to_address)}</div>
        {item.tx_hash ? (
          <div className="mt-1 truncate font-mono text-xs text-muted-foreground" title={item.tx_hash}>{formatShortAddress(item.tx_hash)}</div>
        ) : null}
      </td>
      <td className="max-w-[280px] px-3 py-3">
        <div className="line-clamp-2 text-xs text-muted-foreground" title={item.error_message || ''}>{item.error_message || '--'}</div>
      </td>
      {mode === 'queued' ? (
        <td className="px-3 py-3">
          <Button
            className="h-9 gap-2 px-3"
            disabled={isRetrying}
            variant="outline"
            onClick={() => onRetry?.(item.id)}
          >
            <Play className="h-4 w-4" />
            重试
          </Button>
        </td>
      ) : null}
    </tr>
  );
}

function NonceDiagnosticCard({ item }: { item: EvmNonceDiagnostic }) {
  const retryBroadcast = useRetryWithdrawBroadcast();
  const isBlocked = item.state === 'skip' || item.state === 'diagnostic' || item.state === 'error';

  return (
    <div className="rounded-lg border border-border bg-background p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-mono text-sm font-semibold">{formatShortAddress(item.address)}</h3>
            <StatusBadge
              label={item.state === 'ready' ? '可广播' : item.state === 'error' ? '诊断失败' : 'nonce 堵塞'}
              tone={item.state === 'ready' ? 'success' : 'warning'}
            />
            <span className="text-xs text-muted-foreground">chain {item.chainId}</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
            <span>链上 pending nonce: <b className="text-foreground">{item.chainPendingNonce ?? '--'}</b></span>
            <span>本地 DB nonce: <b className="text-foreground">{item.dbNonce}</b></span>
            <span>阻塞提现: <b className="text-foreground">{item.openWithdraws.length}</b></span>
            <span>排队提现: <b className="text-foreground">{item.queuedWithdraws.length}</b></span>
          </div>
        </div>
        {isBlocked ? <StatusBadge label="需要人工收口" tone="danger" /> : null}
      </div>

      {(item.reason || item.error) ? (
        <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
          {item.reason || item.error}
        </div>
      ) : null}

      <div className="mt-3 grid gap-2 text-sm text-muted-foreground">
        {item.suggestedActions.map((action) => (
          <div key={action} className="flex gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <span>{action}</span>
          </div>
        ))}
      </div>

      {item.openWithdraws.length > 0 ? (
        <div className="mt-4">
          <div className="mb-2 text-sm font-medium">阻塞提现</div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 pb-2">提现</th>
                  <th className="px-3 pb-2">状态</th>
                  <th className="px-3 pb-2">nonce</th>
                  <th className="px-3 pb-2">金额</th>
                  <th className="px-3 pb-2">目标/哈希</th>
                  <th className="px-3 pb-2">信息</th>
                </tr>
              </thead>
              <tbody>{item.openWithdraws.map((withdraw) => <NonceWithdrawRow key={withdraw.id} item={withdraw} mode="blocking" />)}</tbody>
            </table>
          </div>
        </div>
      ) : null}

      {item.queuedWithdraws.length > 0 ? (
        <div className="mt-4">
          <div className="mb-2 text-sm font-medium">待广播排队</div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 pb-2">提现</th>
                  <th className="px-3 pb-2">状态</th>
                  <th className="px-3 pb-2">nonce</th>
                  <th className="px-3 pb-2">金额</th>
                  <th className="px-3 pb-2">目标/哈希</th>
                  <th className="px-3 pb-2">信息</th>
                  <th className="px-3 pb-2">处理</th>
                </tr>
              </thead>
              <tbody>
                {item.queuedWithdraws.map((withdraw) => (
                  <NonceWithdrawRow
                    key={withdraw.id}
                    item={withdraw}
                    mode="queued"
                    isRetrying={retryBroadcast.isPending}
                    onRetry={(withdrawId) => retryBroadcast.mutate(withdrawId)}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {retryBroadcast.isError ? <p className="mt-2 text-xs text-destructive">{retryBroadcast.error.message}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function NonceDiagnosticsPanel({ enabled }: { enabled: boolean }) {
  const diagnosticsQuery = useEvmNonceDiagnostics(enabled);
  const diagnostics = useMemo(() => diagnosticsQuery.data || [], [diagnosticsQuery.data]);
  const activeDiagnostics = diagnostics.filter((item) => item.openWithdraws.length > 0 || item.queuedWithdraws.length > 0 || item.state !== 'ready');

  return (
    <Surface title="提现广播队列" subtitle="查看热钱包 nonce 堵塞、阻塞提现和待广播排队提现">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-muted-foreground">
          有低 nonce 未收口时，新的提现会先排队；低 nonce 处理完成后再重试广播。
        </div>
        <Button className="h-9 gap-2 px-3" disabled={diagnosticsQuery.isFetching} variant="outline" onClick={() => void diagnosticsQuery.refetch()}>
          <RefreshCw className="h-4 w-4" />
          刷新
        </Button>
      </div>
      {diagnosticsQuery.isLoading ? <LoadingState label="加载 nonce 诊断..." /> : null}
      {diagnosticsQuery.isError ? <ErrorState message={diagnosticsQuery.error.message} /> : null}
      {!diagnosticsQuery.isLoading && activeDiagnostics.length === 0 ? (
        <div className="rounded-lg border border-border bg-background p-4 text-sm text-muted-foreground">
          暂无 nonce 堵塞或待广播排队提现。
        </div>
      ) : (
        <div className="grid gap-3">
          {activeDiagnostics.map((item) => <NonceDiagnosticCard key={`${item.address}-${item.chainId}`} item={item} />)}
        </div>
      )}
    </Surface>
  );
}

function RuleEditor({ rule }: { rule: WithdrawRiskRule }) {
  const updateRule = useUpdateWithdrawRiskRule();
  const [singleLimit, setSingleLimit] = useState(rule.single_withdraw_limit);
  const [dailyLimit, setDailyLimit] = useState(rule.daily_withdraw_limit);
  const [windowSeconds, setWindowSeconds] = useState(String(rule.frequency_window_seconds));
  const [maxCount, setMaxCount] = useState(String(rule.frequency_max_count));
  const [limitAction, setLimitAction] = useState<WithdrawRiskRule['limit_action']>(rule.limit_action);
  const [enabled, setEnabled] = useState(rule.enabled === 1);

  const changed =
    singleLimit !== rule.single_withdraw_limit ||
    dailyLimit !== rule.daily_withdraw_limit ||
    windowSeconds !== String(rule.frequency_window_seconds) ||
    maxCount !== String(rule.frequency_max_count) ||
    limitAction !== rule.limit_action ||
    enabled !== (rule.enabled === 1);

  return (
    <div className="rounded-lg border border-border bg-background p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{rule.name}</h3>
            <StatusBadge label={enabled ? '启用' : '停用'} tone={enabled ? 'success' : 'default'} />
            <StatusBadge label={rule.limit_action === 'reject' ? '超限拒绝' : '超限审核'} tone={rule.limit_action === 'reject' ? 'danger' : 'warning'} />
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{formatScope(rule)}</p>
        </div>
        <Button
          disabled={!changed || updateRule.isPending}
          onClick={() =>
            updateRule.mutate({
              id: rule.id,
              data: {
                single_withdraw_limit: singleLimit,
                daily_withdraw_limit: dailyLimit,
                frequency_window_seconds: Number(windowSeconds),
                frequency_max_count: Number(maxCount),
                limit_action: limitAction,
                enabled: enabled ? 1 : 0
              }
            })
          }
        >
          保存规则
        </Button>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <TextField label="单笔上限（最小单位）" value={singleLimit} onChange={setSingleLimit} />
        <TextField label="单日上限（最小单位）" value={dailyLimit} onChange={setDailyLimit} />
        <TextField label="频率窗口（秒）" value={windowSeconds} onChange={setWindowSeconds} type="number" />
        <TextField label="窗口最大次数" value={maxCount} onChange={setMaxCount} type="number" />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setLimitAction('manual_review')}
          className={`h-10 rounded-lg border px-3 text-sm transition ${
            limitAction === 'manual_review' ? 'border-foreground bg-foreground text-background' : 'border-border text-muted-foreground hover:bg-muted'
          }`}
        >
          超限进入人工审核
        </button>
        <button
          type="button"
          onClick={() => setLimitAction('reject')}
          className={`h-10 rounded-lg border px-3 text-sm transition ${
            limitAction === 'reject' ? 'border-foreground bg-foreground text-background' : 'border-border text-muted-foreground hover:bg-muted'
          }`}
        >
          超限直接拒绝
        </button>
        <label className="inline-flex h-10 items-center gap-2 rounded-lg border border-border px-3 text-sm">
          <input checked={enabled} onChange={(event) => setEnabled(event.target.checked)} type="checkbox" />
          规则启用
        </label>
      </div>

      {updateRule.isError ? <div className="mt-3"><ErrorState message={updateRule.error.message} /></div> : null}
    </div>
  );
}

function ReviewRow({ review }: { review: PendingRiskReview }) {
  const { user } = useUserSession();
  const submitReview = useSubmitManualReview();
  const [comment, setComment] = useState('');

  const submit = (approved: boolean) => {
    submitReview.mutate({
      operation_id: review.operation_id,
      approved,
      approver_user_id: user?.id || 0,
      approver_username: user?.username || 'admin',
      comment
    });
  };

  return (
    <tr className="border-t border-border/50 align-top">
      <td className="px-4 py-3">
        <div className="font-mono text-xs">{review.operation_id}</div>
        <div className="mt-1 text-xs text-muted-foreground">用户 {review.user_id || '--'}</div>
      </td>
      <td className="px-4 py-3">
        <StatusBadge label={review.risk_level} tone={riskTone[review.risk_level]} />
      </td>
      <td className="px-4 py-3 font-mono text-xs">{getOperationAmount(review)}</td>
      <td className="max-w-[260px] px-4 py-3">
        <div className="truncate font-mono text-xs" title={getReviewTarget(review)}>
          {getReviewTarget(review)}
        </div>
        <div className="mt-2 grid gap-1 text-xs text-muted-foreground">
          {review.reasons.map((reason) => (
            <span key={reason}>{reason}</span>
          ))}
        </div>
      </td>
      <td className="min-w-[220px] px-4 py-3">
        <input
          className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          placeholder="审核备注"
        />
        <div className="mt-2 flex gap-2">
          <Button className="h-9 gap-2 px-3" disabled={submitReview.isPending} onClick={() => submit(true)}>
            <CheckCircle2 className="h-4 w-4" />
            通过
          </Button>
          <Button className="h-9 gap-2 px-3" disabled={submitReview.isPending} variant="outline" onClick={() => submit(false)}>
            <XCircle className="h-4 w-4" />
            拒绝
          </Button>
        </div>
        {submitReview.isError ? <p className="mt-2 text-xs text-destructive">{submitReview.error.message}</p> : null}
      </td>
    </tr>
  );
}

function AddressRiskForm() {
  const createRisk = useCreateAddressRisk();
  const [address, setAddress] = useState('');
  const [reason, setReason] = useState('');
  const [chainType, setChainType] = useState<AddressRisk['chain_type']>('evm');
  const [riskType, setRiskType] = useState<AddressRisk['risk_type']>('suspicious');
  const [riskLevel, setRiskLevel] = useState<AddressRisk['risk_level']>('medium');

  return (
    <div className="rounded-lg border border-border bg-background p-4">
      <div className="grid gap-3 lg:grid-cols-[1.5fr,0.7fr,0.7fr,0.7fr]">
        <TextField label="地址" value={address} onChange={setAddress} placeholder="0x..." />
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">链类型</span>
          <select className="h-11 rounded-lg border border-border bg-background px-3" value={chainType} onChange={(event) => setChainType(event.target.value as AddressRisk['chain_type'])}>
            <option value="evm">EVM</option>
            <option value="solana">Solana</option>
            <option value="btc">BTC</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">风险类型</span>
          <select className="h-11 rounded-lg border border-border bg-background px-3" value={riskType} onChange={(event) => setRiskType(event.target.value as AddressRisk['risk_type'])}>
            <option value="suspicious">异常地址</option>
            <option value="blacklist">黑名单</option>
            <option value="sanctioned">制裁地址</option>
            <option value="whitelist">白名单</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">风险等级</span>
          <select className="h-11 rounded-lg border border-border bg-background px-3" value={riskLevel} onChange={(event) => setRiskLevel(event.target.value as AddressRisk['risk_level'])}>
            <option value="low">低</option>
            <option value="medium">中</option>
            <option value="high">高</option>
          </select>
        </label>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-[1fr,auto]">
        <TextField label="原因" value={reason} onChange={setReason} placeholder="链上异常、客服标记、外部名单等" />
        <div className="flex items-end">
          <Button
            className="w-full gap-2 md:w-auto"
            disabled={!address || createRisk.isPending}
            onClick={() => {
              createRisk.mutate(
                { address, chain_type: chainType, risk_type: riskType, risk_level: riskLevel, reason, source: 'manual', enabled: 1 },
                {
                  onSuccess: () => {
                    setAddress('');
                    setReason('');
                  }
                }
              );
            }}
          >
            <Plus className="h-4 w-4" />
            新增
          </Button>
        </div>
      </div>
      {createRisk.isError ? <div className="mt-3"><ErrorState message={createRisk.error.message} /></div> : null}
    </div>
  );
}

function UserPermissionRow({ item, currentUserId }: { item: RiskAdminUser; currentUserId?: number }) {
  const updateUserType = useUpdateRiskAdminUserType();
  const [userType, setUserType] = useState<AdminUserType>(item.user_type || 'normal');
  const changed = userType !== item.user_type;
  const isCurrentUser = currentUserId === item.id;

  return (
    <tr className="border-t border-border/50">
      <td className="px-4 py-3">
        <div className="font-medium">{item.username}</div>
        <div className="mt-1 text-xs text-muted-foreground">ID {item.id}</div>
      </td>
      <td className="max-w-[220px] truncate px-4 py-3 text-sm text-muted-foreground" title={item.email || ''}>
        {item.email || '--'}
      </td>
      <td className="px-4 py-3">
        <StatusBadge label={getUserTypeLabel(item.user_type)} tone={item.user_type === 'normal' ? 'default' : 'success'} />
      </td>
      <td className="px-4 py-3">
        <StatusBadge label={item.status === 0 ? '正常' : item.status === 1 ? '禁用' : '待审核'} tone={item.status === 0 ? 'success' : 'warning'} />
      </td>
      <td className="min-w-[180px] px-4 py-3">
        <select
          className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-50"
          value={userType}
          disabled={isCurrentUser || updateUserType.isPending}
          onChange={(event) => setUserType(event.target.value as AdminUserType)}
        >
          {adminUserTypeOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {isCurrentUser ? <p className="mt-1 text-xs text-muted-foreground">不能在这里修改当前登录账号</p> : null}
      </td>
      <td className="px-4 py-3">
        <Button
          className="h-9 gap-2 px-3"
          disabled={!changed || isCurrentUser || updateUserType.isPending}
          variant="outline"
          onClick={() => updateUserType.mutate({ userId: item.id, userType })}
        >
          <UserCog className="h-4 w-4" />
          保存
        </Button>
        {updateUserType.isError ? <p className="mt-2 text-xs text-destructive">{updateUserType.error.message}</p> : null}
      </td>
    </tr>
  );
}

function UserPermissionPanel({ enabled, currentUserId }: { enabled: boolean; currentUserId?: number }) {
  const usersQuery = useRiskAdminUsers(enabled);
  const users = useMemo(() => usersQuery.data || [], [usersQuery.data]);

  if (!enabled) {
    return null;
  }

  return (
    <Surface title="账号权限" subtitle="管理员可以把用户设为客服、风控运营或管理员，普通用户不会看到风控入口">
      {usersQuery.isLoading ? <LoadingState label="加载账号列表..." /> : null}
      {usersQuery.isError ? <ErrorState message={usersQuery.error.message} /> : null}
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr>
              <th className="px-4 pb-2">账号</th>
              <th className="px-4 pb-2">邮箱</th>
              <th className="px-4 pb-2">当前类型</th>
              <th className="px-4 pb-2">状态</th>
              <th className="px-4 pb-2">调整为</th>
              <th className="px-4 pb-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((item) => (
              <UserPermissionRow key={item.id} item={item} currentUserId={currentUserId} />
            ))}
          </tbody>
        </table>
      </div>
      {!usersQuery.isLoading && users.length === 0 ? (
        <div className="mt-3 text-sm text-muted-foreground">暂无账号数据</div>
      ) : null}
    </Surface>
  );
}

export default function RiskControlPage() {
  const { user, isLoading } = useUserSession();
  const canAccess = canAccessRiskControl(user);
  const canManageUsers = canManageUserTypes(user);
  const rulesQuery = useWithdrawRiskRules(canAccess);
  const addressesQuery = useAddressRisks(canAccess);
  const reviewsQuery = usePendingRiskReviews(canAccess);
  const toggleAddress = useUpdateAddressRiskEnabled();

  const rules = useMemo(() => rulesQuery.data || [], [rulesQuery.data]);
  const addresses = useMemo(() => addressesQuery.data || [], [addressesQuery.data]);
  const reviews = useMemo(() => reviewsQuery.data || [], [reviewsQuery.data]);

  const stats = useMemo(() => {
    return {
      pendingReviews: reviews.length,
      activeRules: rules.filter((rule) => rule.enabled === 1).length,
      hardBlocked: addresses.filter((item) => item.enabled === 1 && ['blacklist', 'sanctioned'].includes(item.risk_type)).length,
      suspicious: addresses.filter((item) => item.enabled === 1 && item.risk_type === 'suspicious').length
    };
  }, [addresses, reviews.length, rules]);

  if (isLoading) {
    return <LoadingState label="校验访问权限..." />;
  }

  if (!canAccess) {
    return (
      <Surface title="无权访问" subtitle="风控管理仅限客服、风控或管理员账号使用">
        <div className="rounded-lg border border-border bg-background p-4 text-sm text-muted-foreground">
          当前账号类型为 {user?.user_type || 'unknown'}，不能访问规则配置和人工审核业务。
        </div>
      </Surface>
    );
  }

  return (
    <div className="grid gap-5">
      <Surface title="风控管理" subtitle="配置提现规则、维护风险地址并处理人工审核">
        <div className="grid gap-3 md:grid-cols-4">
          <div className="rounded-lg border border-border bg-background p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Clock3 className="h-4 w-4" />待审核</div>
            <div className="mt-2 text-2xl font-semibold">{stats.pendingReviews}</div>
          </div>
          <div className="rounded-lg border border-border bg-background p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><ShieldCheck className="h-4 w-4" />启用规则</div>
            <div className="mt-2 text-2xl font-semibold">{stats.activeRules}</div>
          </div>
          <div className="rounded-lg border border-border bg-background p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><ShieldAlert className="h-4 w-4" />硬阻断地址</div>
            <div className="mt-2 text-2xl font-semibold">{stats.hardBlocked}</div>
          </div>
          <div className="rounded-lg border border-border bg-background p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><AlertTriangle className="h-4 w-4" />异常地址</div>
            <div className="mt-2 text-2xl font-semibold">{stats.suspicious}</div>
          </div>
        </div>
      </Surface>

      <UserPermissionPanel enabled={canManageUsers} currentUserId={user?.id} />

      <NonceDiagnosticsPanel enabled={canAccess} />

      <Surface title="提现规则" subtitle="金额和频率超限默认进入人工审核">
        {rulesQuery.isLoading ? <LoadingState label="加载规则..." /> : null}
        {rulesQuery.isError ? <ErrorState message={rulesQuery.error.message} /> : null}
        <div className="grid gap-3">
          {rules.map((rule) => <RuleEditor key={rule.id} rule={rule} />)}
        </div>
      </Surface>

      <Surface title="人工审核" subtitle="客服或运营处理需要复核的提现请求">
        {reviewsQuery.isLoading ? <LoadingState label="加载待审核记录..." /> : null}
        {reviewsQuery.isError ? <ErrorState message={reviewsQuery.error.message} /> : null}
        {!reviewsQuery.isLoading && reviews.length === 0 ? (
          <div className="text-sm text-muted-foreground">暂无待审核提现</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 pb-2">操作</th>
                  <th className="px-4 pb-2">风险</th>
                  <th className="px-4 pb-2">金额</th>
                  <th className="px-4 pb-2">目标与原因</th>
                  <th className="px-4 pb-2">处理</th>
                </tr>
              </thead>
              <tbody>{reviews.map((review) => <ReviewRow key={review.operation_id} review={review} />)}</tbody>
            </table>
          </div>
        )}
      </Surface>

      <Surface title="风险地址" subtitle="黑名单和制裁地址直接拒绝，异常地址进入人工审核">
        <AddressRiskForm />
        {addressesQuery.isLoading ? <div className="mt-4"><LoadingState label="加载风险地址..." /></div> : null}
        {addressesQuery.isError ? <div className="mt-4"><ErrorState message={addressesQuery.error.message} /></div> : null}
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="px-4 pb-2">地址</th>
                <th className="px-4 pb-2">链</th>
                <th className="px-4 pb-2">类型</th>
                <th className="px-4 pb-2">等级</th>
                <th className="px-4 pb-2">原因</th>
                <th className="px-4 pb-2">状态</th>
                <th className="px-4 pb-2">操作</th>
              </tr>
            </thead>
            <tbody>
              {addresses.map((item) => (
                <tr key={item.id} className="border-t border-border/50">
                  <td className="max-w-[280px] truncate px-4 py-3 font-mono text-xs" title={item.address}>{item.address}</td>
                  <td className="px-4 py-3">{item.chain_type.toUpperCase()}</td>
                  <td className="px-4 py-3"><StatusBadge label={item.risk_type} tone={riskTone[item.risk_type]} /></td>
                  <td className="px-4 py-3"><StatusBadge label={item.risk_level} tone={riskTone[item.risk_level]} /></td>
                  <td className="max-w-[260px] truncate px-4 py-3 text-muted-foreground" title={item.reason || ''}>{item.reason || '--'}</td>
                  <td className="px-4 py-3"><StatusBadge label={item.enabled ? '启用' : '停用'} tone={item.enabled ? 'success' : 'default'} /></td>
                  <td className="px-4 py-3">
                    <Button
                      className="h-9 px-3"
                      disabled={toggleAddress.isPending}
                      variant="outline"
                      onClick={() => toggleAddress.mutate({ id: item.id, enabled: item.enabled ? 0 : 1 })}
                    >
                      {item.enabled ? '停用' : '启用'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Surface>
    </div>
  );
}
