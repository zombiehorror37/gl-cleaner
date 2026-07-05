// Synthetic GL with planted offsets + decoys, run through engine → verify → export → re-read.
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { buildWorkbook } from '../lib/export';
import { runAccount } from '../lib/engine/run';
import { buildScenario } from '../lib/engine/scenario';
import { verifyApproved } from '../lib/engine/verify';
import { DEFAULT_SEARCH, groupEntryIds, type Entry } from '../lib/engine/types';

let id = 0;
const day = (d: number) => Date.UTC(2026, 0, d);
const mk = (amount: number, docNo: string, desc: string, d: number): Entry => ({
  id: id++,
  account: 'TEST',
  date: day(d),
  docNo,
  docType: 'JE',
  reference: null,
  description: desc,
  amount: Math.round(amount * 100),
  raw: [new Date(day(d)), docNo, desc, 'TEST', amount],
});

// Plant: 10 exact pairs, 5 three-way combos, 3 decoys (no valid offset).
const entries: Entry[] = [];
for (let i = 0; i < 10; i++) {
  const amt = 1000 + i * 137.13;
  entries.push(mk(amt, `${5000 + i * 2}`, `invoice ${i}`, 1 + i));
  entries.push(mk(-amt, `${5001 + i * 2}`, `reversal invoice ${i}`, 2 + i));
}
for (let i = 0; i < 5; i++) {
  const parts = [400 + i * 11.11, 250 + i * 7.77, 100 + i * 3.33];
  const total = parts.reduce((s, x) => s + Math.round(x * 100), 0) / 100;
  parts.forEach((p, j) => entries.push(mk(p, `${6000 + i * 10 + j}`, `partial ${i}.${j}`, 5 + i)));
  entries.push(mk(-total, `${6100 + i}`, `settlement ${i}`, 8 + i));
}
const decoys = [mk(123.45, '9001', 'decoy a', 20), mk(678.9, '9002', 'decoy b', 21), mk(-55.55, '9003', 'decoy c', 22)];
entries.push(...decoys);

describe('synthetic e2e', () => {
  const result = runAccount(entries, { ...DEFAULT_SEARCH, account: 'TEST', nature: 'debit' });

  it('finds all 10 planted pairs', () => {
    expect(result.groups.filter((g) => g.kind === 'pair')).toHaveLength(10);
  });

  it('finds all 5 planted 3-way combos', () => {
    const comboTargets = new Set(
      result.groups.filter((g) => g.kind === 'combo').flatMap((g) => g.targetIds),
    );
    for (let i = 0; i < 5; i++) {
      const settlement = entries.find((e) => e.docNo === `${6100 + i}`)!;
      expect(comboTargets.has(settlement.id)).toBe(true);
    }
  });

  it('never proposes a group containing a decoy', () => {
    const decoyIds = new Set(decoys.map((d) => d.id));
    for (const g of result.groups) {
      for (const e of groupEntryIds(g)) expect(decoyIds.has(e)).toBe(false);
    }
  });

  it('scenario cleans all 40 planted rows, decoys survive', () => {
    // 10 pairs × 2 rows + 5 combos × (3 parts + 1 settlement) = 40 rows.
    const scenario = buildScenario(result.groups);
    expect(scenario.totalEntriesCleaned).toBe(40);
  });

  it('export round-trip: cleaned + removed sheets reconcile', async () => {
    const scenario = buildScenario(result.groups);
    const approvedGroups = result.groups.filter((g) => scenario.chosen.has(g.id));
    const entryMap = new Map(entries.map((e) => [e.id, e]));
    expect(verifyApproved(approvedGroups, entryMap).ok).toBe(true);

    const blob = await buildWorkbook({
      fileName: 'synthetic.xlsx',
      headers: ['Date', 'Doc', 'Description', 'Account', 'Amount'],
      entries,
      approvedGroups,
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await blob.arrayBuffer()));

    const cleaned = wb.getWorksheet('Cleaned GL')!;
    const removed = wb.getWorksheet('Removed Entries')!;
    expect(cleaned.rowCount - 1).toBe(3); // only decoys survive
    expect(removed.rowCount - 1).toBe(40);

    // Removed sheet: group sums must be zero, amounts in col 5.
    const sums = new Map<string, number>();
    removed.eachRow((row, rn) => {
      if (rn === 1) return;
      const gid = String(row.getCell(6).value);
      const amt = Math.round(Number(row.getCell(5).value) * 100);
      sums.set(gid, (sums.get(gid) ?? 0) + amt);
    });
    expect(sums.size).toBe(approvedGroups.length);
    for (const [, s] of sums) expect(s).toBe(0);

    // Cleaned sheet total equals original total (removed sums to zero).
    let cleanedTotal = 0;
    cleaned.eachRow((row, rn) => {
      if (rn === 1) return;
      cleanedTotal += Math.round(Number(row.getCell(5).value) * 100);
    });
    const originalTotal = entries.reduce((s, e) => s + e.amount, 0);
    expect(cleanedTotal).toBe(originalTotal);
  });
});
