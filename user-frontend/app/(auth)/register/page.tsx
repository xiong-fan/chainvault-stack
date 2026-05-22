'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { UserPlus } from 'lucide-react';
import { useUserSession } from '@/lib/auth/user-session-context';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';

export default function RegisterPage() {
  const { register } = useUserSession();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await register({ username, email, password });
    } catch (err) {
      setError(err instanceof Error ? err.message : '注册失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="rounded-lg border border-border bg-card/85 p-5 shadow-lg backdrop-blur">
      <div className="mb-5">
        <div className="mb-3 grid h-10 w-10 place-items-center rounded-lg bg-primary text-primary-foreground">
          <UserPlus className="h-5 w-5" />
        </div>
        <h1 className="text-2xl font-semibold">创建账户</h1>
        <p className="mt-2 text-sm text-muted-foreground">注册成功后自动生成默认 EVM 充值地址。</p>
      </div>

      <div className="grid gap-4">
        <TextField label="用户名" value={username} onChange={setUsername} placeholder="3-32 位字母、数字或下划线" />
        <TextField label="邮箱" value={email} onChange={setEmail} type="email" placeholder="name@example.com" />
        <TextField label="密码" value={password} onChange={setPassword} type="password" placeholder="至少 8 位" />
      </div>

      {error ? <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-red-200">{error}</div> : null}

      <Button type="submit" disabled={submitting} className="mt-5 w-full gap-2">
        <UserPlus className="h-4 w-4" />
        {submitting ? '创建中...' : '注册并创建地址'}
      </Button>

      <p className="mt-4 text-center text-sm text-muted-foreground">
        已有账户？
        <Link href="/login" className="ml-1 font-medium text-primary hover:text-secondary">
          登录
        </Link>
      </p>
    </form>
  );
}
