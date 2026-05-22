import { StatusBadge as BaseBadge } from '@/components/ui/badge';

export function StatusBadge({
  label,
  tone
}: {
  label: string;
  tone?: 'default' | 'success' | 'warning' | 'danger';
}) {
  return <BaseBadge label={label} tone={tone} />;
}
