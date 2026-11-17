import { describe, expect, it } from 'vitest';
import { validateSheet } from '../lib/parse/validate';
import { cleanLedger } from '../lib/engine/clean';
import { applyDecisions } from '../lib/engine/apply';
import { DEFAULT_SETTINGS, type CleanSettings, type MatchGroup } from '../lib/engine/types';
import { TEMPLATE_HEADERS } from '../lib/template';
import type { CellValue } from '../lib/parse/values';

type Line = [code: string, txn: string, type: string | null, eff: string | null, ref: string | null, desc: string | null, net: number | string];

function run(lines: Line[], over: Partial<CleanSettings> = {}) {
  const matrix: CellValue[][] = [
    TEMPLATE_HEADERS,
    ...lines.map(([code, txn, type, eff, ref, desc, net]) => [code, `Name ${code}`, txn, type, null, eff, ref, desc, net]),
  ];
  const v = validateSheet(matrix);
  expect(v.headerOk).toBe(true);
  const res = cleanLedger(v.rows, { ...DEFAULT_SETTINGS, ...over });
  const txns = (g: MatchGroup) => g.memberIds.map((id) => v.rows[id].transactionId).sort();
  const suggested = res.groups.filter((g) => g.suggested);
  const approveSuggested = () => applyDecisions(v.rows, res.groups, new Set(suggested.map((g) => g.id)));
  return { rows: v.rows, res, txns, suggested, approveSuggested };
}

describe('reference links', () => {
  it('payment citing the invoice clears it', () => {
    const { suggested, txns } = run([
      ['C1', 'INV-1001', 'Invoice', '2025-01-05', null, null, 5000],
      ['C1', 'RCT-55', 'Receipt', '2025-02-01', 'INV-1001', null, -5000],
    ]);
    expect(suggested).toHaveLength(1);
    expect(suggested[0].kind).toBe('linked');
    expect(txns(suggested[0])).toEqual(['INV-1001', 'RCT-55']);
    expect(suggested[0].tier).toBe('high');
  });

  it('one payment citing several invoices in free text ("inv 1001/1002")', () => {
    const { suggested, txns } = run([
      ['C1', 'INV-1001', 'Invoice', '2025-01-05', null, null, 1000],
      ['C1', 'INV-1002', 'Invoice', '2025-01-06', null, null, 2500],
      ['C1', 'RCT-1', 'Receipt', '2025-02-01', null, 'payment inv 1001/1002 thanks', -3500],
    ]);
    expect(suggested.map((g) => g.kind)).toEqual(['linked']);
    expect(txns(suggested[0])).toEqual(['INV-1001', 'INV-1002', 'RCT-1']);
  });

  it('partial payment: the invoice stays open for the remainder', () => {
    const r = run([
      ['C1', 'INV-7', 'Invoice', '2025-01-05', null, null, 10000],
      ['C1', 'RCT-7', 'Receipt', '2025-02-01', 'INV-7', null, -4000],
    ]);
    const g = r.suggested[0];
    expect(g.kind).toBe('partial');
    expect(g.residual).toBe(600000);
    expect(r.rows[g.residualFromId!].transactionId).toBe('INV-7');
    const out = r.approveSuggested();
    expect(out.errors).toEqual([]);
    expect(out.openItems).toHaveLength(1);
    expect(out.openItems[0]).toMatchObject({ kind: 'residual', row: { transactionId: 'INV-7', net: 600000 } });
    expect(out.totals.openNet).toBe(out.totals.originalNet);
  });

  it('partial completed by a second, unreferenced instalment', () => {
    const { suggested, txns } = run([
      ['C1', 'INV-7', 'Invoice', '2025-01-05', null, null, 10000],
      ['C1', 'RCT-7', 'Receipt', '2025-02-01', 'INV-7', null, -4000],
      ['C1', 'RCT-8', 'Receipt', '2025-03-01', null, 'second instalment', -6000],
    ]);
    expect(suggested).toHaveLength(1);
    expect(suggested[0].kind).toBe('linked');
    expect(txns(suggested[0])).toEqual(['INV-7', 'RCT-7', 'RCT-8']);
  });

  it('short payment equal to 1% withholding on the pre-VAT amount is labelled', () => {
    const { suggested } = run([
      ['C1', 'INV-9', 'Invoice', '2025-01-05', null, null, 11400],
      ['C1', 'RCT-9', 'Receipt', '2025-02-01', 'INV-9', null, -11300],
    ]);
    expect(suggested[0].kind).toBe('partial');
    expect(suggested[0].residual).toBe(10000);
    expect(suggested[0].reasons.join(' ')).toMatch(/1% of 10,000\.00 \(amount before 14% VAT/);
  });

  it('overpayment: the payment keeps the unapplied part', () => {
    const { suggested, rows } = run([
      ['C1', 'INV-3', 'Invoice', '2025-01-05', null, null, 1000],
      ['C1', 'RCT-3', 'Receipt', '2025-02-01', 'INV-3', null, -1200],
    ]);
    expect(suggested[0].residual).toBe(-20000);
    expect(rows[suggested[0].residualFromId!].transactionId).toBe('RCT-3');
  });

  it('partial across two invoices applies FIFO: the newer untouched invoice stays fully open', () => {
    const { suggested, txns, rows } = run([
      ['C1', 'INV-1', 'Invoice', '2025-01-01', null, null, 1000],
      ['C1', 'INV-2', 'Invoice', '2025-01-10', null, null, 2000],
      ['C1', 'RCT-1', 'Receipt', '2025-02-01', 'INV-1, INV-2', null, -500],
    ]);
    const g = suggested.find((x) => x.kind === 'partial')!;
    expect(txns(g)).toEqual(['INV-1', 'RCT-1']);
    expect(rows[g.residualFromId!].transactionId).toBe('INV-1');
    expect(g.residual).toBe(50000);
  });
});

describe('same Transaction Id', () => {
  it('posting reversed under the same id', () => {
    const { suggested } = run([
      ['C1', 'INV-5', 'Invoice', '2025-01-05', null, 'Consulting Jan', 1000],
      ['C1', 'INV-5', 'Invoice', '2025-01-06', null, 'Reversal: wrong customer', -1000],
    ]);
    expect(suggested.map((g) => g.kind)).toEqual(['same-id']);
  });

  it('duplicate posting is flagged; only one copy is settled', () => {
    const { suggested, res, txns, approveSuggested } = run([
      ['C1', 'INV-6', 'Invoice', '2025-01-05', null, null, 1000],
      ['C1', 'INV-6', 'Invoice', '2025-01-05', null, null, 1000],
      ['C1', 'RCT-6', 'Receipt', '2025-02-01', 'INV-6', null, -1000],
    ]);
    expect(res.exceptions.some((e) => e.kind === 'duplicate')).toBe(true);
    expect(suggested).toHaveLength(1);
    expect(txns(suggested[0])).toEqual(['INV-6', 'RCT-6']);
    expect(approveSuggested().openItems.map((o) => o.row.transactionId)).toEqual(['INV-6']);
  });
});

describe('amount matching without links', () => {
  it('the only pair of an amount on the contact', () => {
    const { suggested } = run([
      ['C1', 'INV-1', 'Invoice', '2025-01-05', null, null, 777.5],
      ['C1', 'TRF-88', 'Bank transfer', '2025-02-01', null, null, -777.5],
      ['C1', 'INV-2', 'Invoice', '2025-01-05', null, null, 100],
    ]);
    expect(suggested.map((g) => g.kind)).toEqual(['pair']);
  });

  it('identical amounts are paired oldest-first; the newest invoice stays open', () => {
    const { suggested, approveSuggested } = run([
      ['C1', 'INV-3', 'Invoice', '2025-03-01', null, 'Rent Mar', 5000],
      ['C1', 'INV-1', 'Invoice', '2025-01-01', null, 'Rent Jan', 5000],
      ['C1', 'INV-2', 'Invoice', '2025-02-01', null, 'Rent Feb', 5000],
      ['C1', 'TRF-1', 'Transfer', '2025-01-15', null, null, -5000],
      ['C1', 'TRF-2', 'Transfer', '2025-02-15', null, null, -5000],
    ]);
    expect(suggested.map((g) => g.kind)).toEqual(['fifo-pair', 'fifo-pair']);
    expect(approveSuggested().openItems.map((o) => o.row.transactionId)).toEqual(['INV-3']);
  });

  it('one lump payment covering several invoices (unique combination)', () => {
    const { suggested, txns } = run([
      ['C1', 'INV-1', 'Invoice', '2025-01-01', null, null, 1200],
      ['C1', 'INV-2', 'Invoice', '2025-01-02', null, null, 3400],
      ['C1', 'INV-3', 'Invoice', '2025-01-03', null, null, 560],
      ['C1', 'INV-4', 'Invoice', '2025-01-04', null, null, 999],
      ['C1', 'TRF-1', 'Transfer', '2025-02-01', null, null, -5160],
    ]);
    expect(suggested.map((g) => g.kind)).toEqual(['combo']);
    expect(txns(suggested[0])).toEqual(['INV-1', 'INV-2', 'INV-3', 'TRF-1']);
  });

  it('ambiguous combinations are offered as alternatives, never suggested', () => {
    const { suggested, res } = run([
      ['C1', 'INV-1', 'Invoice', '2025-01-01', null, null, 100],
      ['C1', 'INV-2', 'Invoice', '2025-01-02', null, null, 200],
      ['C1', 'INV-3', 'Invoice', '2025-01-03', null, null, 300],
      ['C1', 'INV-4', 'Invoice', '2025-01-04', null, null, 400],
      ['C1', 'TRF-1', 'Transfer', '2025-02-01', null, null, -500],
    ]);
    expect(suggested).toHaveLength(0);
    const alts = res.groups.filter((g) => g.kind === 'combo');
    expect(alts.length).toBe(2);
    expect(new Set(alts.map((g) => g.altKey)).size).toBe(1);
    expect(res.exceptions.some((e) => e.kind === 'ambiguous')).toBe(true);
  });

  it('a contact whose remaining lines net to zero is cleared as a whole', () => {
    const { suggested } = run([
      ['C1', 'INV-1', 'Invoice', '2025-01-01', null, null, 700],
      ['C1', 'INV-2', 'Invoice', '2025-01-02', null, null, 300],
      ['C1', 'TRF-1', 'Transfer', '2025-02-01', null, null, -600],
      ['C1', 'TRF-2', 'Transfer', '2025-02-02', null, null, -400],
    ]);
    expect(suggested.map((g) => g.kind)).toEqual(['nil']);
  });
});

describe('near misses and balance-forward', () => {
  it('near miss within tolerance needs individual approval', () => {
    const { suggested, res } = run([
      ['C1', 'INV-1', 'Invoice', '2025-01-01', null, null, 10000],
      ['C1', 'TRF-1', 'Transfer', '2025-02-01', null, null, -9995],
    ]);
    expect(suggested).toHaveLength(0);
    const near = res.groups.find((g) => g.kind === 'near')!;
    expect(near.individualOnly).toBe(true);
    expect(near.residual).toBe(500);
    expect(near.reasons[0]).toMatch(/short by 5\.00/);
  });

  it('no near miss beyond tolerance', () => {
    const { res } = run([
      ['C1', 'INV-1', 'Invoice', '2025-01-01', null, null, 10000],
      ['C1', 'TRF-1', 'Transfer', '2025-02-01', null, null, -9850], // 1.5%: no withholding rate, beyond tolerance
    ], { balanceForward: false });
    expect(res.groups).toHaveLength(0);
  });

  it('withholding at 3% is proposed even beyond the amount tolerance', () => {
    const { res } = run([
      ['C1', 'INV-1', 'Invoice', '2025-01-01', null, null, 10000],
      ['C1', 'TRF-1', 'Transfer', '2025-02-01', null, null, -9700],
    ]);
    const near = res.groups.find((g) => g.kind === 'near')!;
    expect(near.reasons[0]).toMatch(/3% of 10,000\.00/);
  });

  it('balance-forward applies unmatched payments to the oldest invoices', () => {
    const { res, rows } = run([
      ['C1', 'INV-1', 'Invoice', '2025-01-01', null, null, 1000],
      ['C1', 'INV-2', 'Invoice', '2025-02-01', null, null, 2000],
      ['C1', 'INV-3', 'Invoice', '2025-03-01', null, null, 3000],
      ['C1', 'TRF-1', 'Transfer', '2025-02-10', null, null, -1500],
      ['C1', 'TRF-2', 'Transfer', '2025-03-10', null, null, -700],
    ]);
    const fifo = res.groups.find((g) => g.kind === 'fifo')!;
    expect(fifo.suggested).toBe(false);
    expect(fifo.memberIds.map((id) => rows[id].transactionId).sort()).toEqual(['INV-1', 'INV-2', 'TRF-1', 'TRF-2']);
    expect(rows[fifo.residualFromId!].transactionId).toBe('INV-2');
    expect(fifo.residual).toBe(80000);
    const out = applyDecisions(rows, res.groups, new Set([fifo.id]));
    expect(out.errors).toEqual([]);
    expect(out.openItems.map((o) => [o.row.transactionId, o.row.net])).toEqual([
      ['INV-2', 80000],
      ['INV-3', 300000],
    ]);
  });
});

describe('ledger sign and cross-contact checks', () => {
  it('payables: bills negative, payments positive, no sign warnings', () => {
    const { suggested, res } = run(
      [
        ['S1', 'BILL-1', 'Invoice', '2025-01-01', null, null, -800],
        ['S1', 'PV-1', 'Payment', '2025-02-01', 'BILL-1', null, 800],
      ],
      { invoiceSign: -1 },
    );
    expect(suggested.map((g) => g.kind)).toEqual(['linked']);
    expect(res.exceptions.some((e) => e.kind === 'sign')).toBe(false);
  });

  it('the wrong ledger sign shows up as sign warnings', () => {
    const { res } = run([
      ['S1', 'BILL-1', 'Invoice', '2025-01-01', null, null, -800],
      ['S1', 'PV-1', 'Payment', '2025-02-01', null, null, 300],
    ]);
    expect(res.exceptions.find((e) => e.kind === 'sign')?.rowIds).toHaveLength(2);
  });

  it('payment on the wrong contact is flagged, not cleared', () => {
    const { suggested, res } = run([
      ['C1', 'INV-7701', 'Invoice', '2025-01-01', null, null, 900],
      ['C2', 'INV-8801', 'Invoice', '2025-01-01', null, null, 50],
      ['C2', 'RCT-5', 'Receipt', '2025-02-01', 'INV-7701', null, -900],
    ]);
    expect(suggested).toHaveLength(0);
    expect(res.exceptions.find((e) => e.kind === 'misposting')?.message).toMatch(/cites INV-7701, which is open on C1/);
  });

  it('zero lines clear themselves; credit balances and unapplied cash are reported', () => {
    const { suggested, res } = run([
      ['C1', 'INV-1', 'Invoice', '2025-01-01', null, null, 0],
      ['C1', 'RCT-1', 'Receipt', '2025-01-01', null, null, -250],
    ]);
    expect(suggested.map((g) => g.kind)).toEqual(['zero']);
    const kinds = res.exceptions.map((e) => e.kind);
    expect(kinds).toContain('unapplied');
    expect(kinds).toContain('opposite-balance');
  });
});

describe('apply invariants', () => {
  it('refuses conflicting approvals', () => {
    const { res, rows } = run([
      ['C1', 'INV-1', 'Invoice', '2025-01-01', null, null, 100],
      ['C1', 'INV-2', 'Invoice', '2025-01-02', null, null, 200],
      ['C1', 'INV-3', 'Invoice', '2025-01-03', null, null, 300],
      ['C1', 'INV-4', 'Invoice', '2025-01-04', null, null, 400],
      ['C1', 'TRF-1', 'Transfer', '2025-02-01', null, null, -500],
    ]);
    const alts = res.groups.filter((g) => g.kind === 'combo');
    const out = applyDecisions(rows, res.groups, new Set(alts.map((g) => g.id)));
    expect(out.errors.join(' ')).toMatch(/two approved matches/);
  });

  it('approving everything suggested keeps the balance', () => {
    const r = run([
      ['C1', 'INV-1', 'Invoice', '2025-01-01', null, null, 1000],
      ['C1', 'RCT-1', 'Receipt', '2025-01-20', 'INV-1', null, -400],
      ['C2', 'INV-2', 'Invoice', '2025-01-01', null, null, 300],
      ['C2', 'RCT-2', 'Receipt', '2025-01-20', null, null, -300],
      ['C3', 'INV-3', 'Invoice', '2025-01-01', null, null, 50],
    ]);
    const out = r.approveSuggested();
    expect(out.errors).toEqual([]);
    expect(out.totals.openNet).toBe(out.totals.originalNet);
    expect(out.openItems.map((o) => [o.row.transactionId, o.kind])).toEqual([
      ['INV-1', 'residual'],
      ['INV-3', 'original'],
    ]);
  });
});

describe('GL accounts (accruals, reversals, SAP exports)', () => {
  const gl = { glAccount: true } as const;

  it('links an accrual to its reversal by description keys (meter + period)', () => {
    const { suggested, res } = run(
      [
        ['0052701001', '0500003782', 'AB', '2025-01-31', null, 'ACC-1/2025E06-ELEC', 2418999.8],
        ['0052701001', '0500003783', 'AB', '2025-01-31', null, 'ACC-1/2025E07-ELEC', 3187883.53],
        ['0052701001', '0500004314', 'AB', '2025-02-24', null, 'R/ACR E06 1/25', -2418999.8],
        ['0052701001', '0500004305', 'AB', '2025-02-24', null, 'R/ACR E7 1/25', -3360780.53],
      ],
      gl,
    );
    expect(suggested).toHaveLength(1);
    expect(suggested[0]).toMatchObject({ kind: 'linked' });
    expect(suggested[0].reasons[0]).toMatch(/same description keys \(E6 · 01\/2025\)/);
    const partial = res.groups.find((g) => g.kind === 'partial')!;
    expect(partial.suggested).toBe(false);
    expect(partial.reasons.join(' ')).toMatch(/credit exceeds the debit by 172,897\.00/);
  });

  it('no balance-forward, no "unapplied cash" wording, no tiny near misses', () => {
    const { res } = run(
      [
        ['GL1', 'D1', 'AB', '2025-03-09', null, 'adj', -0.1],
        ['GL1', 'D2', 'AB', '2025-07-29', null, 'ADJ', 0.5],
        ['GL1', 'D3', 'AB', '2025-01-05', null, null, 3077537.17],
        ['GL1', 'D4', 'AB', '2025-01-19', null, 'R/ACR E7 12/24', -3077605.07],
      ],
      gl,
    );
    expect(res.groups.map((g) => g.kind)).toEqual([]);
    const kinds = res.exceptions.map((e) => e.kind);
    expect(kinds).not.toContain('unapplied');
    expect(kinds).toContain('other-period');
  });

  it('flags descriptions whose Arabic text was lost in the export', () => {
    const { res } = run([['GL1', 'D1', 'AB', '2025-03-09', null, '##### #### ##### E08', -0.1]], gl);
    expect(res.exceptions.find((e) => e.kind === 'lost-text')?.message).toMatch(/replaced non-Latin \(Arabic\) text/);
  });

  it('understands SAP document type codes', async () => {
    const { classifyDocument } = await import('../lib/parse/doc-class');
    expect(['DR', 'KR', 'DZ', 'KZ', 'DG', 'SA', 'AB'].map((c) => classifyDocument(c, '0100000001', null))).toEqual([
      'invoice', 'invoice', 'payment', 'payment', 'credit_note', 'journal', 'journal',
    ]);
  });
});

describe('review fixes', () => {
  it('GL file with several accounts: journals hitting two accounts are not flagged', () => {
    const { res, suggested } = run(
      [
        ['52701001', '0500003782', 'AB', '2025-01-31', null, 'ACC-1/2025E06-ELEC', 2418999.8],
        ['21100001', '0500003782', 'AB', '2025-01-31', null, 'ACC-1/2025E06-ELEC', -2418999.8],
        ['52701001', '0500004314', 'AB', '2025-02-24', null, 'R/ACR E6 1/25', -2418999.8],
        ['21100001', '0500004314', 'AB', '2025-02-24', null, 'R/ACR E6 1/25', 2418999.8],
      ],
      { glAccount: true },
    );
    expect(suggested).toHaveLength(2);
    expect(res.exceptions.filter((e) => e.kind === 'shared-id' || e.kind === 'misposting')).toEqual([]);
  });

  it('an amount-only combination from round amounts is proposed, not suggested', () => {
    // Powers of two: exactly one combination (1,000 + 2,000 + 4,000) clears 7,000, but every amount is round.
    const lines: Line[] = [1, 2, 4, 8, 16, 32, 64].map((k, i) => ['C1', `INV-${i}`, 'Invoice', '2025-01-01', null, null, k * 1000] as Line);
    lines.push(['C1', 'TRF-1', 'Transfer', '2025-02-01', null, null, -7000]);
    const { res, suggested } = run(lines, { balanceForward: false });
    const combo = res.groups.find((g) => g.kind === 'combo')!;
    expect(combo.memberIds).toHaveLength(4);
    expect(combo.suggested).toBe(false);
    expect(combo.reasons.join(' ')).toMatch(/amount-only.*by chance/);
    expect(suggested).toHaveLength(0);
  });

  it('coincidence risk: tiny for a few odd amounts, large for round numbers', async () => {
    const { coincidenceRisk } = await import('../lib/engine/clean');
    expect(coincidenceRisk([120000, 340000, 56000, 99900], 516000, 6)).toBeLessThan(0.01);
    expect(coincidenceRisk(Array.from({ length: 30 }, (_, i) => ((i % 7) + 1) * 1000000), 15000000, 6)).toBeGreaterThan(1);
  });
});
