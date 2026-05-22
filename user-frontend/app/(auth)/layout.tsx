import { PropsWithChildren } from 'react';
import { Wallet } from 'lucide-react';

export default function AuthLayout({ children }: PropsWithChildren) {
  return (
    <main className="min-h-dvh bg-background px-4 py-6 text-foreground">
      <div className="mx-auto flex min-h-[calc(100dvh-48px)] w-full max-w-6xl flex-col">
        <header className="flex items-center gap-3 py-2">
          <div className="grid h-10 w-10 place-items-center rounded-md bg-foreground text-background">
            <Wallet className="h-5 w-5" />
          </div>
          <div>
            <div className="font-semibold">CEX</div>
            <div className="text-xs text-muted-foreground">Trade account</div>
          </div>
        </header>
        <div className="grid flex-1 items-center gap-8 py-8 lg:grid-cols-[1fr,440px]">
          <section className="hidden lg:block">
            <div className="max-w-xl">
              <p className="text-sm font-medium text-primary">Centralized Exchange</p>
              <h1 className="mt-3 text-5xl font-semibold leading-tight text-foreground">
                交易账户，从登录开始
              </h1>
              <p className="mt-4 max-w-lg text-base leading-7 text-muted-foreground">
                统一管理资产、充值地址、提现进度和资金记录。注册后自动生成默认 EVM 充值地址。
              </p>
              <div className="mt-8 grid max-w-lg grid-cols-3 gap-3">
                {['Assets', 'Deposit', 'Withdraw'].map((item) => (
                  <div key={item} className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
                    <div className="text-foreground">{item}</div>
                    <div className="mt-2 h-1 rounded-full bg-foreground" />
                  </div>
                ))}
              </div>
            </div>
          </section>
          {children}
        </div>
      </div>
    </main>
  );
}
