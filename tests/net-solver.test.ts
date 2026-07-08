import { describe, expect, it } from 'vitest';
import { reconstructSubset, solveGlobalNet } from '../lib/engine/net-solver';
import { runAccount } from '../lib/engine/run';
import { DEFAULT_SEARCH, groupEntryIds, type Entry } from '../lib/engine/types';

let nextId = 0;
const entry = (amount: number): Entry => ({
  id: nextId++,
  account: 'A',
  date: null,
  docNo: null,
  docType: null,
  reference: null,
  description: null,
  amount: Math.round(amount * 100),
  raw: [],
});

describe('reconstructSubset', () => {
  it('finds an exact subset and respects 0/1 usage', () => {
    const values = [500, 300, 200, 700];
    const sub = reconstructSubset(values, 1000)!;
    expect(sub.reduce((s, i) => s + values[i], 0)).toBe(1000);
    expect(new Set(sub).size).toBe(sub.length);
  });
  it('returns null when no subset exists', () => {
    expect(reconstructSubset([200, 400], 500)).toBeNull();
  });
  it('GCD-reduces large targets', () => {
    // Everything multiple of 100 → reduced space is small even for big cents.
    const values = [50_000_000, 30_000_000, 20_000_000, 70_000_000];
    const sub = reconstructSubset(values, 100_000_000)!;
    expect(sub.reduce((s, i) => s + values[i], 0)).toBe(100_000_000);
  });
  it('deterministic', () => {
    const values = [500, 300, 200, 700, 800, 100];
    expect(reconstructSubset(values, 1000)).toEqual(reconstructSubset(values, 1000));
  });
});

describe('solveGlobalNet', () => {
  it('clears 100% of negatives when a positive subset exists (attempt A)', () => {
    nextId = 0;
    const negs = [entry(-1234.56), entry(-77.44), entry(-9000)];
    const pos = [entry(5000), entry(4000), entry(312), entry(1000), entry(700), entry(300)];
    // need = 10312.00; subset: 5000+4000+312+1000 = 10312
    const res = solveGlobalNet([...negs, ...pos], 'negative', 'A');
    expect(res.report.method).toBe('exact');
    expect(res.report.clearedTargets).toBe(3);
    expect(res.report.strandedTargetIds).toHaveLength(0);
    const all = new Map([...negs, ...pos].map((e) => [e.id, e]));
    const sum = groupEntryIds(res.group!).reduce((s, id) => s + all.get(id)!.amount, 0);
    expect(sum).toBe(0);
  });

  it('drops uncleaable negatives and clears the rest (attempt B)', () => {
    nextId = 0;
    // -0.03 can never be built from these positives; -700 can.
    const negs = [entry(-700), entry(-0.03)];
    const pos = [entry(400), entry(300), entry(500)];
    const res = solveGlobalNet([...negs, ...pos], 'negative', 'A');
    expect(res.report.method).toBe('partial');
    expect(res.report.clearedTargets).toBe(1);
    expect(res.report.strandedTargetIds).toHaveLength(1);
    const all = new Map([...negs, ...pos].map((e) => [e.id, e]));
    expect(groupEntryIds(res.group!).reduce((s, id) => s + all.get(id)!.amount, 0)).toBe(0);
  });

  it('handles no offsets at all', () => {
    nextId = 0;
    const res = solveGlobalNet([entry(-5), entry(-10)], 'negative', 'A');
    expect(res.group).toBeNull();
    expect(res.report.strandedTargetIds).toHaveLength(2);
  });

  it('positive side clearing works (credit-nature accounts)', () => {
    nextId = 0;
    const res = solveGlobalNet([entry(600), entry(-400), entry(-200)], 'positive', 'A');
    expect(res.report.method).toBe('exact');
    expect(res.report.clearedTargets).toBe(1);
  });
});

describe('pipeline with global net', () => {
  it('one run leaves zero clearable negatives open', () => {
    nextId = 0;
    const entries = [
      // pair
      entry(500),
      entry(-500),
      // combo target
      entry(-1000),
      entry(700),
      entry(300),
      // messy rest: negatives clearable only via the global sweep
      entry(-850),
      entry(-150),
      entry(600),
      entry(250),
      entry(120),
      entry(30),
      entry(9999), // surplus positive that stays open
    ];
    const res = runAccount(entries, { ...DEFAULT_SEARCH, account: 'A', nature: 'debit' });
    const suggested = res.groups.filter((g) => g.inScenario);
    const used = new Set(suggested.flatMap((g) => groupEntryIds(g)));
    const openNegs = entries.filter((e) => e.amount < 0 && !used.has(e.id));
    expect(openNegs).toHaveLength(0);
    expect(res.netReport).not.toBeNull();
    // every suggested group zero-sum
    const map = new Map(entries.map((e) => [e.id, e]));
    for (const g of suggested) {
      expect(groupEntryIds(g).reduce((s, id) => s + map.get(id)!.amount, 0)).toBe(0);
    }
  });
});
