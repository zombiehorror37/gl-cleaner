import { isHeaderRepeat, locateHeader, TEMPLATE, TEMPLATE_HEADERS } from '../template';
import { classifyDocument, type DocClass } from './doc-class';
import {
  cellText,
  contactKey,
  dateOrderHint,
  nameKey,
  parseAmount,
  parseDate,
  txnKey,
  type CellValue,
  type Cents,
  type DateOrder,
} from './values';

/** One valid ledger line in the forced template, normalized. */
export interface LedgerRow {
  /** Stable 0-based id among valid rows. */
  id: number;
  /** 1-based row number in the source sheet (what the user sees in Excel). */
  sourceRow: number;
  contactCode: string;
  contactName: string;
  transactionId: string;
  documentType: string | null;
  /** ISO yyyy-mm-dd, or null when blank/unreadable. */
  dueDate: string | null;
  effectiveDate: string | null;
  /** Original text of a date cell that could not be read (kept so export loses nothing). */
  dueDateText?: string;
  effectiveDateText?: string;
  reference: string | null;
  description: string | null;
  net: Cents;
  // ---- derived ----
  contactKey: string;
  txnKey: string;
  docClass: DocClass;
  /** Fields filled in by the cleaner (fill-down / name lookup), for the audit trail. */
  filled?: ('contactCode' | 'contactName')[];
}

export interface RejectedRow {
  sourceRow: number;
  kind: 'summary' | 'heading' | 'invalid';
  reason: string;
  values: CellValue[];
}

export type Severity = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  severity: Severity;
  code: string;
  title: string;
  detail?: string;
  /** Source row numbers concerned (1-based). */
  rows?: number[];
}

export interface ValidationOptions {
  /** Currency decimals: 2 for most, 3 for KWD/BHD/OMR/JOD, 0 for JPY. */
  precision: number;
  /** How to read ambiguous dates like 03/04/2025. 'auto' detects from the file. */
  dateOrder: 'auto' | DateOrder;
  /** Fill a blank Contact Code/Name from the row above (grouped report layouts). */
  fillDown: boolean;
}

export const DEFAULT_VALIDATION: ValidationOptions = { precision: 2, dateOrder: 'auto', fillDown: false };

export interface ValidationStats {
  dataRows: number;
  blank: number;
  repeatedHeaders: number;
  summaryRows: number;
  headingRows: number;
  rejected: number;
  valid: number;
  filledDown: number;
  zeroNet: number;
  contacts: number;
}

export interface ValidationResult {
  headerOk: boolean;
  headerProblems: string[];
  /** 1-based sheet row of the header, or -1. */
  headerRow: number;
  columnOffset: number;
  rows: LedgerRow[];
  rejected: RejectedRow[];
  issues: ValidationIssue[];
  stats: ValidationStats;
  dateOrderUsed: DateOrder;
  dateOrderDetected: 'dmy' | 'mdy' | 'ambiguous' | 'mixed' | 'none';
  /** Rows that would be rescued by enabling fill-down. */
  fillDownCandidates: number;
}

const SUMMARY_RE =
  /\b(sub\s*-?\s*total|grand\s*total|totals?|balance\s*(b\/?f|c\/?f|brought|carried|forward)|opening\s*balance|closing\s*balance|carried\s*forward|brought\s*forward|net\s*movement|report\s*total)\b|الإجمالي|الاجمالي|إجمالي|اجمالي|المجموع|رصيد\s*(أول|اول|افتتاحي|ختامي|سابق|مرحل|آخر|اخر)/i;

const ERROR_VALUE = /^#(N\/A|REF!|VALUE!|DIV\/0!|NAME\?|NUM!|NULL!|ERROR|SPILL!|CALC!)/i;

const IDX = Object.fromEntries(TEMPLATE.map((f, i) => [f.key, i])) as Record<(typeof TEMPLATE)[number]['key'], number>;

const nonEmpty = (v: CellValue) => cellText(v) !== '';

/** Validate one sheet against the forced template and normalize its rows. */
export function validateSheet(matrix: CellValue[][], opts: ValidationOptions = DEFAULT_VALIDATION): ValidationResult {
  const stats: ValidationStats = {
    dataRows: 0,
    blank: 0,
    repeatedHeaders: 0,
    summaryRows: 0,
    headingRows: 0,
    rejected: 0,
    valid: 0,
    filledDown: 0,
    zeroNet: 0,
    contacts: 0,
  };
  const empty = (problems: string[], headerRow = -1): ValidationResult => ({
    headerOk: false,
    headerProblems: problems,
    headerRow,
    columnOffset: 0,
    rows: [],
    rejected: [],
    issues: [],
    stats,
    dateOrderUsed: opts.dateOrder === 'mdy' ? 'mdy' : 'dmy',
    dateOrderDetected: 'none',
    fillDownCandidates: 0,
  });

  const header = locateHeader(matrix);
  if (!header.ok) return empty(header.problems, header.rowIndex >= 0 ? header.rowIndex + 1 : -1);
  const off = header.offset;
  const issues: ValidationIssue[] = [];
  if (header.rowIndex > 0) {
    issues.push({
      severity: 'info',
      code: 'preamble',
      title: `Header found on row ${header.rowIndex + 1}. The ${header.rowIndex} row(s) above it (report titles) were ignored.`,
    });
  }

  const slice = (row: CellValue[]): CellValue[] => {
    const out: CellValue[] = [];
    for (let i = 0; i < TEMPLATE.length; i++) out.push(row[off + i] ?? null);
    return out;
  };

  // ---- Pass 0: date-order detection over both date columns ---------------
  let dmyOnly = 0;
  let mdyOnly = 0;
  let textDates = 0;
  for (let r = header.rowIndex + 1; r < matrix.length; r++) {
    const v = slice(matrix[r] ?? []);
    for (const c of [v[IDX.dueDate], v[IDX.effectiveDate]]) {
      const h = dateOrderHint(c);
      if (!h) continue;
      textDates++;
      if (h.dmy && !h.mdy) dmyOnly++;
      else if (h.mdy && !h.dmy) mdyOnly++;
    }
  }
  const dateOrderDetected: ValidationResult['dateOrderDetected'] =
    dmyOnly && mdyOnly ? 'mixed' : dmyOnly ? 'dmy' : mdyOnly ? 'mdy' : textDates ? 'ambiguous' : 'none';
  const dateOrderUsed: DateOrder =
    opts.dateOrder !== 'auto' ? opts.dateOrder : mdyOnly > dmyOnly ? 'mdy' : 'dmy';
  if (opts.dateOrder === 'auto' && dateOrderDetected === 'mixed') {
    issues.push({
      severity: 'warning',
      code: 'date-mixed',
      title: 'Dates are written in mixed formats.',
      detail: `${dmyOnly} date(s) only make sense as day/month and ${mdyOnly} only as month/day. Read as ${dateOrderUsed === 'dmy' ? 'day-first (DD/MM/YYYY)' : 'month-first (MM/DD/YYYY)'}; the rows written the other way are listed below.`,
    });
  }

  // ---- Pass 1: names known per contact code (to repair blank names) -----
  const knownName = new Map<string, string>();
  for (let r = header.rowIndex + 1; r < matrix.length; r++) {
    const v = slice(matrix[r] ?? []);
    const code = cellText(v[IDX.contactCode]);
    const name = cellText(v[IDX.contactName]);
    if (code && name && !knownName.has(contactKey(code))) knownName.set(contactKey(code), name);
  }

  // ---- Pass 2: row by row ------------------------------------------------
  const rows: LedgerRow[] = [];
  const rejected: RejectedRow[] = [];
  const roundedRows: number[] = [];
  const badDateRows: number[] = [];
  const otherOrderRows: number[] = [];
  const dueBeforeRows: number[] = [];
  const nameFilledRows: number[] = [];
  const extraColRows: number[] = [];
  let fillDownCandidates = 0;
  let lastCode: string | null = null;
  let lastName: string | null = null;

  for (let r = header.rowIndex + 1; r < matrix.length; r++) {
    const sourceRow = r + 1;
    const full = matrix[r] ?? [];
    if (full.every((c) => !nonEmpty(c))) {
      stats.blank++;
      continue;
    }
    stats.dataRows++;
    const v = slice(full);
    if (full.slice(off + TEMPLATE.length).some(nonEmpty) || full.slice(0, off).some(nonEmpty)) {
      extraColRows.push(sourceRow);
    }
    if (isHeaderRepeat(full, off)) {
      stats.repeatedHeaders++;
      continue;
    }

    const text = (k: keyof typeof IDX) => cellText(v[IDX[k]]);
    let code = text('contactCode');
    let name = text('contactName');
    const txn = text('transactionId');
    const netCell = v[IDX.net];
    const netText = cellText(netCell);
    const textFields = [code, name, txn, text('documentType'), text('reference'), text('description')];

    const reject = (kind: RejectedRow['kind'], reason: string) => {
      rejected.push({ sourceRow, kind, reason, values: v });
      if (kind === 'summary') stats.summaryRows++;
      else if (kind === 'heading') stats.headingRows++;
      else stats.rejected++;
    };

    // Totals / balance lines that reports interleave with transactions.
    if (!txn && (textFields.some((t) => SUMMARY_RE.test(t)) || (!code && !name && netText && textFields.every((t) => !t)))) {
      reject('summary', 'Total / balance line (not a transaction)');
      lastCode = null;
      lastName = null;
      continue;
    }
    // Group heading of a grouped report: contact on its own line, no transaction, no amount.
    if (code && !txn && !netText) {
      reject('heading', 'Contact heading line (no transaction, no amount)');
      lastCode = code;
      lastName = name || knownName.get(contactKey(code)) || null;
      continue;
    }

    // Missing contact code: grouped layouts only print it on the first line.
    const filled: ('contactCode' | 'contactName')[] = [];
    if (!code && txn && netText) {
      if (lastCode && opts.fillDown) {
        code = lastCode;
        filled.push('contactCode');
        if (!name && lastName) {
          name = lastName;
          filled.push('contactName');
        }
        stats.filledDown++;
      } else if (lastCode) {
        fillDownCandidates++;
      }
    }
    if (code && !name) {
      const known = knownName.get(contactKey(code));
      if (known) {
        name = known;
        filled.push('contactName');
        nameFilledRows.push(sourceRow);
      }
    }

    const missing: string[] = [];
    if (!code) missing.push(TEMPLATE_HEADERS[IDX.contactCode]);
    if (!name) missing.push(TEMPLATE_HEADERS[IDX.contactName]);
    if (!txn) missing.push(TEMPLATE_HEADERS[IDX.transactionId]);
    if (!netText) missing.push(TEMPLATE_HEADERS[IDX.net]);
    if (missing.length) {
      reject('invalid', `Missing mandatory: ${missing.join(', ')}`);
      if (code) {
        lastCode = code;
        lastName = name || lastName;
      }
      continue;
    }
    if (ERROR_VALUE.test(netText)) {
      reject('invalid', `Net is an Excel error value (${netText})`);
      continue;
    }
    const amount = parseAmount(netCell, opts.precision);
    if (!amount) {
      reject('invalid', `Net "${netText}" is not a number`);
      continue;
    }
    if (amount.rounded) roundedRows.push(sourceRow);

    const readDate = (cell: CellValue): { iso: string | null; text?: string } => {
      if (!nonEmpty(cell)) return { iso: null };
      const iso = parseDate(cell, dateOrderUsed);
      if (iso) return { iso };
      const other = parseDate(cell, dateOrderUsed === 'dmy' ? 'mdy' : 'dmy');
      if (other && opts.dateOrder === 'auto') {
        otherOrderRows.push(sourceRow);
        return { iso: other };
      }
      badDateRows.push(sourceRow);
      return { iso: null, text: cellText(cell) };
    };
    const due = readDate(v[IDX.dueDate]);
    const eff = readDate(v[IDX.effectiveDate]);
    if (due.iso && eff.iso && due.iso < eff.iso) dueBeforeRows.push(sourceRow);

    const documentType = text('documentType') || null;
    const description = text('description') || null;
    const row: LedgerRow = {
      id: rows.length,
      sourceRow,
      contactCode: code,
      contactName: name,
      transactionId: txn,
      documentType,
      dueDate: due.iso,
      effectiveDate: eff.iso,
      reference: text('reference') || null,
      description,
      net: amount.cents,
      contactKey: contactKey(code),
      txnKey: txnKey(txn) || txn.toUpperCase(),
      docClass: classifyDocument(documentType, txn, description),
    };
    if (due.text) row.dueDateText = due.text;
    if (eff.text) row.effectiveDateText = eff.text;
    if (filled.length) row.filled = filled;
    rows.push(row);
    if (row.net === 0) stats.zeroNet++;
    lastCode = code;
    lastName = name;
  }
  stats.valid = rows.length;

  // ---- Row-level issues ----------------------------------------------------
  const invalid = rejected.filter((x) => x.kind === 'invalid');
  if (invalid.length) {
    issues.push({
      severity: 'error',
      code: 'invalid-rows',
      title: `${invalid.length} row(s) are missing mandatory fields or have an unreadable Net. They are excluded from cleaning and listed in the "Rejected Rows" sheet.`,
      rows: invalid.map((x) => x.sourceRow),
    });
  }
  if (fillDownCandidates > 0) {
    issues.push({
      severity: 'warning',
      code: 'fill-down',
      title: `${fillDownCandidates} row(s) have no Contact Code but follow a row that has one.`,
      detail: 'This looks like a grouped report that prints the contact only once per group. Turn on "Fill blank contacts from the row above" to keep these rows.',
    });
  }
  if (stats.filledDown) {
    issues.push({ severity: 'info', code: 'filled-down', title: `${stats.filledDown} row(s) had their Contact Code filled from the row above.` });
  }
  if (nameFilledRows.length) {
    issues.push({
      severity: 'info',
      code: 'name-filled',
      title: `${nameFilledRows.length} row(s) had a blank Contact Name, filled from other rows with the same code.`,
      rows: nameFilledRows,
    });
  }
  if (stats.summaryRows) {
    issues.push({ severity: 'info', code: 'summary-rows', title: `${stats.summaryRows} total/balance line(s) skipped.`, rows: rejected.filter((x) => x.kind === 'summary').map((x) => x.sourceRow) });
  }
  if (stats.headingRows) {
    issues.push({ severity: 'info', code: 'heading-rows', title: `${stats.headingRows} contact heading line(s) skipped.` });
  }
  if (stats.repeatedHeaders) {
    issues.push({ severity: 'info', code: 'repeat-headers', title: `${stats.repeatedHeaders} repeated header row(s) skipped (page breaks).` });
  }
  if (roundedRows.length) {
    issues.push({
      severity: 'warning',
      code: 'rounded',
      title: `${roundedRows.length} Net value(s) had more than ${opts.precision} decimals and were rounded.`,
      detail: 'Check the currency precision setting if this is unexpected.',
      rows: roundedRows,
    });
  }
  if (otherOrderRows.length) {
    issues.push({
      severity: 'warning',
      code: 'date-other-order',
      title: `${otherOrderRows.length} date(s) could only be read the other way round (${dateOrderUsed === 'dmy' ? 'month-first' : 'day-first'}).`,
      rows: otherOrderRows,
    });
  }
  if (badDateRows.length) {
    issues.push({
      severity: 'warning',
      code: 'bad-dates',
      title: `${badDateRows.length} date(s) could not be read. They are kept as text and ignored for matching.`,
      rows: badDateRows,
    });
  }
  if (dueBeforeRows.length) {
    issues.push({ severity: 'warning', code: 'due-before', title: `${dueBeforeRows.length} row(s) have a Due Date before the Effective Date.`, rows: dueBeforeRows });
  }
  if (extraColRows.length) {
    issues.push({
      severity: 'warning',
      code: 'extra-data',
      title: `${extraColRows.length} row(s) have values outside the ${TEMPLATE.length} template columns. Those values were ignored.`,
      rows: extraColRows,
    });
  }
  if (stats.zeroNet) {
    issues.push({ severity: 'info', code: 'zero', title: `${stats.zeroNet} zero-value line(s). They are cleared automatically.` });
  }
  if (opts.dateOrder === 'auto' && dateOrderDetected === 'ambiguous') {
    issues.push({
      severity: 'info',
      code: 'date-ambiguous',
      title: `${textDates} date(s) are typed as text and read both ways (e.g. 03/04/2025). They were read as day-first (DD/MM/YYYY).`,
      detail: 'Switch the date format setting if your system writes month-first. Real Excel date cells are not affected.',
    });
  }

  // ---- Contact consistency -------------------------------------------------
  const byKey = new Map<string, { codes: Set<string>; names: Map<string, string> }>();
  for (const row of rows) {
    let e = byKey.get(row.contactKey);
    if (!e) {
      e = { codes: new Set(), names: new Map() };
      byKey.set(row.contactKey, e);
    }
    e.codes.add(row.contactCode);
    const nk = nameKey(row.contactName);
    if (!e.names.has(nk)) e.names.set(nk, row.contactName);
  }
  stats.contacts = byKey.size;
  for (const [, e] of byKey) {
    if (e.codes.size > 1) {
      issues.push({
        severity: 'info',
        code: 'code-variants',
        title: `Contact codes ${[...e.codes].map((c) => `"${c}"`).join(', ')} were treated as one contact (case, spaces or leading zeros differ).`,
      });
    }
    if (e.names.size > 1) {
      issues.push({
        severity: 'warning',
        code: 'name-conflict',
        title: `Contact "${[...e.codes][0]}" appears under ${e.names.size} different names: ${[...e.names.values()].map((n) => `"${n}"`).join(', ')}.`,
        detail: 'Check whether two different contacts share a code.',
      });
    }
  }
  const keysByName = new Map<string, Set<string>>();
  for (const [key, e] of byKey) {
    for (const nk of e.names.keys()) {
      if (!nk) continue;
      let s = keysByName.get(nk);
      if (!s) {
        s = new Set();
        keysByName.set(nk, s);
      }
      s.add(key);
    }
  }
  for (const [nk, keys] of keysByName) {
    if (keys.size < 2) continue;
    const codes = [...keys].map((k) => [...byKey.get(k)!.codes][0]);
    const name = byKey.get([...keys][0])!.names.get(nk);
    issues.push({
      severity: 'warning',
      code: 'duplicate-contact',
      title: `"${name}" exists under ${keys.size} contact codes: ${codes.join(', ')}. Possible duplicate accounts.`,
      detail: 'Contacts are never merged automatically. Payments booked to the wrong one are flagged as exceptions.',
    });
  }

  return {
    headerOk: true,
    headerProblems: [],
    headerRow: header.rowIndex + 1,
    columnOffset: off,
    rows,
    rejected,
    issues,
    stats,
    dateOrderUsed,
    dateOrderDetected,
    fillDownCandidates,
  };
}
