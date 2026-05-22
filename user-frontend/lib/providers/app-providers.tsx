'use client';

import { PropsWithChildren } from 'react';
import { QueryClient, QueryClientProvider as RQProvider } from '@tanstack/react-query';
import { UserSessionProvider } from '@/lib/auth/user-session-context';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15000,
      retry: 1,
      refetchOnWindowFocus: false
    },
    mutations: {
      retry: 0
    }
  }
});

export function AppProviders({ children }: PropsWithChildren) {
  return (
    <RQProvider client={queryClient}>
      <UserSessionProvider>{children}</UserSessionProvider>
    </RQProvider>
  );
}
