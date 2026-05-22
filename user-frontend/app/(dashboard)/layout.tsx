import { PropsWithChildren } from 'react';
import { SidebarShell } from '@/components/dashboard/layout';
import { SessionGate } from '@/lib/auth/session-guard';

export default function DashboardLayout({ children }: PropsWithChildren) {
  return (
    <SidebarShell>
      <SessionGate>{children}</SessionGate>
    </SidebarShell>
  );
}
