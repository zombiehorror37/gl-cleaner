import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { readWorkbook } from '../lib/parse/read';
import { validateSheet, DEFAULT_VALIDATION } from '../lib/parse/validate';
import { cleanLedger } from '../lib/engine/clean';
import { applyDecisions } from '../lib/engine/apply';
import { DEFAULT_SETTINGS } from '../lib/engine/types';
import { buildTemplateWorkbook, buildWorkbook } from '../lib/export';
import { TEMPLATE_HEADERS } from '../lib/template';
import { buildSampleXlsx } from './fixtures/sample-ledger';

describe('sample ledger end-to-end', async () => {
  const xlsx = await buildSampleXlsx();
  if ((import.meta as ImportMeta & { env?: { MODE?: string } }).env?.MODE === 'sample') {
    const dir = fileURLToPath(new URL('../sample/', import.meta.url));
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}sample-ledger.xlsx`, Buffer.from(xlsx));
    writeFileSync(`${dir}blank-template.xlsx`, Buffer.from(await buildTemplateWorkbook()));
  }
  const wb = readWorkbook(xlsx, 'sample-ledger.xlsx');
  const v = validateSheet(wb.sheets[0].matrix, { ...DEFAULT_VALIDATION, fillDown: true });
  const result = cleanLedger(v.rows, DEFAULT_SETTINGS);
  const byTxn = (id: string) => v.rows.filter((r) => r.transactionId === id);
  const kindsFor = (id: string) =>
    result.groups.filter((g) => g.memberIds.some((m) => v.rows[m].transactionId === id)).map((g) => `${g.kind}${g.suggested ? '' : '?'}`);

  it('validates the messy layout', () => {
    expect(v.headerOk).toBe(true);
    expect(v.headerRow).toBe(4);
    expect(v.stats.repeatedHeaders).toBe(1);
    expect(v.stats.summaryRows).toBe(1);
    expect(v.stats.filledDown).toBe(2);
    expect(v.rejected.filter((r) => r.kind === 'invalid').map((r) => r.reason)).toEqual(['Missing mandatory: Transaction Id*']);
    expect(v.rows).toHaveLength(39);
    expect(byTxn('RCT-502')[0]).toMatchObject({ net: -500000, effectiveDate: '2025-03-03' });
    expect(byTxn('TRF-2002')[0].net).toBe(-250000);
    expect(byTxn('INV-4002')[0]).toMatchObject({ net: 100000, contactKey: '123' });
    expect(byTxn('INV-1001')[0]).toMatchObject({ dueDate: '2025-02-04', effectiveDate: '2025-01-05' });
    expect(v.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['preamble', 'code-variants', 'filled-down', 'zero']));
  });

  it('matches each scenario the way a reviewer would', () => {
    expect(kindsFor('RCT-501')).toEqual(['partial']); // WHT
    expect(result.groups.find((g) => g.kind === 'partial' && g.memberIds.includes(byTxn('RCT-501')[0].id))!.reasons.join(' ')).toMatch(/1% of 10,000\.00/);
    expect(kindsFor('RCT-502')).toEqual(['linked']);
    expect(kindsFor('TRF-2001')).toEqual(['fifo-pair']);
    expect(kindsFor('INV-2003')).toEqual([]);
    expect(kindsFor('INV-2009')).toEqual(['zero']);
    expect(kindsFor('TRF-3001')).toEqual(['combo']);
    expect(kindsFor('INV-3004')).toEqual([]);
    expect(kindsFor('RCT-4001')).toEqual(['partial']);
    expect(kindsFor('INV-5002')).toEqual(['same-id']);
    expect(kindsFor('RCT-5001')).toEqual(['linked']); // cites the duplicated invoice: one copy cleared, the other stays open
    expect(kindsFor('TRF-6001')).toEqual(['fifo?']);
    expect(kindsFor('TRF-7001')).toEqual(['near?']);
    expect(kindsFor('RCT-8001')).toEqual([]);
    expect(kindsFor('RCT-10001')).toEqual(['combo?', 'combo?', 'fifo?']);
    const ex = result.exceptions.map((e) => e.kind);
    expect(ex).toEqual(expect.arrayContaining(['duplicate', 'misposting', 'unapplied', 'opposite-balance', 'ambiguous']));
  });

  it('exports a consistent workbook whose first sheet is the forced template', async () => {
    const approved = new Set(result.groups.filter((g) => g.suggested).map((g) => g.id));
    const near = result.groups.find((g) => g.kind === 'near')!;
    approved.add(near.id);
    const outcome = applyDecisions(v.rows, result.groups, approved);
    expect(outcome.errors).toEqual([]);

    const buf = await buildWorkbook({
      fileName: 'sample-ledger.xlsx',
      sheetName: 'Ledger',
      rows: v.rows,
      rejected: v.rejected,
      result,
      approvedIds: approved,
      dateOrder: v.dateOrderUsed,
    });
    const out = new ExcelJS.Workbook();
    await out.xlsx.load(buf);
    expect(out.worksheets.map((w) => w.name)).toEqual(['Open Items', 'Detail', 'Matches', 'Exceptions', 'Rejected Rows', 'Contact Summary', 'Summary']);
    const open = out.getWorksheet('Open Items')!;
    expect((open.getRow(1).values as unknown[]).slice(1)).toEqual(TEMPLATE_HEADERS);
    const netSum = Array.from({ length: open.rowCount - 1 }, (_, i) => Number(open.getRow(i + 2).getCell(9).value)).reduce((a, b) => a + b, 0);
    const original = v.rows.reduce((s, r) => s + r.net, 0) / 100;
    expect(Math.round(netSum * 100)).toBe(Math.round(original * 100));
    const residual = open
      .getColumn(3)
      .values.slice(2)
      .indexOf('INV-7001');
    expect(Number(open.getRow(residual + 2).getCell(9).value)).toBe(5);
    expect(open.getRow(2).getCell(6).value).toBeInstanceOf(Date);

    // The cleaned template re-imports cleanly.
    const again = validateSheet(readWorkbook(buf, 'cleaned.xlsx').sheets[0].matrix);
    expect(again.headerOk).toBe(true);
    expect(again.rows).toHaveLength(outcome.openItems.length);
    expect(again.rejected).toHaveLength(0);
  });

  it('CSV in windows-1256 with day-first text dates', () => {
    const csv =
      'Contact Code*,Contact Name*,Transaction Id*,Document Type,Due Date,Effective Date,Reference,Description,Net*\r\n' +
      'C1,شركة النور,INV-1,فاتورة,,13/02/2025,,بيع,"1,000.00"\r\n' +
      'C1,شركة النور,RCT-1,سند قبض,,05/03/2025,INV-1,,-1000\r\n';
    const bytes = encode1256(csv);
    const wb2 = readWorkbook(bytes, 'ledger.csv');
    expect(wb2.encoding).toBe('windows-1256');
    const v2 = validateSheet(wb2.sheets[0].matrix);
    expect(v2.rows.map((r) => [r.contactName, r.effectiveDate, r.net, r.docClass])).toEqual([
      ['شركة النور', '2025-02-13', 100000, 'invoice'],
      ['شركة النور', '2025-03-05', -100000, 'payment'],
    ]);
    const res2 = cleanLedger(v2.rows, DEFAULT_SETTINGS);
    expect(res2.groups.map((g) => g.kind)).toEqual(['linked']);
  });
});

/** Minimal windows-1256 encoder for the test (Arabic letters used above + ASCII). */
function encode1256(s: string): Uint8Array {
  const map: Record<string, number> = {};
  const dec = new TextDecoder('windows-1256');
  for (let b = 0x80; b <= 0xff; b++) map[dec.decode(new Uint8Array([b]))] = b;
  return new Uint8Array([...s].map((ch) => (ch.charCodeAt(0) < 0x80 ? ch.charCodeAt(0) : map[ch])));
}
