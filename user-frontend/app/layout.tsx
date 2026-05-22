import type { Metadata } from 'next';
import { ReactNode } from 'react';
import { AppProviders } from '@/lib/providers/app-providers';
import '@/app/globals.css';

export const metadata: Metadata = {
  title: 'CEX Wallet User Frontend',
  description: 'CEX user wallet dashboard and withdrawal frontend'
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`font-sans antialiased bg-background text-foreground`}>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
