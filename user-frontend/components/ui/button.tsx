export function Button({
  children,
  onClick,
  disabled,
  variant = 'solid',
  type = 'button',
  className = ''
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'solid' | 'outline' | 'ghost';
  type?: 'button' | 'submit' | 'reset';
  className?: string;
}) {
  const variantClass =
    variant === 'outline'
      ? 'border border-border bg-transparent text-foreground hover:border-foreground hover:bg-muted'
      : variant === 'ghost'
        ? 'text-foreground hover:bg-muted'
        : 'bg-foreground text-background hover:bg-foreground/90';

  return (
    <button
      type={type}
      className={`inline-flex h-10 cursor-pointer items-center justify-center rounded-lg px-4 text-sm font-medium transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 disabled:cursor-not-allowed disabled:opacity-50 ${variantClass} ${className}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
