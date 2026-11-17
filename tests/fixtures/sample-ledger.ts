import ExcelJS from 'exceljs';
import { TEMPLATE_HEADERS } from '../../lib/template';

const d = (iso: string) => {
  const [y, m, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day));
};

type V = string | number | Date | null;

/**
 * A receivables ledger with the problems people meet when cleaning by hand:
 * report title rows, a repeated header, a subtotal line, grouped rows with
 * the contact printed once, text amounts in several formats (trailing minus,
 * parentheses, Arabic digits), text dates, a numeric contact code that lost its
 * leading zeros, a duplicate posting, a reversal, partial payments,
 * withholding tax, bank charges, a lump-sum payment, identical monthly
 * amounts, a payment booked to the wrong customer, and unapplied cash.
 */
export const SAMPLE_ROWS: V[][] = [
  ['ACME Egypt S.A.E. Customer Ledger'],
  ['Period: 01/01/2025 to 31/03/2025'],
  [],
  TEMPLATE_HEADERS,
  // C001: WHT 1% on the pre-VAT amount; payment citing the invoice in free text; an invoice another customer paid
  ['C001', 'Nile Foods', 'INV-1001', 'Tax Invoice', d('2025-02-04'), d('2025-01-05'), null, 'Consulting January', 11400],
  ['C001', 'Nile Foods', 'RCT-501', 'Receipt', null, d('2025-02-02'), 'INV-1001', 'Bank transfer less WHT', -11300],
  ['C001', 'Nile Foods', 'INV-1002', 'Tax Invoice', d('2025-03-01'), d('2025-02-01'), null, 'Consulting February', '5,000.00'],
  ['C001', 'Nile Foods', 'RCT-502', 'Receipt', null, '03/03/2025', null, 'Payment inv 1002', '(5,000.00)'],
  ['C001', 'Nile Foods', 'INV-1003', 'Tax Invoice', d('2025-04-01'), d('2025-03-01'), null, 'Consulting March', 6600],
  // C002: identical monthly rent, a zero line, a subtotal line
  ['C002', 'Delta Pharma', 'INV-2001', 'Invoice', null, d('2025-01-01'), null, 'Office rent Jan', 2500],
  ['C002', 'Delta Pharma', 'INV-2002', 'Invoice', null, d('2025-02-01'), null, 'Office rent Feb', 2500],
  ['C002', 'Delta Pharma', 'INV-2003', 'Invoice', null, d('2025-03-01'), null, 'Office rent Mar', 2500],
  ['C002', 'Delta Pharma', 'TRF-2001', 'Bank Transfer', null, d('2025-01-20'), null, null, -2500],
  ['C002', 'Delta Pharma', 'TRF-2002', 'Bank Transfer', null, d('2025-02-18'), null, null, '2,500.00-'],
  ['C002', 'Delta Pharma', 'INV-2009', 'Invoice', null, d('2025-02-10'), null, 'Cancelled, zero value', 0],
  [null, 'Total Delta Pharma', null, null, null, null, null, null, 5000],
  // C003: one transfer pays three invoices, a fourth stays open
  ['C003', 'Cairo Steel', 'INV-3001', 'Invoice', null, d('2025-01-03'), null, null, 1200],
  ['C003', 'Cairo Steel', 'INV-3002', 'Invoice', null, d('2025-01-09'), null, null, 3400],
  ['C003', 'Cairo Steel', 'INV-3003', 'Invoice', null, d('2025-01-15'), null, null, 560],
  ['C003', 'Cairo Steel', 'INV-3004', 'Invoice', null, d('2025-03-15'), null, null, 999],
  ['C003', 'Cairo Steel', 'TRF-3001', 'Bank Transfer', null, d('2025-02-01'), null, 'Payment', -5160],
  TEMPLATE_HEADERS, // repeated header (page break in the report export)
  // 00123 / 123: same customer, code lost its leading zeros on some lines; partial payment
  ['00123', 'Alex Traders', 'INV-4001', 'Invoice', null, d('2025-01-10'), null, 'Goods', 8000],
  [123, 'Alex Traders', 'RCT-4001', 'Receipt', null, d('2025-02-10'), 'INV-4001', 'Part payment', -3000],
  [123, 'Alex Traders', 'INV-4002', 'Invoice', null, d('2025-03-10'), null, 'Goods', '١٬٠٠٠'],
  // C005: duplicate posting + receipt; posting reversed under the same id
  ['C005', 'Giza Motors', 'INV-5001', 'Invoice', null, d('2025-01-12'), null, 'Spare parts', 7250],
  ['C005', 'Giza Motors', 'INV-5001', 'Invoice', null, d('2025-01-12'), null, 'Spare parts', 7250],
  ['C005', 'Giza Motors', 'RCT-5001', 'Receipt', null, d('2025-02-12'), 'INV-5001', null, -7250],
  ['C005', 'Giza Motors', 'INV-5002', 'Invoice', null, d('2025-01-20'), null, 'Service', 2000],
  ['C005', 'Giza Motors', 'INV-5002', 'Invoice', null, d('2025-01-21'), null, 'Reversal: wrong customer', -2000],
  // C006: grouped layout: contact printed once. Unreferenced payments (balance-forward)
  ['C006', 'Red Sea Hotels', 'INV-6001', 'Invoice', null, d('2025-01-01'), null, null, 1000],
  [null, null, 'INV-6002', 'Invoice', null, d('2025-02-01'), null, null, 2000],
  [null, null, 'INV-6003', 'Invoice', null, d('2025-03-01'), null, null, 3000],
  ['C006', 'Red Sea Hotels', 'TRF-6001', 'Bank Transfer', null, d('2025-02-10'), null, null, -1500],
  ['C006', 'Red Sea Hotels', 'TRF-6002', 'Bank Transfer', null, d('2025-03-10'), null, null, -700],
  // C007: bank charges deducted
  ['C007', 'Luxor Tours', 'INV-7001', 'Invoice', null, d('2025-01-05'), null, null, 4000],
  ['C007', 'Luxor Tours', 'TRF-7001', 'Bank Transfer', null, d('2025-02-05'), null, null, -3995],
  // C008: pays C001's invoice by mistake
  ['C008', 'Aswan Ceramics', 'RCT-8001', 'Receipt', null, d('2025-03-20'), 'INV-1003', null, -6600],
  ['C008', 'Aswan Ceramics', 'INV-8001', 'Invoice', null, d('2025-03-01'), null, null, 450],
  // C009: cash on account, no invoice yet
  ['C009', 'Sinai Pharma', 'RCT-9001', 'Receipt', null, d('2025-03-25'), null, 'Advance payment', -1000],
  // C010: two different combinations clear the payment
  ['C010', 'Fayoum Farms', 'INV-10001', 'Invoice', null, d('2025-01-01'), null, null, 100],
  ['C010', 'Fayoum Farms', 'INV-10002', 'Invoice', null, d('2025-01-02'), null, null, 200],
  ['C010', 'Fayoum Farms', 'INV-10003', 'Invoice', null, d('2025-01-03'), null, null, 300],
  ['C010', 'Fayoum Farms', 'INV-10004', 'Invoice', null, d('2025-01-04'), null, null, 400],
  ['C010', 'Fayoum Farms', 'RCT-10001', 'Receipt', null, d('2025-02-01'), null, null, -500],
  // A line with no Transaction Id: rejected
  ['C010', 'Fayoum Farms', null, 'Invoice', null, d('2025-03-01'), null, 'missing id', 75],
];

export async function buildSampleXlsx(): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Ledger');
  for (const r of SAMPLE_ROWS) ws.addRow(r);
  ws.getColumn(5).numFmt = 'dd/mm/yyyy';
  ws.getColumn(6).numFmt = 'dd/mm/yyyy';
  ws.getColumn(9).numFmt = '#,##0.00';
  ws.getRow(4).font = { bold: true };
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}
