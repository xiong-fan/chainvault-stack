export function TextField({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  disabled,
  error,
  helperText
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'number' | 'email' | 'password';
  placeholder?: string;
  disabled?: boolean;
  error?: string;
  helperText?: string;
}) {
  const helpMessage = error || helperText;

  return (
    <label className="grid gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <input
        className={`h-11 w-full rounded-lg border bg-background px-3 text-foreground outline-none ring-offset-0 transition duration-200 placeholder:text-muted-foreground/70 focus:ring-2 disabled:opacity-50 ${
          error
            ? 'border-destructive focus:border-destructive focus:ring-destructive/20'
            : 'border-border focus:border-primary focus:ring-primary/30'
        }`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        type={type}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
      />
      {helpMessage ? (
        <span className={error ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>{helpMessage}</span>
      ) : null}
    </label>
  );
}
