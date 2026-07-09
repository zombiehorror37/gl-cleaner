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
  // -90 can only be cleared by 30+30+30 (three offsets) — beyond the maxComboSize=2
  // cap, so no evidenced combo covers it and it survives into the residual for the
  // unbounded net sweep. That makes the net genuinely necessary here.
  const messyEntries = () => {
    nextId = 0;
    return [
      entry(500), // pair …
      entry(-500),
      entry(-90), // needs 30+30+30 → 3 offsets, above the cap
      entry(30),
      entry(30),
      entry(30),
      entry(7777), // surplus positive that stays open
    ];
  };
  const cfg = { ...DEFAULT_SEARCH, account: 'A', nature: 'debit' as const, maxComboSize: 2 };

  it('the net sweep is a low-confidence last resort, never in the suggested scenario', () => {
    const res = runAccount(messyEntries(), cfg);
    const net = res.groups.find((g) => g.kind === 'net');
    expect(net).toBeDefined();
    // Netting is a balancing action, not evidence: kept out of the auto-suggested
    // cleanup and honestly scored below the medium tier no matter how much it clears.
    expect(net!.inScenario).toBe(false);
    expect(net!.tier).toBe('low');
    expect(res.groups.filter((g) => g.inScenario).some((g) => g.kind === 'net')).toBe(false);
  });

  it('suggested cleanup + the net sweep together leave zero clearable negatives open', () => {
    const entries = messyEntries();
    const res = runAccount(entries, cfg);
    // Evidenced scenario alone does NOT clear the -90 — that is the honest state now;
    // the residual is cleared only by explicitly running the net.
    const suggested = res.groups.filter((g) => g.inScenario);
    const suggestedUsed = new Set(suggested.flatMap((g) => groupEntryIds(g)));
    expect(entries.some((e) => e.amount < 0 && !suggestedUsed.has(e.id))).toBe(true);

    const cleared = [...suggested, ...res.groups.filter((g) => g.kind === 'net')];
    const used = new Set(cleared.flatMap((g) => groupEntryIds(g)));
    // scenario groups and the net sweep are mutually disjoint by construction.
    expect(used.size).toBe(cleared.reduce((s, g) => s + groupEntryIds(g).length, 0));
    const openNegs = entries.filter((e) => e.amount < 0 && !used.has(e.id));
    expect(openNegs).toHaveLength(0);
    expect(res.netReport).not.toBeNull();
    const map = new Map(entries.map((e) => [e.id, e]));
    for (const g of cleared) {
      expect(groupEntryIds(g).reduce((s, id) => s + map.get(id)!.amount, 0)).toBe(0);
    }
  });
});
