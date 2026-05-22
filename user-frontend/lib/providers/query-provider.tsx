'use client';

import { PropsWithChildren } from 'react';
import { QueryClient, QueryClientProvider as RQProvider } from '@tanstack/react-query';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: 1,
      refetchOnWindowFocus: false
    },
    mutations: {
      retry: 0
    }
  }
});

export function QueryClientProvider({ children }: PropsWithChildren) {
  return <RQProvider client={queryClient}>{children}</RQProvider>;
}
