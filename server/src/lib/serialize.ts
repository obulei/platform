/**
 * postgres.js returns NUMERIC as a string to preserve precision. Every value
 * that crosses into a calculation or into JSON as a number goes through here,
 * so no route ever does arithmetic on a string.
 */
export function money(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'number' ? value : Number(value);
}

export function moneyOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? value : Number(value);
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function totalOf(values: number[]): number {
  return round2(values.reduce((sum, value) => sum + value, 0));
}
