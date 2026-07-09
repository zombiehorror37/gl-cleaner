import { describe, expect, it } from 'vitest';
import { fromCents, gcd, toCents } from '../lib/engine/cents';
import { subsetSumReachable } from '../lib/engine/bitset-dp';
import { findExactPairs } from '../lib/engine/pass1-pairs';
import { findCombos, searchCombosForTarget } from '../lib/engine/pass2-subset';
import { findDeepGroups } from '../lib/engine/pass3-deep';
import { buildScenario } from '../lib/engine/scenario';
import { reconcile, verifyApproved } from '../lib/engine/verify';
import { runAccount } from '../lib/engine/run';
import {
  DEFAULT_SEARCH,
  groupEntryIds,
  type AccountConfig,
  type Entry,
  type SearchConfig,
} from '../lib/engine/types';

let nextId = 0;
const entry = (amount: number, over: Partial<Entry> = {}): Entry => ({
  id: over.id ?? nextId++,
  account: 'A',
  date: null,
  docNo: null,
  docType: null,
  reference: null,
  description: null,
  amount: Math.round(amount * 100),
  raw: [],
  ...over,
  ...(over.amount !== undefined ? { amount: over.amount } : {}),
});

const config = (over: Partial<SearchConfig> = {}): AccountConfig => ({
  ...DEFAULT_SEARCH,
  account: 'A',
  nature: 'debit',
  ...over,
});

describe('toCents', () => {
  it('parses numbers without float drift', () => {
    expect(toCents(3343.91)).toBe(334391);
    expect(toCents(0.1 + 0.2)).toBe(30); // 0.30000000000000004
    expect(toCents(-73000)).toBe(-7300000);
    expect(toCents(2834530)).toBe(283453000);
  });
  it('parses strings with separators, parentheses, currency', () => {
    expect(toCents('1,234.56')).toBe(123456);
    expect(toCents('(500.00)')).toBe(-50000);
    expect(toCents('-1,000')).toBe(-100000);
    expect(toCents('EGP 12.345')).toBe(1235); // rounds half-up at precision 2
    expect(toCents('١٢٣٫٤٥')).toBe(12345); // Arabic-Indic digits
  });
  it('rejects garbage', () => {
    expect(toCents('')).toBeNull();
    expect(toCents(null)).toBeNull();
    expect(toCents('abc')).toBeNull();
    expect(toCents('1-2')).toBeNull();
    expect(toCents(NaN)).toBeNull();
  });
  it('round-trips with fromCents', () => {
    expect(fromCents(123456)).toBe('1,234.56');
    expect(fromCents(-50)).toBe('-0.50');
  });
  it('gcd', () => {
    expect(gcd(100, 250)).toBe(50);
    expect(gcd(7, 13)).toBe(1);
  });
});

describe('subsetSumReachable oracle', () => {
  it('proves reachable', () => {
    expect(subsetSumReachable([100, 200, 300], 500)).toBe('reachable');
    expect(subsetSumReachable([100, 200, 300], 600)).toBe('reachable');
  });
  it('proves unreachable', () => {
    expect(subsetSumReachable([100, 200, 300], 50)).toBe('unreachable');
    expect(subsetSumReachable([200, 400], 500)).toBe('unreachable');
    expect(subsetSumReachable([], 500)).toBe('unreachable');
  });
  it('uses gcd reduction for large targets', () => {
    // All multiples of 100 → reduced space
    expect(subsetSumReachable([100_000_00, 183_453_000 - 100_000_00], 183_453_000)).toBe('reachable');
  });
});

describe('pass 1 exact pairs', () => {
  it('finds simple pairs and leaves rest', () => {
    nextId = 0;
    const es = [entry(500), entry(-500), entry(300), entry(-200)];
    const { groups, consumedIds } = findExactPairs(es, 'A');
    expect(groups).toHaveLength(1);
    // No documentary evidence → the pair is proposed but must NOT consume its
    // entries from the deeper search, and must not be an evidenced match.
    expect(groups[0].evidenced).toBe(false);
    expect(consumedIds.size).toBe(0);
    const sum = groupEntryIds(groups[0]).reduce((s, id) => s + es.find((e) => e.id === id)!.amount, 0);
    expect(sum).toBe(0);
  });
  it('a decisively evidenced pair consumes its entries; a weak one does not', () => {
    nextId = 0;
    const es = [
      entry(500, { docNo: '1000' }),
      entry(-500, { docNo: '1000' }), // identical doc → high tier
      entry(300, { docNo: '2000' }),
      entry(-300, { docNo: '9000' }), // same amount, unrelated docs → unevidenced
    ];
    const { groups, consumedIds } = findExactPairs(es, 'A');
    expect(groups).toHaveLength(2);
    const strong = groups.find((g) => g.offsetIds.includes(0))!;
    const weak = groups.find((g) => g.offsetIds.includes(2))!;
    expect(strong.evidenced).toBe(true);
    expect(strong.tier).toBe('high');
    expect(weak.evidenced).toBe(false);
    expect(consumedIds).toEqual(new Set([0, 1]));
  });
  it('ambiguous cluster: proposes min(pos,neg) pairs and reports cluster', () => {
    nextId = 0;
    const es = [entry(500), entry(500), entry(500), entry(-500), entry(-500)];
    const { groups, clusters } = findExactPairs(es, 'A');
    expect(groups).toHaveLength(2);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].positiveIds).toHaveLength(3);
    expect(clusters[0].negativeIds).toHaveLength(2);
    for (const g of groups) expect(g.clusterKey).toBe(clusters[0].key);
  });
  it('prefers doc-adjacent pairing in ambiguous cluster', () => {
    nextId = 0;
    const es = [
      entry(500, { docNo: '1000' }),
      entry(500, { docNo: '5000' }),
      entry(-500, { docNo: '1001' }),
    ];
    const { groups } = findExactPairs(es, 'A');
    expect(groups).toHaveLength(1);
    expect(groups[0].offsetIds).toEqual([0]); // doc 1000 adjacent to 1001
  });
});

describe('pass 2 subset-sum', () => {
  it('finds 1-to-3 combo exactly', () => {
    nextId = 0;
    const target = entry(-1000);
    const pool = [entry(700), entry(200), entry(100), entry(333.33)];
    const res = searchCombosForTarget(target, pool, config());
    expect(res.totalFound).toBe(1);
    const sum = res.combos[0].reduce((s, e) => s + e.amount, 0);
    expect(sum).toBe(100000);
    expect(res.exhausted).toBe(true);
  });
  it('near-miss by 0.01 never matches', () => {
    nextId = 0;
    const target = entry(-1000);
    const pool = [entry(700), entry(299.99)];
    const res = searchCombosForTarget(target, pool, config());
    expect(res.totalFound).toBe(0);
    expect(res.proven).toBe(true); // oracle proof
  });
  it('finds all alternative combos when ambiguous', () => {
    nextId = 0;
    const target = entry(-600);
    const pool = [entry(400), entry(200), entry(300), entry(300), entry(100), entry(500)];
    // 400+200, 300+300, 500+100, 400+100+... let's count: 600 from subsets ≤5:
    // {400,200},{300,300},{500,100},{200,300,100}x2,{400,... } etc.
    const res = searchCombosForTarget(target, pool, config());
    expect(res.totalFound).toBeGreaterThanOrEqual(5);
    for (const c of res.combos) {
      expect(c.reduce((s, e) => s + e.amount, 0)).toBe(60000);
    }
  });
  it('respects maxComboSize cap', () => {
    nextId = 0;
    const target = entry(-500);
    const pool = [entry(100), entry(100), entry(100), entry(100), entry(100)];
    const res2 = searchCombosForTarget(target, pool, config({ maxComboSize: 4 }));
    expect(res2.totalFound).toBe(0);
    const res5 = searchCombosForTarget(target, pool, config({ maxComboSize: 5 }));
    expect(res5.totalFound).toBe(1);
  });
  it('deterministic across runs', () => {
    nextId = 0;
    const target = entry(-600);
    const pool = [entry(400), entry(200), entry(300), entry(300), entry(100), entry(500)];
    const a = searchCombosForTarget(target, pool, config());
    const b = searchCombosForTarget(target, pool, config());
    expect(JSON.stringify(a.combos.map((c) => c.map((e) => e.id)))).toBe(
      JSON.stringify(b.combos.map((c) => c.map((e) => e.id))),
    );
  });
  it('every proposed group sums to zero (findCombos)', () => {
    nextId = 0;
    const targets = [entry(-1000), entry(-750)];
    const pool = [entry(700), entry(300), entry(500), entry(250), entry(400)];
    const { groups } = findCombos(targets, pool, 'A', config());
    const all = new Map([...targets, ...pool].map((e) => [e.id, e]));
    for (const g of groups) {
      const sum = groupEntryIds(g).reduce((s, id) => s + all.get(id)!.amount, 0);
      expect(sum).toBe(0);
    }
    expect(groups.length).toBeGreaterThan(0);
  });
  it('labels unmatchable targets with proof', () => {
    nextId = 0;
    const targets = [entry(-999.97)];
    const pool = [entry(500), entry(400)];
    const { outcomes } = findCombos(targets, pool, 'A', config());
    expect(outcomes[0].status).toBe('proven-unmatchable');
  });
  it('branch-and-bound path (n > MITM limit) agrees with zero-sum invariant', () => {
    nextId = 0;
    // 40 candidates forces the DFS path.
    const pool = Array.from({ length: 40 }, (_, i) => entry(10 + i));
    const target = entry(-(10 + 11 + 12)); // 33 = three smallest
    const res = searchCombosForTarget(target, pool, config({ maxComboSize: 3 }));
    expect(res.totalFound).toBeGreaterThanOrEqual(1);
    for (const c of res.combos) {
      expect(c.reduce((s, e) => s + e.amount, 0)).toBe(3300);
    }
    expect(res.exhausted).toBe(true);
  });
});

describe('pass 3 deep search', () => {
  it('finds a DOCUMENTED 2-target-to-2-offset group', () => {
    nextId = 0;
    const targets = [entry(-600, { docNo: '800' }), entry(-400, { docNo: '801' })];
    const pool = [entry(700, { docNo: '802' }), entry(300, { docNo: '803' })];
    const { groups } = findDeepGroups(targets, pool, 'A', config({ deepSearch: true }));
    expect(groups.length).toBeGreaterThanOrEqual(1);
    const all = new Map([...targets, ...pool].map((e) => [e.id, e]));
    for (const g of groups) {
      expect(g.evidenced).toBe(true);
      const sum = groupEntryIds(g).reduce((s, id) => s + all.get(id)!.amount, 0);
      expect(sum).toBe(0);
    }
  });
  it('suppresses undocumented many-to-many coincidences entirely', () => {
    nextId = 0;
    const targets = [entry(-600), entry(-400)];
    const pool = [entry(700), entry(300)];
    const { groups } = findDeepGroups(targets, pool, 'A', config({ deepSearch: true }));
    expect(groups).toHaveLength(0);
  });
});

describe('scenario optimizer', () => {
  it('picks non-overlapping max-weight set', () => {
    nextId = 0;
    const t1 = entry(-600);
    const a = entry(400);
    const b = entry(200);
    const c = entry(600);
    const t2 = entry(-400);
    // Groups: G1 = t1+[a,b], G2 = t1+[c], G3 = t2+[a]
    // G1 conflicts G2 (t1) and G3 (a). Best: G2+G3 (2+2 entries + confidences) vs G1 (3).
    const { groups } = findCombos([t1, t2], [a, b, c], 'A', config());
    const scenario = buildScenario(groups);
    // chosen groups must be disjoint
    const seen = new Set<number>();
    for (const id of scenario.chosen) {
      const g = groups.find((x) => x.id === id)!;
      for (const e of groupEntryIds(g)) {
        expect(seen.has(e)).toBe(false);
        seen.add(e);
      }
    }
    expect(scenario.totalEntriesCleaned).toBeGreaterThanOrEqual(4);
  });
});

describe('verify', () => {
  it('rejects non-zero groups and double-used entries', () => {
    nextId = 0;
    const e1 = entry(500);
    const e2 = entry(-500);
    const e3 = entry(-400);
    const map = new Map([e1, e2, e3].map((e) => [e.id, e]));
    const good = {
      id: 'g1', account: 'A', kind: 'pair' as const, targetIds: [e2.id], offsetIds: [e1.id],
      confidence: 80, tier: 'high' as const, reasons: [], evidenced: true, clusterKey: null, inScenario: false, altKey: null,
    };
    const bad = { ...good, id: 'g2', targetIds: [e3.id] };
    expect(verifyApproved([good], map).ok).toBe(true);
    expect(verifyApproved([bad], map).ok).toBe(false);
    expect(verifyApproved([good, { ...good, id: 'g3' }], map).ok).toBe(false); // reuse
  });
  it('reconcile balances', () => {
    nextId = 0;
    const es = [entry(500), entry(-500), entry(123)];
    const r = reconcile(es, new Set([0, 1]));
    expect(r.balanced).toBe(true);
    expect(r.cleanedTotal).toBe(12300);
  });
});

describe('runAccount end-to-end', () => {
  it('suspense nature searches both directions', () => {
    nextId = 0;
    const es = [
      entry(-1000), // neg target ← 600+400
      entry(600),
      entry(400),
      entry(750), // pos target ← -500-250
      entry(-500),
      entry(-250),
    ];
    const res = runAccount(es, config({ }) , undefined);
    const suspense = runAccount(es, { ...config(), nature: 'suspense' });
    // debit nature: only neg targets get combos → 750 target unmatched
    const debitCombosForPos = res.groups.filter((g) => g.kind === 'combo' && g.targetIds.includes(3));
    expect(debitCombosForPos).toHaveLength(0);
    const suspenseCombosForPos = suspense.groups.filter((g) => g.kind === 'combo' && g.targetIds.includes(3));
    expect(suspenseCombosForPos.length).toBeGreaterThanOrEqual(1);
  });
  it('zero-amount rows never match', () => {
    nextId = 0;
    const es = [entry(0), entry(0), entry(100), entry(-100)];
    const res = runAccount(es, config());
    for (const g of res.groups) {
      expect(groupEntryIds(g)).not.toContain(0);
      expect(groupEntryIds(g)).not.toContain(1);
    }
  });
});

describe('evidence gate', () => {
  it('unevidenced groups never enter the suggested scenario', () => {
    nextId = 0;
    // Exact pair with zero documentary corroboration = amount coincidence.
    const es = [entry(500), entry(-500)];
    const res = runAccount(es, config());
    const pair = res.groups.find((g) => g.kind === 'pair')!;
    expect(pair).toBeDefined();
    expect(pair.evidenced).toBe(false);
    expect(res.groups.filter((g) => g.kind !== 'net').every((g) => !g.inScenario)).toBe(true);
    // The residual is still clearable — but only via the explicit net sweep.
    const net = res.groups.find((g) => g.kind === 'net');
    expect(net).toBeDefined();
    expect(net!.inScenario).toBe(false);
  });
  it('date proximity alone is not documentary evidence', () => {
    nextId = 0;
    const day = Date.UTC(2026, 0, 15);
    const es = [entry(500, { date: day }), entry(-500, { date: day })];
    const res = runAccount(es, config({ globalNet: false }));
    const pair = res.groups.find((g) => g.kind === 'pair')!;
    expect(pair.evidenced).toBe(false);
    expect(pair.confidence).toBeLessThanOrEqual(30);
    expect(pair.inScenario).toBe(false);
  });
  it('a documented pair IS suggested', () => {
    nextId = 0;
    const es = [entry(500, { docNo: '7001' }), entry(-500, { docNo: '7001' })];
    const res = runAccount(es, config({ globalNet: false }));
    const pair = res.groups.find((g) => g.kind === 'pair')!;
    expect(pair.evidenced).toBe(true);
    expect(pair.tier).toBe('high');
    expect(pair.inScenario).toBe(true);
  });
});

describe('pair-exclusion fix', () => {
  it('an unevidenced pair no longer blocks the combination search', () => {
    nextId = 0;
    const es = [
      entry(-500, { docNo: '3000' }), // target
      entry(500, { docNo: '9900' }), // amount coincidence — unrelated doc
      entry(300, { docNo: '3001' }), // the real, documented reversal…
      entry(200, { docNo: '3002' }), // …split across two entries
    ];
    const res = runAccount(es, config({ globalNet: false }));
    const combo = res.groups.find(
      (g) => g.kind === 'combo' && g.offsetIds.includes(2) && g.offsetIds.includes(3),
    );
    // Old engine: entries 0+1 were consumed by the coincidence pair and this
    // combo was never searched. Now it must exist, be evidenced, and win.
    expect(combo).toBeDefined();
    expect(combo!.evidenced).toBe(true);
    expect(combo!.inScenario).toBe(true);
    const pair = res.groups.find((g) => g.kind === 'pair')!;
    expect(pair.evidenced).toBe(false);
    expect(pair.inScenario).toBe(false);
  });
});

describe('iterative re-match before netting', () => {
  it('re-searches the residual so a conflict loser finds its second-choice combo', () => {
    nextId = 0;
    const es = [
      entry(-600, { docNo: '100' }), // T1
      entry(-600, { docNo: '500' }), // T2
      entry(600, { docNo: '101' }), // P1: T1's documented partner (also T2's only 1:1)
      entry(400, { docNo: '501' }), // P2+P3: T2's documented combo
      entry(200, { docNo: '502' }),
    ];
    // maxAlternatives 1 forces T2's round-1 shortlist to a single (conflicting)
    // proposal; only the round-2 re-search of the residual can find P2+P3.
    const res = runAccount(es, config({ maxAlternatives: 1, globalNet: true }));
    const t2Combo = res.groups.find(
      (g) => g.targetIds.includes(1) && g.offsetIds.includes(3) && g.offsetIds.includes(4),
    );
    expect(t2Combo).toBeDefined();
    expect(t2Combo!.evidenced).toBe(true);
    // The suggested scenario clears ALL five entries — nothing left to net.
    const suggested = res.groups.filter((g) => g.inScenario);
    const cleared = new Set(suggested.flatMap((g) => groupEntryIds(g)));
    expect(cleared.size).toBe(5);
    expect(res.netReport?.clearedTargets ?? 0).toBe(0); // netting had nothing to do
  });
  it('emits no duplicate groups across rounds', () => {
    nextId = 0;
    const es = [
      entry(-600, { docNo: '100' }),
      entry(-600, { docNo: '500' }),
      entry(600, { docNo: '101' }),
      entry(400, { docNo: '501' }),
      entry(200, { docNo: '502' }),
    ];
    const res = runAccount(es, config({ maxAlternatives: 1 }));
    const sigs = res.groups.map(
      (g) => `${[...g.targetIds].sort().join(',')}|${[...g.offsetIds].sort().join(',')}`,
    );
    expect(new Set(sigs).size).toBe(sigs.length);
  });
});
