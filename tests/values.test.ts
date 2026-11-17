import { describe, expect, it } from 'vitest';
import {
  contactKey,
  digitCore,
  nameKey,
  parseAmount,
  parseDate,
  serialToIso,
  textTokens,
  txnKey,
} from '../lib/parse/values';
import { classifyDocument } from '../lib/parse/doc-class';
import { checkHeaderRow, locateHeader, TEMPLATE_HEADERS } from '../lib/template';

const cents = (v: unknown, p = 2) => parseAmount(v, p)?.cents ?? null;

describe('parseAmount', () => {
  it.each([
    [1234.56, 123456],
    ['1,234.56', 123456],
    ['(1,234.56)', -123456],
    ['-1,234.56', -123456],
    ['1,234.56-', -123456],
    ['1,234.56 CR', -123456],
    ['CR 1,234.56', -123456],
    ['1,234.56 DR', 123456],
    ['EGP 1,234.56', 123456],
    ['$-1,234.56', -123456],
    ['-$1,234.56', -123456],
    ['١٬٢٣٤٫٥٦', 123456],
    ['1.234,56', 123456],
    ['1 234,56', 123456],
    ["1'234.56", 123456],
    ['1234,5', 123450],
    ['1,234', 123400],
    ['1.234.567', 123456700],
    ['  ٥٠٠ ', 50000],
    [3343.91, 334391],
    ['0.00', 0],
    ['-0', 0],
  ])('%s → %s', (input, expected) => {
    expect(cents(input)).toBe(expected);
  });

  it.each(['', null, 'abc', '12-34', '1,23,4.5.6', '#N/A', true])('rejects %s', (v) => {
    expect(parseAmount(v)).toBeNull();
  });

  it('flags rounding beyond precision', () => {
    expect(parseAmount('10.005')).toEqual({ cents: 1001, rounded: true });
    expect(parseAmount('10.000')).toEqual({ cents: 1000, rounded: false });
    expect(parseAmount('1.2345', 3)).toEqual({ cents: 1235, rounded: true });
  });
});

describe('parseDate', () => {
  it('reads ambiguous dates by the chosen order', () => {
    expect(parseDate('03/04/2025', 'dmy')).toBe('2025-04-03');
    expect(parseDate('03/04/2025', 'mdy')).toBe('2025-03-04');
  });
  it('rejects impossible dates instead of rolling them over', () => {
    expect(parseDate('31/02/2025', 'dmy')).toBeNull();
    expect(parseDate('13/13/2025', 'dmy')).toBeNull();
    expect(parseDate('29/02/2024', 'dmy')).toBe('2024-02-29');
  });
  it.each([
    ['2025-03-14', '2025-03-14'],
    ['2025/3/4', '2025-03-04'],
    ['2025-03-14T10:00:00', '2025-03-14'],
    ['14-Mar-2025', '2025-03-14'],
    ['14 March 25', '2025-03-14'],
    ['Mar 14, 2025', '2025-03-14'],
    ['20250314', '2025-03-14'],
    [45730, '2025-03-14'],
    ['45730', '2025-03-14'],
    [{ date: '2025-01-02' }, '2025-01-02'],
    ['١٤/٠٣/٢٠٢٥', '2025-03-14'],
  ])('%s', (v, iso) => {
    expect(parseDate(v, 'dmy')).toBe(iso);
  });
  it('excel serials', () => {
    expect(serialToIso(45730)).toBe('2025-03-14');
    expect(serialToIso(61)).toBe('1900-03-01');
  });
});

describe('identifiers', () => {
  it('contact keys survive leading zeros, case and spaces', () => {
    expect(contactKey('00123')).toBe(contactKey('123'));
    expect(contactKey(' c-001 ')).toBe(contactKey('C001'));
    expect(contactKey('0')).toBe('0');
  });
  it('transaction keys', () => {
    expect(txnKey('INV-0001')).toBe('INV0001');
    expect(txnKey('inv 0001')).toBe('INV0001');
    expect(digitCore('INV-000123')).toBe('123');
    expect(digitCore('INV-12')).toBeNull();
  });
  it('name keys ignore legal suffixes and punctuation', () => {
    expect(nameKey('ABC Trading Co. Ltd')).toBe(nameKey('abc limited'));
    expect(nameKey('شركة النور')).toBe(nameKey('النور'));
  });
  it('tokens from free text', () => {
    const t = textTokens('Pmt for INV-1001 & 1002, on 12/03/2025 amount 1,500.00');
    expect(t).toContain('INV1001');
    expect(t).toContain('1002');
    expect(t).not.toContain('12');
    expect(t).not.toContain('1500');
    expect(textTokens('inv 1001/1002')).toEqual(expect.arrayContaining(['INV1001', '1001', '1002']));
  });
});

describe('document classes', () => {
  it.each([
    ['Sales Invoice', 'X1', null, 'invoice'],
    ['Credit Note', 'X1', null, 'credit_note'],
    ['Receipt', 'X1', null, 'payment'],
    [null, 'INV-77', null, 'invoice'],
    [null, 'CN-77', null, 'credit_note'],
    [null, 'X', 'Reversal of INV-5', 'reversal'],
    ['فاتورة مبيعات', 'X', null, 'invoice'],
    ['إشعار دائن', 'X', null, 'credit_note'],
    ['سند قبض', 'X', null, 'payment'],
    [null, 'X', 'WHT deducted 1%', 'wht'],
    [null, 'X', 'something', 'unknown'],
  ])('%s / %s / %s → %s', (dt, id, desc, cls) => {
    expect(classifyDocument(dt, id, desc)).toBe(cls);
  });
});

describe('template header', () => {
  it('accepts exact headers with or without the * marker and any case', () => {
    expect(checkHeaderRow(TEMPLATE_HEADERS).ok).toBe(true);
    expect(checkHeaderRow(TEMPLATE_HEADERS.map((h) => ` ${h.replace('*', '').toUpperCase()} `)).ok).toBe(true);
  });
  it('rejects wrong order with a precise message', () => {
    const h = [...TEMPLATE_HEADERS];
    [h[4], h[5]] = [h[5], h[4]];
    const r = checkHeaderRow(h);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/Column E: found "Effective Date".*out of order/);
  });
  it('rejects extra and missing columns', () => {
    expect(checkHeaderRow([...TEMPLATE_HEADERS, 'Currency']).problems[0]).toMatch(/unexpected extra column "Currency"/);
    expect(checkHeaderRow(TEMPLATE_HEADERS.slice(0, 8)).problems[0]).toMatch(/expected "Net\*" but the header is empty/);
  });
  it('finds the header below report title rows and after a blank first column', () => {
    const m = [['Customer Ledger'], ['Period: Jan–Mar 2025'], [], [null, ...TEMPLATE_HEADERS]];
    const loc = locateHeader(m);
    expect(loc.ok).toBe(true);
    expect(loc.rowIndex).toBe(3);
    expect(loc.offset).toBe(1);
  });
  it('reports when nothing looks like the template', () => {
    const loc = locateHeader([['Date', 'Doc', 'Amount'], [1, 2, 3]]);
    expect(loc.ok).toBe(false);
    expect(loc.rowIndex).toBe(-1);
  });
});
