'use client';

import { PropsWithChildren, useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ShieldCheck } from 'lucide-react';
import { useUserSession } from './user-session-context';
import { LoadingState } from '@/components/ui/loading';

export function SessionGate({ children }: PropsWithChildren) {
  const { isAuthenticated, isLoading } = useUserSession();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
    }
  }, [isAuthenticated, isLoading, pathname, router]);

  if (isLoading) {
    return (
      <div className="grid min-h-[320px] place-items-center">
        <LoadingState label="校验账户会话..." />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="grid min-h-[320px] place-items-center rounded-lg border border-border bg-card/80 p-6 text-center">
        <ShieldCheck className="mx-auto mb-3 h-8 w-8 text-primary" />
        <h1 className="text-lg font-semibold">需要登录</h1>
        <p className="mt-2 text-sm text-muted-foreground">正在进入账户登录流程。</p>
      </div>
    );
  }

  return <>{children}</>;
}
