/**
 * Cell-level parsing: amounts, dates and identifiers as they really arrive
 * from accounting exports — text numbers, trailing minus signs, CR/DR
 * suffixes, Arabic digits, Excel serial dates, dd/mm vs mm/dd, numeric codes
 * that lost their leading zeros. Pure functions, no I/O.
 */

/** A cell as read from the file. Dates read from real Excel date cells arrive pre-parsed. */
export type CellValue = string | number | boolean | null | { date: string };

export type Cents = number;

export const isDateCell = (v: unknown): v is { date: string } =>
  typeof v === 'object' && v !== null && 'date' in v && typeof (v as { date: unknown }).date === 'string';

const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/g;

const ARABIC_DIGITS = (s: string) =>
  s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));

/** Render any cell as clean text: trimmed, single spaces, no invisible characters. */
export function cellText(v: CellValue | unknown): string {
  if (v === null || v === undefined) return '';
  if (isDateCell(v)) return v.date;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '';
    // Integers stored as numbers (codes, ids) — no exponent, no trailing ".0".
    if (Number.isInteger(v)) return v.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 0 });
    return String(v);
  }
  return String(v).replace(INVISIBLE, '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------- amounts ---

export interface AmountParse {
  cents: Cents;
  /** Set when digits beyond the currency precision were rounded away. */
  rounded: boolean;
}

/**
 * Parse an amount into integer minor units (cents) without float drift.
 * Handles: numbers; "1,234.56"; "(1,234.56)"; "-1,234.56"; "1,234.56-" (SAP);
 * "1,234.56 CR" / "DR"; currency symbols/codes; Arabic-Indic digits and
 * separators; European "1.234,56"; spaces/apostrophes as thousands separators.
 * Returns null when the cell is empty or not a number.
 */
export function parseAmount(value: CellValue | unknown, precision = 2): AmountParse | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  if (isDateCell(value)) return null;
  const scale = 10 ** precision;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const fixed = Number(value.toFixed(precision));
    const cents = Math.round(fixed * scale);
    if (!Number.isSafeInteger(cents)) return null;
    // Rounded if the value carries more precision than the currency allows.
    const rounded = Math.abs(value - fixed) > 1e-9 * Math.max(1, Math.abs(value));
    return { cents, rounded };
  }

  let s = ARABIC_DIGITS(String(value).replace(INVISIBLE, '').replace(/ /g, ' ').trim());
  if (!s) return null;
  s = s.replace(/٫/g, '.').replace(/٬/g, ',').replace(/،/g, ',');

  let negative = false;
  // Accounting parentheses: (1,234.56)
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  // CR / DR markers (prefix or suffix). Credit = negative under debit-positive convention.
  const crdr = s.match(/^(cr|dr)\b\.?\s*|\s*\b(cr|dr)\.?$/i);
  if (crdr) {
    const tag = (crdr[1] ?? crdr[2]).toLowerCase();
    if (tag === 'cr') negative = !negative;
    s = s.replace(crdr[0], '').trim();
  }
  // Trailing minus (SAP / some ERPs): 1,234.56-
  if (/^[^-]*\d\s*-$/.test(s)) {
    negative = !negative;
    s = s.replace(/\s*-$/, '');
  }
  // Leading sign, possibly after a currency symbol: "-$1,234" or "$-1,234" or "EGP -1,234"
  s = s.replace(/[^\d.,\-+'’ ]/g, '').trim();
  if (/^[-+]/.test(s)) {
    if (s[0] === '-') negative = !negative;
    s = s.slice(1).trim();
  }
  if (s.includes('-') || s.includes('+')) return null;
  // Thousands separators that are spaces or apostrophes (1 234,56 / 1'234.56)
  s = s.replace(/[ '’]/g, '');
  if (!s || !/\d/.test(s)) return null;

  // Decide which of . and , is the decimal separator.
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let intPart: string;
  let fracPart: string;
  if (lastDot >= 0 && lastComma >= 0) {
    // Both present: the later one is the decimal separator.
    const dec = lastDot > lastComma ? '.' : ',';
    const thou = dec === '.' ? ',' : '.';
    const [i, f = ''] = s.split(dec);
    if (s.split(dec).length > 2) return null;
    intPart = i.split(thou).join('');
    fracPart = f;
  } else if (lastComma >= 0) {
    const parts = s.split(',');
    // "1,234" / "1,234,567" are thousands; a single comma followed by 1–2 digits is a decimal comma.
    if (parts.length === 2 && parts[1].length > 0 && parts[1].length !== 3) {
      intPart = parts[0];
      fracPart = parts[1];
    } else if (parts.slice(1).every((p) => p.length === 3)) {
      intPart = parts.join('');
      fracPart = '';
    } else {
      return null;
    }
  } else if (lastDot >= 0) {
    const parts = s.split('.');
    if (parts.length === 2) {
      intPart = parts[0];
      fracPart = parts[1];
    } else if (parts.slice(1).every((p) => p.length === 3)) {
      // "1.234.567" — dot thousands with no decimals
      intPart = parts.join('');
      fracPart = '';
    } else {
      return null;
    }
  } else {
    intPart = s;
    fracPart = '';
  }
  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(fracPart) || (intPart + fracPart).length === 0) return null;

  const kept = (fracPart + '0'.repeat(precision)).slice(0, precision);
  const dropped = fracPart.slice(precision);
  let cents: bigint;
  try {
    cents = BigInt(intPart || '0') * BigInt(scale) + BigInt(kept || '0');
  } catch {
    return null;
  }
  if (dropped.length > 0 && dropped.charCodeAt(0) >= 53 /* '5' */) cents += BigInt(1);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const n = Number(cents);
  return { cents: negative && n !== 0 ? -n : n, rounded: /[1-9]/.test(dropped) };
}

/** Format integer cents for display: 1234567 → "12,345.67". */
export function formatCents(cents: Cents, precision = 2): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const scale = 10 ** precision;
  const intPart = Math.floor(abs / scale).toLocaleString('en-US');
  if (precision === 0) return sign + intPart;
  return `${sign}${intPart}.${String(abs % scale).padStart(precision, '0')}`;
}

/** Cents → plain number for writing to Excel (exact for |x| < 2^53 / scale). */
export const centsToNumber = (cents: Cents, precision = 2): number =>
  Number((cents / 10 ** precision).toFixed(precision));

// ------------------------------------------------------------------ dates ---

export type DateOrder = 'dmy' | 'mdy';

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10,
  november: 11, december: 12,
};

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function isoFromParts(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return null;
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d > dim) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

const expandYear = (y: number, raw: string) => (raw.length <= 2 ? (y < 50 ? 2000 + y : 1900 + y) : y);

/** Excel 1900-system serial number → ISO date (time of day ignored). */
export function serialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 2958465) return null;
  const whole = Math.floor(serial);
  // Excel's fictitious 1900-02-29 (serial 60): serials above it are shifted by one day.
  const ms = Date.UTC(1899, 11, 30) + whole * 86_400_000;
  const d = new Date(ms);
  return isoFromParts(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** Classify a numeric date string a/b/y: which orders are valid. */
export function dateOrderHint(v: unknown): { dmy: boolean; mdy: boolean } | null {
  if (typeof v !== 'string') return null;
  const m = ARABIC_DIGITS(v.trim()).match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})(?:[ T].*)?$/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const y = expandYear(Number(m[3]), m[3]);
  return { dmy: isoFromParts(y, b, a) !== null, mdy: isoFromParts(y, a, b) !== null };
}

/**
 * Parse a date cell to ISO yyyy-mm-dd. `order` decides ambiguous numeric
 * dates like 03/04/2025. Returns null when empty or unparseable.
 */
export function parseDate(v: CellValue | unknown, order: DateOrder): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (isDateCell(v)) return v.date;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return isoFromParts(v.getFullYear(), v.getMonth() + 1, v.getDate());
  }
  if (typeof v === 'number') {
    // Plain numbers in a date column: Excel serials (1955…2119) or yyyymmdd.
    if (v >= 19000101 && v <= 21991231 && Number.isInteger(v)) {
      return isoFromParts(Math.floor(v / 10000), Math.floor(v / 100) % 100, v % 100);
    }
    if (v >= 20000 && v <= 80000) return serialToIso(v);
    return null;
  }
  const s = ARABIC_DIGITS(String(v).replace(INVISIBLE, '').trim());
  if (!s) return null;

  // ISO-ish: 2025-03-14, 2025/03/14, 2025.03.14, optionally with time
  let m = s.match(/^(\d{4})[/.\-](\d{1,2})[/.\-](\d{1,2})(?:[ T].*)?$/);
  if (m) return isoFromParts(Number(m[1]), Number(m[2]), Number(m[3]));

  // yyyymmdd
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return isoFromParts(Number(m[1]), Number(m[2]), Number(m[3]));

  // Numeric a/b/y — order decides.
  m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})(?:[ T].*)?$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = expandYear(Number(m[3]), m[3]);
    return order === 'dmy' ? isoFromParts(y, b, a) : isoFromParts(y, a, b);
  }

  // 14-Mar-2025, 14 Mar 2025, 14 March 2025
  m = s.match(/^(\d{1,2})[\s\-/.]+([A-Za-z]{3,9})\.?[\s\-/.,]+(\d{2}|\d{4})$/);
  if (m && MONTHS[m[2].toLowerCase()]) {
    return isoFromParts(expandYear(Number(m[3]), m[3]), MONTHS[m[2].toLowerCase()], Number(m[1]));
  }
  // Mar 14, 2025 / March 14 2025
  m = s.match(/^([A-Za-z]{3,9})\.?[\s\-/.]+(\d{1,2})(?:st|nd|rd|th)?,?[\s\-/.]+(\d{2}|\d{4})$/);
  if (m && MONTHS[m[1].toLowerCase()]) {
    return isoFromParts(expandYear(Number(m[3]), m[3]), MONTHS[m[1].toLowerCase()], Number(m[2]));
  }
  // Excel serial typed as text
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n >= 20000 && n <= 80000) return serialToIso(n);
  }
  return null;
}

/** Days between two ISO dates (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

// ------------------------------------------------------------ identifiers ---

/**
 * Grouping key for a contact code. Case, spaces and separators are ignored,
 * and purely numeric codes lose their leading zeros — Excel silently turns
 * "00123" into 123 when a code column is typed as number, so both spellings
 * must land on the same contact.
 */
export function contactKey(code: string): string {
  const k = ARABIC_DIGITS(code).toUpperCase().replace(/[\s\-_./\\]+/g, '');
  if (/^\d+$/.test(k)) return k.replace(/^0+(?=\d)/, '');
  return k;
}

/** Comparison key for a transaction id: letters and digits only, upper case. */
export function txnKey(id: string): string {
  return ARABIC_DIGITS(id)
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Numeric core of an id ("INV-000123" → "123"), only when it is substantial. */
export function digitCore(id: string): string | null {
  const digits = ARABIC_DIGITS(id).replace(/\D+/g, '');
  if (digits.length < 3) return null;
  const core = digits.replace(/^0+(?=\d)/, '');
  return core.length >= 3 ? core : null;
}

const LEGAL_SUFFIXES = new Set([
  'ltd', 'limited', 'llc', 'inc', 'incorporated', 'co', 'company', 'corp', 'corporation', 'plc', 'sae',
  'sa', 'sarl', 'gmbh', 'est', 'establishment', 'trading', 'group', 'the', 'and', 'for',
  'شركة', 'مؤسسة', 'شمم', 'ش', 'م', 'ذ', 'للتجارة', 'والتوريدات',
]);

/** Comparison key for a contact name: lower case, no punctuation, no legal suffixes. */
export function nameKey(name: string): string {
  return ARABIC_DIGITS(name)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t && !LEGAL_SUFFIXES.has(t))
    .join(' ');
}

const DATE_IN_TEXT = /\b\d{1,4}[/.\-]\d{1,2}[/.\-]\d{1,4}\b/g;
const AMOUNT_IN_TEXT = /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d+\.\d{2}\b/g;

/**
 * Candidate document-number tokens inside free text ("Pmt for INV-1001 &
 * 1002, ref 2025/03/01") → ["PMT", "FOR", "INV1001", "1002", ...]. Dates and
 * formatted amounts are removed first so they can't masquerade as ids.
 * "INV 1001" also yields the joined "INV1001".
 */
export function textTokens(text: string | null): string[] {
  if (!text) return [];
  const s = ARABIC_DIGITS(text).replace(DATE_IN_TEXT, ' ').replace(AMOUNT_IN_TEXT, ' ');
  const raw = s.split(/[\s,;|&+()[\]{}]+/u).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const k = txnKey(raw[i]);
    if (k) out.push(k);
    // "1001/1002" or "INV-1/INV-2": every slash-separated part is a candidate too.
    if (raw[i].includes('/')) {
      for (const p of raw[i].split('/')) {
        const pk = txnKey(p);
        if (pk && pk !== k) out.push(pk);
      }
    }
    // "INV 1001" / "INV# 1001" → also "INV1001".
    if (i + 1 < raw.length && /^\p{L}+[-#.:]?$/u.test(raw[i]) && /^\d/.test(raw[i + 1])) {
      const joined = txnKey(raw[i] + raw[i + 1].split('/')[0]);
      if (joined) out.push(joined);
    }
  }
  return out;
}

/** Meaningful words of a description for similarity (no ids, numbers or filler). */
export function descriptionWords(text: string | null): Set<string> {
  if (!text) return new Set();
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}]+/u)
      .filter((t) => t.length >= 4 && !FILLER.has(t)),
  );
}

const FILLER = new Set([
  'invoice', 'payment', 'receipt', 'credit', 'debit', 'note', 'against', 'from', 'with', 'this', 'that',
  'being', 'amount', 'paid', 'settlement', 'transfer', 'bank', 'cash', 'cheque', 'check',
]);

const PERIOD_IN_TEXT = /(?<![\d/.])(\d{1,2})\s*[/.\-]\s*(20\d{2}|\d{2})(?![\d/.\-])/g;

/**
 * Identifier keys in a description, for linking lines that describe the same
 * thing without citing each other's Transaction Id — e.g. an accrual
 * "ACC-1/2025E07-ELEC" and its reversal "R/ACR E7 1/25" both reduce to
 * {E7, P2025-01}. Periods (m/yyyy, m/yy) become P{yyyy}-{mm}; letter+number
 * codes lose leading zeros (E07 → E7); pure numbers ≥ 3 digits are kept.
 */
export function descriptionKeys(text: string | null): string[] {
  if (!text) return [];
  let s = ARABIC_DIGITS(text).toUpperCase().replace(DATE_IN_TEXT, ' ');
  const keys = new Set<string>();
  s = s.replace(PERIOD_IN_TEXT, (_m, mm: string, yy: string) => {
    const m = Number(mm);
    const y = yy.length === 2 ? 2000 + Number(yy) : Number(yy);
    if (m >= 1 && m <= 12) keys.add(`P${y}-${String(m).padStart(2, '0')}`);
    return ' ';
  });
  // Split letter/digit runs glued by separators or each other ("2025E07" → 2025, E07).
  for (const tok of s.split(/[^\p{L}\p{N}]+/u)) {
    for (const part of tok.match(/\p{L}+\d+|\d+/gu) ?? []) {
      const m = part.match(/^(\p{L}+)0*(\d+)$/u);
      if (m) keys.add(`${m[1]}${m[2]}`);
      else if (part.length >= 3) keys.add(part.replace(/^0+(?=\d)/, ''));
    }
  }
  return [...keys].sort();
}

/** True when a text field is only '#' placeholders: the export lost non-Latin (e.g. Arabic) characters. */
export const isMangledText = (text: string | null) => !!text && /#{3,}/.test(text) && /^[#\s\-/\d.,:()]+$/.test(text.replace(/\b[A-Z]{1,3}\d*\b/gi, ''));
