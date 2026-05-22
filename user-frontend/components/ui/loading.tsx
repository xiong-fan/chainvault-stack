export function LoadingState({ label = 'Loading...' }: { label?: string }) {
  return <div className="text-sm text-muted-foreground">{label}</div>;
}

export function ErrorState({ message }: { message: string }) {
  return <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{message}</div>;
}
