export function formatMoney(value: number | null | undefined, currency = 'USD'): string {
  const amount = Number(value ?? 0);
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(
    Number.isFinite(amount) ? amount : 0
  );
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Local YYYY-MM-DD, immune to the UTC off-by-one that toISOString() causes. */
export function toDateInputValue(value: Date = new Date()): string {
  const copy = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return copy.toISOString().slice(0, 10);
}

export function combineDateAndTime(date: string, time: string): string {
  return `${date}T${time}:00`;
}

export function timeRangeOptions(stepMinutes = 15): string[] {
  const options: string[] = [];
  for (let minutes = 8 * 60; minutes <= 18 * 60; minutes += stepMinutes) {
    const hour = String(Math.floor(minutes / 60)).padStart(2, '0');
    const minute = String(minutes % 60).padStart(2, '0');
    options.push(`${hour}:${minute}`);
  }
  return options;
}

export function relativeDays(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${Math.abs(days)} days ago`;
}

export function classList(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(' ');
}
