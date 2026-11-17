import ExcelJS from 'exceljs';
import { applyDecisions } from './engine/apply';
import { KIND_LABEL, EXCEPTION_LABEL, type CleanResult, type LedgerRow } from './engine/types';
import type { RejectedRow } from './parse/validate';
import { centsToNumber, cellText, formatCents, type DateOrder } from './parse/values';
import { TEMPLATE, TEMPLATE_HEADERS } from './template';

export interface ExportInput {
  fileName: string;
  sheetName: string;
  rows: LedgerRow[];
  rejected: RejectedRow[];
  result: CleanResult;
  approvedIds: Set<string>;
  dateOrder: DateOrder;
}

const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
const RESIDUAL_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF4CE' } };
const CLEARED_FONT: Partial<ExcelJS.Font> = { color: { argb: 'FF6B7280' } };

const isoToDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};

function styleHeader(ws: ExcelJS.Worksheet, widths: number[]) {
  const row = ws.getRow(1);
  row.eachCell((c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = HEADER_FILL;
    c.alignment = { vertical: 'middle' };
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
  if (ws.rowCount > 1) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: widths.length } };
}

const TEMPLATE_WIDTHS = [14, 28, 16, 16, 12, 13, 18, 40, 15];

/** The nine template values of a ledger row, typed for Excel. */
function templateValues(r: LedgerRow, precision: number): ExcelJS.CellValue[] {
  return [
    r.contactCode,
    r.contactName,
    r.transactionId,
    r.documentType,
    r.dueDate ? isoToDate(r.dueDate) : (r.dueDateText ?? null),
    r.effectiveDate ? isoToDate(r.effectiveDate) : (r.effectiveDateText ?? null),
    r.reference,
    r.description,
    centsToNumber(r.net, precision),
  ];
}

/**
 * Build the cleaned workbook. The first sheet is the forced template itself
 * (open items only), so it can be re-imported or loaded straight back into
 * the source system. Throws if any integrity check fails — an inconsistent
 * export is impossible by construction.
 */
export async function buildWorkbook(input: ExportInput): Promise<ArrayBuffer> {
  const { rows, result, approvedIds, rejected } = input;
  const { settings } = result;
  const p = settings.precision;
  const outcome = applyDecisions(rows, result.groups, approvedIds, p);
  if (outcome.errors.length) throw new Error(`Integrity check failed:\n${outcome.errors.join('\n')}`);

  const numFmt = p === 0 ? '#,##0;-#,##0' : `#,##0.${'0'.repeat(p)};-#,##0.${'0'.repeat(p)}`;
  const dateFmt = input.dateOrder === 'mdy' ? 'mm/dd/yyyy' : 'dd/mm/yyyy';
  const groupById = new Map(result.groups.map((g) => [g.id, g]));

  const wb = new ExcelJS.Workbook();
  wb.creator = 'GL Cleaner';
  wb.created = new Date();

  const formatTemplateCols = (ws: ExcelJS.Worksheet, firstCol: number) => {
    ws.getColumn(firstCol + 4).numFmt = dateFmt;
    ws.getColumn(firstCol + 5).numFmt = dateFmt;
    ws.getColumn(firstCol + 8).numFmt = numFmt;
  };

  // ---- 1. Open Items (forced template) ----------------------------------------
  const open = wb.addWorksheet('Open Items');
  open.addRow(TEMPLATE_HEADERS);
  for (const item of outcome.openItems) {
    const row = open.addRow(templateValues(item.row, p));
    if (item.kind === 'residual') row.eachCell({ includeEmpty: true }, (c) => (c.fill = RESIDUAL_FILL));
  }
  formatTemplateCols(open, 1);
  styleHeader(open, TEMPLATE_WIDTHS);

  // ---- 2. Detail (every line, annotated) ----------------------------------------
  const detail = wb.addWorksheet('Detail');
  detail.addRow(['Source Row', ...TEMPLATE_HEADERS, 'Status', 'Open Amount', 'Match ID', 'Match Type', 'Confidence', 'Why']);
  const residualOf = new Map<number, number>();
  for (const g of outcome.approved) if (g.residual !== 0 && g.residualFromId !== null) residualOf.set(g.residualFromId, g.residual);
  for (const r of rows) {
    const gid = outcome.clearedBy.get(r.id);
    const g = gid ? groupById.get(gid)! : null;
    const res = residualOf.get(r.id);
    const status = !g ? 'Open' : res !== undefined ? 'Part-settled' : 'Cleared';
    const openAmt = !g ? r.net : (res ?? 0);
    const row = detail.addRow([
      r.sourceRow,
      ...templateValues(r, p),
      status,
      centsToNumber(openAmt, p),
      g?.id ?? '',
      g ? KIND_LABEL[g.kind] : '',
      g ? `${g.tier} (${g.confidence})` : '',
      g ? g.reasons.join('; ') : r.filled?.length ? `filled: ${r.filled.join(', ')}` : '',
    ]);
    if (status === 'Cleared') row.font = CLEARED_FONT;
    if (status === 'Part-settled') row.eachCell({ includeEmpty: true }, (c) => (c.fill = RESIDUAL_FILL));
  }
  formatTemplateCols(detail, 2);
  detail.getColumn(12).numFmt = numFmt;
  styleHeader(detail, [10, ...TEMPLATE_WIDTHS, 13, 15, 10, 24, 14, 70]);

  // ---- 3. Matches -----------------------------------------------------------------
  const matches = wb.addWorksheet('Matches');
  matches.addRow(['Match ID', 'Contact Code', 'Contact Name', 'Type', 'Confidence', 'Lines', 'Source Rows', 'Transaction Ids', 'Lines Net', 'Kept Open (residual)', 'Why']);
  const rowById = new Map(rows.map((r) => [r.id, r]));
  for (const g of outcome.approved) {
    const ms = g.memberIds.map((id) => rowById.get(id)!);
    matches.addRow([
      g.id,
      ms[0].contactCode,
      ms[0].contactName,
      KIND_LABEL[g.kind],
      `${g.tier} (${g.confidence})`,
      ms.length,
      ms.map((m) => m.sourceRow).join(', '),
      ms.map((m) => m.transactionId).join(', '),
      centsToNumber(g.residual, p),
      g.residual ? `${centsToNumber(g.residual, p)} on ${rowById.get(g.residualFromId!)!.transactionId}` : '',
      g.reasons.join('; '),
    ]);
  }
  matches.getColumn(9).numFmt = numFmt;
  styleHeader(matches, [10, 14, 26, 24, 13, 7, 20, 34, 14, 26, 80]);

  // ---- 4. Exceptions ------------------------------------------------------------------
  const ex = wb.addWorksheet('Exceptions');
  ex.addRow(['ID', 'Type', 'Severity', 'Contact Code', 'Source Rows', 'Message']);
  const contactCode = new Map(result.contacts.map((c) => [c.key, c.code]));
  for (const e of result.exceptions) {
    ex.addRow([
      e.id,
      EXCEPTION_LABEL[e.kind],
      e.severity,
      e.contactKey ? contactCode.get(e.contactKey) : '',
      e.rowIds.map((id) => rowById.get(id)!.sourceRow).join(', '),
      e.message,
    ]);
  }
  styleHeader(ex, [8, 26, 10, 14, 20, 110]);

  // ---- 5. Rejected Rows ---------------------------------------------------------------
  const rej = wb.addWorksheet('Rejected Rows');
  rej.addRow(['Source Row', 'Kind', 'Reason', ...TEMPLATE_HEADERS]);
  for (const r of rejected) {
    rej.addRow([r.sourceRow, r.kind, r.reason, ...r.values.map((v) => cellText(v) || null)]);
  }
  styleHeader(rej, [10, 10, 40, ...TEMPLATE_WIDTHS]);

  // ---- 6. Contact Summary (with live checks over Detail / Open Items) ------------------
  const cs = wb.addWorksheet('Contact Summary');
  cs.addRow(['Contact Code', 'Contact Name', 'Lines', 'Original Balance', 'Cleared Lines', 'Open Lines', 'Open Balance', 'Open Balance (live)', 'Check (live)']);
  const nOpen = outcome.openItems.length + 1;
  const nDetail = rows.length + 1;
  const openByContact = new Map<string, { n: number; net: number }>();
  for (const item of outcome.openItems) {
    const e = openByContact.get(item.row.contactKey) ?? { n: 0, net: 0 };
    e.n++;
    e.net += item.row.net;
    openByContact.set(item.row.contactKey, e);
  }
  result.contacts.forEach((c, i) => {
    const r = i + 2;
    const o = openByContact.get(c.key) ?? { n: 0, net: 0 };
    const cleared = c.rowIds.filter((id) => outcome.clearedBy.has(id)).length;
    // Codes merged from variants ("00123" / 123) can't be summed by one SUMIFS key.
    const variants = new Set(c.rowIds.map((id) => rowById.get(id)!.contactCode)).size > 1;
    const ok = o.net === c.balance ? 'OK' : 'CHECK';
    cs.addRow([
      c.code,
      c.name,
      c.rowIds.length,
      variants
        ? centsToNumber(c.balance, p)
        : { formula: `SUMIFS(Detail!$J$2:$J$${nDetail},Detail!$B$2:$B$${nDetail},A${r})`, result: centsToNumber(c.balance, p) },
      cleared,
      o.n,
      centsToNumber(o.net, p),
      variants
        ? centsToNumber(o.net, p)
        : { formula: `SUMIFS('Open Items'!$I$2:$I$${nOpen},'Open Items'!$A$2:$A$${nOpen},A${r})`, result: centsToNumber(o.net, p) },
      variants ? `${ok} (code variants: static)` : { formula: `IF(ROUND(D${r}-H${r},${p})=0,"OK","CHECK")`, result: ok },
    ]);
  });
  for (const col of [4, 7, 8]) cs.getColumn(col).numFmt = numFmt;
  styleHeader(cs, [14, 30, 8, 18, 13, 11, 18, 20, 13]);

  // ---- 7. Summary -------------------------------------------------------------------------
  const sum = wb.addWorksheet('Summary');
  const t = outcome.totals;
  const lines: [string, ExcelJS.CellValue][] = [
    ['Source file', input.fileName],
    ['Sheet', input.sheetName],
    ['Cleaned at', new Date().toISOString().replace('T', ' ').slice(0, 19)],
    ['Ledger', settings.invoiceSign === 1 ? 'Receivables: invoices positive (+)' : 'Payables: invoices negative (−)'],
    ['Near-miss tolerance', `${formatCents(settings.toleranceAmount, p)}${settings.tolerancePercent ? ` or ${settings.tolerancePercent}%` : ''}; withholding rates ${settings.withholdingRates.join('%, ')}%${settings.vatRate ? ` (also on pre-VAT at ${settings.vatRate}%)` : ''}`],
    ['', ''],
    ['Valid lines', t.originalRows],
    ['Rejected / skipped rows', rejected.length],
    ['Approved matches', outcome.approved.length],
    ['Cleared lines', t.clearedRows],
    ['Residual lines (part-settled documents)', t.residualLines],
    ['Open items', t.openRows],
    ['Exceptions', result.exceptions.length],
    ['', ''],
    ['Original balance', centsToNumber(t.originalNet, p)],
    ['Open items balance', centsToNumber(t.openNet, p)],
    ['Integrity', 'PASSED: no line in two matches; every match nets to zero or leaves its remainder open; open balance = original balance'],
    ['', ''],
    ['Live checks (recalculated by Excel)', ''],
    ['Original balance (Detail)', { formula: `SUM(Detail!$J$2:$J$${nDetail})`, result: centsToNumber(t.originalNet, p) }],
    ['Open items balance (Open Items)', { formula: `SUM('Open Items'!$I$2:$I$${nOpen})`, result: centsToNumber(t.openNet, p) }],
    ['Check', { formula: `IF(ROUND(B20-B21,${p})=0,"PASS","FAIL")`, result: 'PASS' }],
  ];
  for (const [k, v] of lines) sum.addRow([k, v]);
  sum.getColumn(1).width = 42;
  sum.getColumn(2).width = 90;
  sum.getColumn(1).font = { bold: true };
  for (const r of [15, 16, 20, 21]) sum.getCell(`B${r}`).numFmt = numFmt;

  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

/** A blank workbook in the forced template, for users whose export doesn't match. */
export async function buildTemplateWorkbook(): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('GL');
  ws.addRow(TEMPLATE_HEADERS);
  styleHeader(ws, TEMPLATE_WIDTHS);
  ws.getColumn(5).numFmt = 'dd/mm/yyyy';
  ws.getColumn(6).numFmt = 'dd/mm/yyyy';
  ws.getColumn(9).numFmt = '#,##0.00;-#,##0.00';
  const help = wb.addWorksheet('Instructions');
  help.addRow(['Column', 'Mandatory', 'What goes here']);
  const notes: Record<string, string> = {
    contactCode: 'Customer / supplier code. The same code on every line of that contact.',
    contactName: 'Customer / supplier name.',
    transactionId: 'Document number of the line (invoice no., receipt no., journal no.).',
    documentType: 'Invoice, Credit Note, Payment, Receipt, Journal… Helps the matching.',
    dueDate: 'Due date of the document.',
    effectiveDate: 'Document / posting date.',
    reference: 'For payments and credit notes: the invoice number(s) they settle. This is the strongest matching signal.',
    description: 'Free text. Invoice numbers mentioned here are also used for matching.',
    net: 'Signed amount. Receivables: invoices positive, receipts negative. Payables: bills negative, payments positive.',
  };
  for (const f of TEMPLATE) help.addRow([f.label, f.required ? 'Yes' : 'No', notes[f.key]]);
  styleHeader(help, [18, 11, 100]);
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}
