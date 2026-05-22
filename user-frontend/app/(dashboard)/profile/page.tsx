'use client';

import { BadgeCheck, Clock, KeyRound, ShieldCheck } from 'lucide-react';
import { Surface } from '@/components/ui/surface';
import { Button } from '@/components/ui/button';
import { useUserSession } from '@/lib/auth/user-session-context';
import { formatAddress } from '@/lib/format/address';

function kycLabel(status?: number) {
  if (status === 2) return '已认证';
  if (status === 1) return '待审核';
  if (status === 3) return '认证失败';
  return '未认证';
}

export default function ProfilePage() {
  const { user, wallet, expiresAt, logout } = useUserSession();

  return (
    <div className="grid gap-4">
      <Surface title="账户信息" subtitle="登录资料与认证状态">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-lg border border-border bg-background/45 p-4">
            <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
              <ShieldCheck className="h-4 w-4 text-primary" />
              登录账号
            </div>
            <div className="text-lg font-semibold">{user?.username || '--'}</div>
            <div className="mt-1 text-sm text-muted-foreground">{user?.email || '未绑定邮箱'}</div>
          </div>

          <div className="rounded-lg border border-border bg-background/45 p-4">
            <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
              <BadgeCheck className="h-4 w-4 text-primary" />
              KYC 状态
            </div>
            <div className="text-lg font-semibold">{kycLabel(user?.kyc_status)}</div>
            <div className="mt-1 text-sm text-muted-foreground">用户类型：{user?.user_type || 'normal'}</div>
          </div>
        </div>
      </Surface>

      <Surface title="默认充值地址" subtitle="你的 EVM 入金地址">
        <div className="rounded-lg border border-border bg-background/45 p-4">
          <div className="text-sm text-muted-foreground">EVM 地址</div>
          <div className="mt-2 break-all font-mono text-sm text-foreground">{wallet?.address || '--'}</div>
          <div className="mt-2 text-xs text-muted-foreground">
            展示摘要：{wallet?.address ? formatAddress(wallet.address) : '--'}
          </div>
        </div>
      </Surface>

      <Surface title="会话状态" subtitle="当前浏览器登录状态">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="grid gap-2 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-primary" />
              会话已建立
            </div>
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-primary" />
              过期时间：{expiresAt ? new Date(expiresAt).toLocaleString() : '--'}
            </div>
          </div>
          <Button variant="outline" onClick={logout}>
            登出
          </Button>
        </div>
      </Surface>
    </div>
  );
}
