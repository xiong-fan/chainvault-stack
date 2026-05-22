import { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Surface({
  title,
  subtitle,
  children,
  className
}: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('card p-4', className)}>
      {(title || subtitle) && (
        <div className="mb-3">
          {title && <h2 className="text-base font-semibold text-foreground">{title}</h2>}
          {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
        </div>
      )}
      {children}
    </section>
  );
}
