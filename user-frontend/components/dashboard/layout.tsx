'use client';

import Link from 'next/link';
import { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CircleUserRound,
  History,
  LayoutDashboard,
  LogOut,
  MapPin,
  Coins,
  ShieldCheck,
  UserRound,
  Wallet
} from 'lucide-react';
import { useUserSession } from '@/lib/auth/user-session-context';
import { canAccessRiskControl } from '@/lib/auth/roles';
import { formatAddress } from '@/lib/format/address';
import { Button } from '@/components/ui/button';

const NAV_ITEMS = [
  { label: '总览', href: '/dashboard', icon: LayoutDashboard },
  { label: '充值', href: '/deposit', icon: ArrowDownToLine },
  { label: '提现', href: '/withdraw', icon: ArrowUpFromLine },
  { label: '记录', href: '/records', icon: History },
  { label: '地址', href: '/addresses', icon: MapPin },
  { label: '代币', href: '/tokens', icon: Coins },
  { label: '风控', href: '/risk-control', icon: ShieldCheck },
  { label: '账户', href: '/profile', icon: CircleUserRound }
];

export function SidebarShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { user, wallet, logout, isAuthenticated } = useUserSession();
  const navItems = NAV_ITEMS.filter((item) => {
    if (item.href === '/risk-control' || item.href === '/tokens') return canAccessRiskControl(user);
    return true;
  });

  return (
    <div className="page-shell">
      <div className="app-shell">
        <header className="sticky top-0 z-20 mb-4 border-b border-border bg-background/95 py-3 backdrop-blur-xl">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-foreground text-background">
                <Wallet className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <strong className="text-base font-semibold tracking-normal">CEX</strong>
                  <span className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground">
                    Exchange
                  </span>
                </div>
                <p className="truncate text-xs text-muted-foreground">资产、充值、提现与记录</p>
              </div>
            </div>

            {isAuthenticated && user ? (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="min-w-0 rounded-lg border border-border bg-card px-3 py-2 text-sm">
                  <div className="flex items-center gap-3 text-foreground">
                    <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-foreground text-background">
                      <UserRound className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="truncate font-medium">{user.username}</div>
                      <div className="truncate text-xs text-muted-foreground">{user.email || '未绑定邮箱'}</div>
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 pl-11 text-xs text-muted-foreground">
                    <span>EVM: {wallet?.address ? formatAddress(wallet.address) : '创建中'}</span>
                  </div>
                </div>
                <Button variant="outline" onClick={logout} className="gap-2">
                  <LogOut className="h-4 w-4" />
                  登出
                </Button>
              </div>
            ) : null}
          </div>
        </header>

        <div className="grid gap-4 lg:grid-cols-[224px,1fr]">
          <aside className="h-fit rounded-lg border border-border bg-card p-3">
            <nav className="grid gap-1">
              {navItems.map((item) => {
                const active = pathname === item.href;
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`flex h-10 items-center gap-2 rounded-md px-3 text-sm font-medium transition duration-200 ${
                      active
                        ? 'bg-foreground text-background'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </aside>

          <main className="min-w-0">{children}</main>
        </div>
      </div>
    </div>
  );
}
