// Real-data regression: runs only when the sample GL exists locally.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { buildEntries } from '../lib/parse';
import { guessMapping } from '../lib/template';
import { runAccount } from '../lib/engine/run';
import { buildScenario } from '../lib/engine/scenario';
import { groupEntryIds, DEFAULT_SEARCH } from '../lib/engine/types';

const SAMPLE = 'C:\\Users\\zombi\\Desktop\\Book1.xlsx';

describe.skipIf(!existsSync(SAMPLE))('Book1.xlsx baseline', () => {
  const wb = XLSX.read(readFileSync(SAMPLE), { cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null });
  const headers = (matrix[0] as string[]).map((h) => String(h ?? ''));
  const mapping = guessMapping(headers);

  it('auto-maps the sample headers', () => {
    expect(mapping.amount).toBe(5);
    expect(mapping.date).toBe(0);
    expect(mapping.docNo).toBe(1);
    expect(mapping.description).toBe(2);
    expect(mapping.account).toBe(3);
    expect(mapping.docType).toBe(6);
  });

  const { entries } = buildEntries(matrix.slice(1), mapping);

  it('parses all 486 rows', () => {
    expect(entries).toHaveLength(486);
    expect(entries.filter((e) => e.amount > 0)).toHaveLength(304);
    expect(entries.filter((e) => e.amount < 0)).toHaveLength(182);
  });

  const result = runAccount(entries, {
    ...DEFAULT_SEARCH,
    account: '1679',
    nature: 'suspense',
    maxComboSize: 3, // keep the CI-style run quick; UI default is 5
    perTargetBudgetMs: 3000,
  });

  it('finds the 50 exact pairs', () => {
    expect(result.groups.filter((g) => g.kind === 'pair')).toHaveLength(50);
  });

  it('reports the ambiguous 500,000.00 cluster as 10 pos vs 2 neg', () => {
    const c = result.clusters.find((c) => c.absAmount === 50_000_000);
    expect(c).toBeDefined();
    expect(c!.positiveIds).toHaveLength(10);
    expect(c!.negativeIds).toHaveLength(2);
  });

  it('finds multi-entry combos with alternatives', () => {
    const combos = result.groups.filter((g) => g.kind === 'combo');
    expect(combos.length).toBeGreaterThan(10);
    const target755400 = combos.filter((g) =>
      g.targetIds.some((id) => entries.find((e) => e.id === id)!.amount === -75_540_000),
    );
    expect(target755400.length).toBeGreaterThanOrEqual(2); // known 13 2-combos, capped at 20 alts
  });

  it('every proposed group sums to exactly zero', () => {
    const map = new Map(entries.map((e) => [e.id, e]));
    for (const g of result.groups) {
      const sum = groupEntryIds(g).reduce((s, id) => s + map.get(id)!.amount, 0);
      expect(sum).toBe(0);
    }
  });

  it('doc-adjacent pair ±3,343.91 ranks high confidence', () => {
    const pair = result.groups.find(
      (g) => g.kind === 'pair' && groupEntryIds(g).some((id) => Math.abs(map(id)) === 334_391),
    );
    expect(pair).toBeDefined();
    expect(pair!.tier).toBe('high');
    function map(id: number) {
      return entries.find((e) => e.id === id)!.amount;
    }
  });

  it('scenario is disjoint and cleans a meaningful share', () => {
    const scenario = buildScenario(result.groups);
    const seen = new Set<number>();
    for (const id of scenario.chosen) {
      const g = result.groups.find((x) => x.id === id)!;
      for (const e of groupEntryIds(g)) {
        expect(seen.has(e)).toBe(false);
        seen.add(e);
      }
    }
    expect(scenario.totalEntriesCleaned).toBeGreaterThanOrEqual(100);
  });
});
