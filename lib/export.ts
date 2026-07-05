import ExcelJS from 'exceljs';
import { fromCents } from './engine/cents';
import { reconcile, verifyApproved } from './engine/verify';
import { groupEntryIds, type Entry, type MatchGroup } from './engine/types';

export interface ExportInput {
  fileName: string;
  headers: string[];
  entries: Entry[];
  approvedGroups: MatchGroup[];
  precision?: number;
}

/**
 * Build the output workbook: Cleaned GL / Removed Entries / Summary.
 * Throws if the hard invariants fail — export is impossible in an
 * inconsistent state by construction.
 */
export async function buildWorkbook({
  fileName,
  headers,
  entries,
  approvedGroups,
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

  const writeRows = (
    ws: ExcelJS.Worksheet,
    cols: string[],
    rows: (Entry & { extra?: (string | number)[] })[],
    extraCols: string[] = [],
  ) => {
    const all = [...cols, ...extraCols];
    ws.addRow(all);
    ws.getRow(1).eachCell((c) => Object.assign(c, { style: headerStyle }));
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const e of rows) {
      ws.addRow([...cols.map((_, i) => e.raw[i] ?? null), ...(e.extra ?? [])]);
    }
    ws.columns.forEach((col, i) => {
      col.width = Math.max(12, Math.min(40, String(all[i] ?? '').length + 6));
    });
  };

  const cleaned = entries.filter((e) => !removedIds.has(e.id));
  writeRows(wb.addWorksheet('Cleaned GL'), headers, cleaned);

  const removed = entries
    .filter((e) => removedIds.has(e.id))
    .map((e) => {
      const g = groupOf.get(e.id)!;
      return {
        ...e,
        extra: [
          g.id,
          g.kind,
          g.tier,
          g.confidence,
          g.reasons.join('; '),
        ] as (string | number)[],
      };
    });
  const wsRemoved = wb.addWorksheet('Removed Entries');
  writeRows(wsRemoved, headers, removed, ['Group ID', 'Kind', 'Confidence', 'Score', 'Match Reasons']);

  const ws = wb.addWorksheet('Summary');
  const lines: [string, string | number][] = [
    ['Source file', fileName],
    ['Exported at', new Date().toISOString()],
    ['', ''],
    ['Original rows', totals.originalRows],
    ['Removed rows', totals.removedRows],
    ['Cleaned rows', totals.cleanedRows],
    ['Approved groups', approvedGroups.length],
    ['', ''],
    ['Original total', fromCents(totals.originalTotal, precision)],
    ['Removed total (must be zero)', fromCents(totals.removedTotal, precision)],
    ['Cleaned total', fromCents(totals.cleanedTotal, precision)],
    ['', ''],
    ['Integrity checks', 'PASSED — every removed group sums to 0; no entry in two groups'],
  ];
  for (const [k, v] of lines) ws.addRow([k, v]);
  ws.getColumn(1).width = 34;
  ws.getColumn(2).width = 50;
  ws.getColumn(1).font = { bold: true };

  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}
