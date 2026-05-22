'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { LogIn } from 'lucide-react';
import { useUserSession } from '@/lib/auth/user-session-context';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';

export default function LoginPage() {
  const { login } = useUserSession();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await login({ identifier, password });
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="rounded-lg border border-border bg-card/85 p-5 shadow-lg backdrop-blur">
      <div className="mb-5">
        <div className="mb-3 grid h-10 w-10 place-items-center rounded-lg bg-accent text-accent-foreground">
          <LogIn className="h-5 w-5" />
        </div>
        <h1 className="text-2xl font-semibold">登录账户</h1>
        <p className="mt-2 text-sm text-muted-foreground">使用用户名或邮箱进入交易账户。</p>
      </div>

      <div className="grid gap-4">
        <TextField label="用户名或邮箱" value={identifier} onChange={setIdentifier} placeholder="trader01 或 name@example.com" />
        <TextField label="密码" value={password} onChange={setPassword} type="password" placeholder="输入密码" />
      </div>

      {error ? <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-red-200">{error}</div> : null}

      <Button type="submit" disabled={submitting} className="mt-5 w-full gap-2">
        <LogIn className="h-4 w-4" />
        {submitting ? '登录中...' : '登录'}
      </Button>

      <p className="mt-4 text-center text-sm text-muted-foreground">
        没有账户？
        <Link href="/register" className="ml-1 font-medium text-primary hover:text-secondary">
          注册
        </Link>
      </p>
    </form>
  );
}
