import ExcelJS from 'exceljs';
import { fromCents } from './engine/cents';
import { reconcile, verifyApproved } from './engine/verify';
import { groupEntryIds, type Entry, type GroupKind, type MatchGroup } from './engine/types';

export interface ExportInput {
  fileName: string;
  headers: string[];
  entries: Entry[];
  approvedGroups: MatchGroup[];
  /** 0-based index of the Amount column in `headers` (for live formulas). */
  amountCol: number;
  precision?: number;
}

const MATCH_TYPE: Record<GroupKind, string> = {
  pair: '1:1 exact',
  combo: 'N:1 combination',
  deep: 'M:N combination',
  net: 'Global netting',
};

/**
 * Output workbook: Detail (all rows annotated, script-style) / Cleaned GL /
 * Removed Entries / Summary. Throws if hard invariants fail — export is
 * impossible in an inconsistent state by construction.
 */
export async function buildWorkbook({
  fileName,
  headers,
  entries,
  approvedGroups,
  amountCol,
  precision = 2,
}: ExportInput): Promise<Blob> {
  const entryMap = new Map(entries.map((e) => [e.id, e]));
  const check = verifyApproved(approvedGroups, entryMap);
  if (!check.ok) {
    throw new Error(`Integrity check failed:\n${check.errors.join('\n')}`);
  }

  const removedIds = new Set<number>();
  const groupOf = new Map<number, MatchGroup>();
  for (const g of approvedGroups) {
    for (const id of groupEntryIds(g)) {
      removedIds.add(id);
      groupOf.set(id, g);
    }
  }
  const totals = reconcile(entries, removedIds);
  if (!totals.balanced) {
    throw new Error('Reconciliation failed: removed entries do not sum to zero.');
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'GL Cleaner';
  wb.created = new Date();

  const headerStyle: Partial<ExcelJS.Style> = {
    font: { bold: true, color: { argb: 'FFFFFFFF' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } },
  };
  const redFill: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
  const redFont: Partial<ExcelJS.Font> = { color: { argb: 'FF9C0006' }, bold: true };

  const styleHeader = (ws: ExcelJS.Worksheet) => {
    ws.getRow(1).eachCell((c) => Object.assign(c, { style: headerStyle }));
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  };
  const sizeColumns = (ws: ExcelJS.Worksheet, cols: string[]) => {
    ws.columns.forEach((col, i) => {
      col.width = Math.max(12, Math.min(40, String(cols[i] ?? '').length + 6));
    });
  };

  // ---- Detail: every row in original order, annotated (script-style) ----
  const detail = wb.addWorksheet('Detail');
  const detailCols = [...headers, 'Status', 'Match_Group_ID', 'Match_Type'];
  detail.addRow(detailCols);
  styleHeader(detail);
  for (const e of entries) {
    const g = groupOf.get(e.id);
    const row = detail.addRow([
      ...headers.map((_, i) => e.raw[i] ?? null),
      g ? 'Cleared' : 'Open',
      g?.id ?? '',
      g ? MATCH_TYPE[g.kind] : '',
    ]);
    if (!g && e.amount < 0) {
      row.eachCell((c) => {
        c.fill = redFill;
        c.font = redFont;
      });
    }
  }
  sizeColumns(detail, detailCols);
  detail.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: entries.length + 1, column: detailCols.length },
  };

  // ---- Cleaned GL ----
  const cleanedWs = wb.addWorksheet('Cleaned GL');
  cleanedWs.addRow(headers);
  styleHeader(cleanedWs);
  for (const e of entries) {
    if (!removedIds.has(e.id)) cleanedWs.addRow(headers.map((_, i) => e.raw[i] ?? null));
  }
  sizeColumns(cleanedWs, headers);

  // ---- Removed Entries ----
  const removedWs = wb.addWorksheet('Removed Entries');
  const removedCols = [...headers, 'Group ID', 'Kind', 'Confidence', 'Score', 'Match Reasons'];
  removedWs.addRow(removedCols);
  styleHeader(removedWs);
  for (const e of entries) {
    if (!removedIds.has(e.id)) continue;
    const g = groupOf.get(e.id)!;
    removedWs.addRow([
      ...headers.map((_, i) => e.raw[i] ?? null),
      g.id,
      MATCH_TYPE[g.kind],
      g.tier,
      g.confidence,
      g.reasons.join('; '),
    ]);
  }
  sizeColumns(removedWs, removedCols);

  // ---- Summary: static reconciliation + live formulas over Detail ----
  const ws = wb.addWorksheet('Summary');
  const n = entries.length;
  const colLetter = (i: number) => detail.getColumn(i + 1).letter;
  const A = colLetter(amountCol);
  const S = colLetter(headers.length); // Status
  const rngA = `Detail!$${A}$2:$${A}$${n + 1}`;
  const rngS = `Detail!$${S}$2:$${S}$${n + 1}`;

  const staticLines: [string, string | number][] = [
    ['Source file', fileName],
    ['Exported at', new Date().toISOString()],
    ['', ''],
    ['Original rows', totals.originalRows],
    ['Removed (cleared) rows', totals.removedRows],
    ['Open rows', totals.cleanedRows],
    ['Approved groups', approvedGroups.length],
    ['', ''],
    ['Original total', fromCents(totals.originalTotal, precision)],
    ['Removed total (must be zero)', fromCents(totals.removedTotal, precision)],
    ['Open total', fromCents(totals.cleanedTotal, precision)],
    ['', ''],
    ['Integrity checks', 'PASSED — every cleared group sums to 0; no entry in two groups'],
    ['', ''],
  ];
  for (const [k, v] of staticLines) ws.addRow([k, v]);

  ws.addRow(['Live checks (recalculated by Excel over the Detail sheet)', '']);
  const fml = (f: string) => ({ formula: f });
  ws.addRow(['Net balance (all rows)', fml(`SUM(${rngA})`)]);
  ws.addRow(['Cleared net (must be 0.00)', fml(`SUMIF(${rngS},"Cleared",${rngA})`)]);
  ws.addRow(['Open net (= original net)', fml(`SUMIF(${rngS},"Open",${rngA})`)]);
  ws.addRow(['Open negative rows', fml(`COUNTIFS(${rngS},"Open",${rngA},"<0")`)]);
  ws.addRow(['Open negative amount', fml(`SUMIFS(${rngA},${rngS},"Open",${rngA},"<0")`)]);
  ws.addRow(['Check: cleared net = 0', fml(`IF(ROUND(SUMIF(${rngS},"Cleared",${rngA}),2)=0,"PASS","FAIL")`)]);

  ws.getColumn(1).width = 44;
  ws.getColumn(2).width = 50;
  ws.getColumn(1).font = { bold: true };

  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}
