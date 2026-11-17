import { describe, expect, it } from 'vitest';
import { cleanLedger } from '../lib/engine/clean';
import { applyDecisions } from '../lib/engine/apply';
import { DEFAULT_SETTINGS } from '../lib/engine/types';
import type { LedgerRow } from '../lib/parse/validate';

/** Deterministic PRNG so the generated ledger is the same every run. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

function synthetic(contacts: number, invoicesPer: number, seed = 7): LedgerRow[] {
  const rand = rng(seed);
  const rows: LedgerRow[] = [];
  const push = (c: number, txn: string, net: number, day: number, ref: string | null) =>
    rows.push({
      id: rows.length,
      sourceRow: rows.length + 2,
      contactCode: `C${c}`,
      contactName: `Contact ${c}`,
      transactionId: txn,
      documentType: net > 0 ? 'Invoice' : 'Receipt',
      dueDate: null,
      effectiveDate: `2025-${String(1 + (day % 12)).padStart(2, '0')}-${String(1 + (day % 28)).padStart(2, '0')}`,
      reference: ref,
      description: null,
      net,
      contactKey: `C${c}`,
      txnKey: txn.replace(/\W/g, ''),
      docClass: net > 0 ? 'invoice' : 'payment',
    });
  for (let c = 0; c < contacts; c++) {
    for (let i = 0; i < invoicesPer; i++) {
      const amt = Math.round(rand() * 5_000_000) + 100;
      const inv = `INV-${c}-${i}`;
      push(c, inv, amt, i, null);
      const roll = rand();
      if (roll < 0.4) push(c, `R-${c}-${i}`, -amt, i + 20, inv);
      else if (roll < 0.6) push(c, `R-${c}-${i}`, -amt, i + 20, null);
      else if (roll < 0.7) push(c, `R-${c}-${i}`, -Math.round(amt / 2), i + 20, inv);
    }
  }
  return rows;
}

describe('performance', () => {
  it('20k lines across 500 contacts', () => {
    const rows = synthetic(500, 26);
    const t0 = Date.now();
    const res = cleanLedger(rows, DEFAULT_SETTINGS);
    const ms = Date.now() - t0;
    const out = applyDecisions(rows, res.groups, new Set(res.groups.filter((g) => g.suggested).map((g) => g.id)));
    expect(out.errors).toEqual([]);
    expect(out.totals.openNet).toBe(out.totals.originalNet);
    expect(ms).toBeLessThan(30_000);
    console.log(`20k lines: ${rows.length} rows, ${res.groups.length} groups, ${ms} ms`);
  }, 60_000);

  it('one very large contact stays within the time budget', () => {
    const rows = synthetic(1, 2500, 11);
    const t0 = Date.now();
    const res = cleanLedger(rows, { ...DEFAULT_SETTINGS, totalComboBudgetMs: 10_000 });
    const ms = Date.now() - t0;
    expect(applyDecisions(rows, res.groups, new Set(res.groups.filter((g) => g.suggested).map((g) => g.id))).errors).toEqual([]);
    expect(ms).toBeLessThan(25_000);
    console.log(`big contact: ${rows.length} rows, ${res.groups.length} groups, ${ms} ms`);
  }, 60_000);
});
