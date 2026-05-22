export function StatusBadge({
  label,
  tone = 'default'
}: {
  label: string;
  tone?: 'default' | 'success' | 'warning' | 'danger';
}) {
  const toneClass =
    tone === 'success'
      ? 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30'
      : tone === 'warning'
        ? 'bg-amber-500/15 text-amber-500 border-amber-500/30'
        : tone === 'danger'
          ? 'bg-rose-500/15 text-rose-500 border-rose-500/30'
          : 'bg-slate-500/15 text-slate-500 border-slate-500/30';

  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-1 text-xs font-medium ${toneClass}`}
    >
      {label}
    </span>
  );
}
