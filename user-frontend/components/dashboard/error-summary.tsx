export function ErrorSummary({ message }: { message: string }) {
  return (
    <div className="card border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
      {message}
    </div>
  );
}
