import { describe, expect, it } from 'vitest';
import { validateSheet, DEFAULT_VALIDATION } from '../lib/parse/validate';
import { TEMPLATE_HEADERS } from '../lib/template';
import type { CellValue } from '../lib/parse/values';

const H = TEMPLATE_HEADERS;
//            code     name          txn        type        due           eff           ref    desc   net
const sheet = (...rows: CellValue[][]): CellValue[][] => [H, ...rows];

describe('validateSheet', () => {
  it('rejects a file whose headers do not match, with reasons', () => {
    const r = validateSheet([['Code', 'Name', 'Amount'], ['C1', 'A', 5]]);
    expect(r.headerOk).toBe(false);
    expect(r.headerProblems.length).toBeGreaterThan(0);
  });

  it('skips blanks, repeated headers, totals and contact headings; rejects missing mandatory fields', () => {
    const r = validateSheet(
      sheet(
        ['C1', 'Alpha', 'INV-1', 'Invoice', null, '01/02/2025', null, null, '1,000.00'],
        [],
        H,
        [null, 'Total', null, null, null, null, null, null, 1000],
        [null, null, null, null, null, null, null, null, 1000],
        ['C2', 'Beta', null, null, null, null, null, null, null],
        ['C2', 'Beta', null, 'Invoice', null, null, null, 'no id', 50],
        ['C2', 'Beta', 'INV-9', 'Invoice', null, null, null, null, null],
        ['C2', 'Beta', 'INV-10', 'Invoice', null, null, null, null, '#N/A'],
        ['C2', 'Beta', 'INV-11', 'Invoice', null, null, null, null, 'twelve'],
        ['C2', 'Beta', 'INV-12', 'Invoice', null, null, null, null, '0'],
      ),
    );
    expect(r.headerOk).toBe(true);
    expect(r.stats.blank).toBe(1);
    expect(r.stats.repeatedHeaders).toBe(1);
    expect(r.stats.summaryRows).toBe(2);
    expect(r.stats.headingRows).toBe(1);
    expect(r.rejected.filter((x) => x.kind === 'invalid').map((x) => x.reason)).toEqual([
      'Missing mandatory: Transaction Id*',
      'Missing mandatory: Net*',
      'Net is an Excel error value (#N/A)',
      'Net "twelve" is not a number',
    ]);
    expect(r.rows.map((x) => x.transactionId)).toEqual(['INV-1', 'INV-12']);
    expect(r.rows[0]).toMatchObject({ net: 100000, effectiveDate: '2025-02-01', sourceRow: 2, docClass: 'invoice' });
    expect(r.stats.zeroNet).toBe(1);
  });

  it('fill-down: offers it, then fills blank contacts from the row above when enabled', () => {
    const m = sheet(
      ['C1', 'Alpha', 'INV-1', null, null, null, null, null, 100],
      [null, null, 'INV-2', null, null, null, null, null, 200],
      [null, null, 'PMT-1', null, null, null, null, null, -300],
    );
    const off = validateSheet(m);
    expect(off.rows).toHaveLength(1);
    expect(off.fillDownCandidates).toBe(2);
    expect(off.issues.some((i) => i.code === 'fill-down')).toBe(true);

    const on = validateSheet(m, { ...DEFAULT_VALIDATION, fillDown: true });
    expect(on.rows).toHaveLength(3);
    expect(on.rows[2]).toMatchObject({ contactCode: 'C1', contactName: 'Alpha', filled: ['contactCode', 'contactName'] });
  });

  it('fills a blank name from other rows of the same contact code', () => {
    const r = validateSheet(
      sheet(['C1', null, 'INV-1', null, null, null, null, null, 100], ['C1', 'Alpha', 'INV-2', null, null, null, null, null, 100]),
    );
    expect(r.rows[0].contactName).toBe('Alpha');
    expect(r.rows[0].filled).toEqual(['contactName']);
  });

  it('detects day-first dates from unambiguous ones and flags mixed formats', () => {
    const dmy = validateSheet(
      sheet(
        ['C1', 'A', 'I1', null, null, '25/03/2025', null, null, 1],
        ['C1', 'A', 'I2', null, null, '03/04/2025', null, null, 1],
      ),
    );
    expect(dmy.dateOrderDetected).toBe('dmy');
    expect(dmy.rows[1].effectiveDate).toBe('2025-04-03');

    const mixed = validateSheet(
      sheet(
        ['C1', 'A', 'I1', null, null, '25/03/2025', null, null, 1],
        ['C1', 'A', 'I2', null, null, '26/03/2025', null, null, 1],
        ['C1', 'A', 'I3', null, null, '03/27/2025', null, null, 1],
      ),
    );
    expect(mixed.dateOrderDetected).toBe('mixed');
    expect(mixed.rows[2].effectiveDate).toBe('2025-03-27');
    expect(mixed.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['date-mixed', 'date-other-order']));
  });

  it('keeps unreadable dates as text and warns', () => {
    const r = validateSheet(sheet(['C1', 'A', 'I1', null, 'next month', null, null, null, 1]));
    expect(r.rows[0].dueDate).toBeNull();
    expect(r.rows[0].dueDateText).toBe('next month');
    expect(r.issues.some((i) => i.code === 'bad-dates')).toBe(true);
  });

  it('merges code variants and warns on name conflicts and duplicate contacts', () => {
    const r = validateSheet(
      sheet(
        ['00123', 'Alpha Trading Co', 'I1', null, null, null, null, null, 1],
        [123, 'Alpha Trading Company', 'I2', null, null, null, null, null, 1],
        ['C9', 'Alpha Trading Ltd', 'I3', null, null, null, null, null, 1],
        ['C7', 'Gamma', 'I4', null, null, null, null, null, 1],
        ['C7', 'Delta', 'I5', null, null, null, null, null, 1],
      ),
    );
    expect(r.rows[0].contactKey).toBe(r.rows[1].contactKey);
    const codes = r.issues.map((i) => i.code);
    expect(codes).toContain('code-variants');
    expect(codes).toContain('name-conflict');
    expect(codes).toContain('duplicate-contact');
    expect(r.stats.contacts).toBe(3);
  });

  it('warns about values outside the template and rounding', () => {
    const r = validateSheet(sheet(['C1', 'A', 'I1', null, null, null, null, null, '10.005', 'stray']));
    expect(r.rows[0].net).toBe(1001);
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['extra-data', 'rounded']));
  });
});
