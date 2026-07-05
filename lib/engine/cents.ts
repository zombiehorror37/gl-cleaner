import type { Cents } from './types';

/**
 * Parse any cell value into integer cents without float drift.
 * Handles: numbers, strings with thousands separators, parentheses negatives,
 * leading minus, currency symbols, Arabic-Indic digits.
 * Returns null for unparseable/empty values.
 */
export function toCents(value: unknown, precision = 2): Cents | null {
  if (value === null || value === undefined || value === '') return null;
  const scale = 10 ** precision;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    // Round at the precision boundary; string round-trip avoids float artifacts
    // like 3343.91 * 100 === 334390.99999999994.
    return Math.round(Number(value.toFixed(precision)) * scale);
  }

  let s = String(value).trim();
  if (!s) return null;

  // Arabic-Indic and Extended Arabic-Indic digits → ASCII
  s = s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  s = s.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  // Arabic decimal/thousands separators
  s = s.replace(/٫/g, '.').replace(/٬/g, ',');

  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  // Strip currency symbols/letters and spaces, keep digits . , -
  s = s.replace(/[^\d.,-]/g, '');
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  }
  if (s.includes('-')) return null; // stray minus inside
  s = s.replace(/,/g, '');
  if (!/^\d*(\.\d*)?$/.test(s) || s === '' || s === '.') return null;

  const [intPart = '0', fracPart = ''] = s.split('.');
  const fracKept = (fracPart + '0'.repeat(precision)).slice(0, precision);
  let cents: bigint;
  try {
    cents = BigInt(intPart || '0') * BigInt(scale) + BigInt(fracKept || '0');
  } catch {
    return null;
  }
  // Round half-up on the digit right after the kept precision
  if (fracPart.length > precision && fracPart.charCodeAt(precision) >= 53 /* '5' */) {
    cents += 1n;
  }
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const n = Number(cents);
  return negative ? -n : n;
}

/** Format integer cents back to a display string. */
export function fromCents(cents: Cents, precision = 2): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const scale = 10 ** precision;
  const intPart = Math.floor(abs / scale).toLocaleString('en-US');
  if (precision === 0) return sign + intPart;
  const frac = String(abs % scale).padStart(precision, '0');
  return `${sign}${intPart}.${frac}`;
}

export function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}
