export function clampNumericInput(value: string): string {
  return value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1');
}

export function formatCurrencyAmount(value?: string | null): string {
  if (!value && value !== '0') return '--';
  const normalized = String(value);
  if (/^-?\d+(\.\d+)?$/.test(normalized)) {
    return normalized;
  }
  return normalized;
}

export function shortenText(value: string, start = 6, end = 4): string {
  if (!value) return '--';
  if (value.length <= start + end + 3) return value;
  return `${value.slice(0, start)}...${value.slice(-end)}`;
}
