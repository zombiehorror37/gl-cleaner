import * as XLSX from 'xlsx';
import { toCents } from './engine/cents';
import type { Entry } from './engine/types';
import type { ColumnMapping } from './template';

export interface ParsedSheet {
  sheetName: string;
  headers: string[];
  /** Data rows (header row excluded), raw cell values. */
  rows: unknown[][];
}

export interface ParsedWorkbook {
  fileName: string;
  sheets: ParsedSheet[];
}

export async function parseFile(file: File): Promise<ParsedWorkbook> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const sheets: ParsedSheet[] = wb.SheetNames.map((sheetName) => {
    const ws = wb.Sheets[sheetName];
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      raw: true,
      defval: null,
    });
    const nonEmpty = matrix.filter((r) => r.some((c) => c !== null && c !== ''));
    const headers = (nonEmpty[0] ?? []).map((h) => String(h ?? '').trim());
    return { sheetName, headers, rows: nonEmpty.slice(1) };
  });
  return { fileName: file.name, sheets };
}

const cellStr = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  return String(v).trim() || null;
};

const cellDate = (v: unknown): number | null => {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    // Excel serial date fallback (1900 system)
    return Math.round((v - 25569) * 86_400_000);
  }
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
};

export interface BuildResult {
  entries: Entry[];
  /** Row indexes (0-based within data rows) skipped for unparseable amount. */
  skippedRows: number[];
  accounts: string[];
}

/** Apply a column mapping to raw rows, producing engine entries. */
export function buildEntries(rows: unknown[][], mapping: ColumnMapping, precision = 2): BuildResult {
  const entries: Entry[] = [];
  const skippedRows: number[] = [];
  const accounts = new Set<string>();

  rows.forEach((row, i) => {
    const amountRaw = mapping.amount >= 0 ? row[mapping.amount] : null;
    const amount = toCents(amountRaw, precision);
    if (amount === null) {
      skippedRows.push(i);
      return;
    }
    const get = (f: keyof ColumnMapping) => (mapping[f] >= 0 ? row[mapping[f]] : null);
    const account = cellStr(get('account')) ?? '';
    accounts.add(account);
    entries.push({
      id: i,
      account,
      accountName: cellStr(get('accountName')),
      date: cellDate(get('date')),
      docNo: cellStr(get('docNo')),
      docType: cellStr(get('docType')),
      reference: cellStr(get('reference')),
      description: cellStr(get('description')),
      amount,
      raw: row,
    });
  });

  return { entries, skippedRows, accounts: [...accounts].sort() };
}
