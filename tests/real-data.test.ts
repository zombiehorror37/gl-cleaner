// Real-data regression. Source preference: original Desktop Book1.xlsx, else
// the reference script's output (Book1_netted.xlsx) whose Detail sheet holds
// all original rows + 3 annotation columns we strip.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { buildEntries } from '../lib/parse';
import { guessMapping } from '../lib/template';
import { runAccount } from '../lib/engine/run';
import { groupEntryIds, DEFAULT_SEARCH } from '../lib/engine/types';

const DESKTOP = 'C:\\Users\\zombi\\Desktop\\Book1.xlsx';
const NETTED = 'C:\\Users\\zombi\\Downloads\\Book1_netted.xlsx';
const src = existsSync(DESKTOP) ? DESKTOP : existsSync(NETTED) ? NETTED : null;

if (!src) {
  describe.skip('Book1 baseline (sample file not found)', () => {
    it('skipped', () => {});
  });
} else {
  describe('Book1 baseline', () => {
    const wb = XLSX.read(readFileSync(src), { cellDates: true });
    const sheetName = wb.SheetNames.includes('Detail') ? 'Detail' : wb.SheetNames[0];
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], {
      header: 1,
      raw: true,
      defval: null,
    });
    // Netted output appends Status/Match_Group_ID/Match_Type — keep first 8 cols.
    const width = 8;
    const headers = (matrix[0] as string[]).slice(0, width).map((h) => String(h ?? ''));
    const rows = matrix.slice(1).map((r) => r.slice(0, width));
    const mapping = guessMapping(headers);

    it('auto-maps the sample headers', () => {
      expect(mapping.amount).toBe(5);
      expect(mapping.date).toBe(0);
      expect(mapping.docNo).toBe(1);
      expect(mapping.description).toBe(2);
      expect(mapping.account).toBe(3);
      expect(mapping.docType).toBe(6);
    });

    const { entries } = buildEntries(rows, mapping);

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

    it('every proposed group sums to exactly zero', () => {
      const map = new Map(entries.map((e) => [e.id, e]));
      for (const g of result.groups) {
        const sum = groupEntryIds(g).reduce((s, id) => s + map.get(id)!.amount, 0);
        expect(sum).toBe(0);
      }
    });

    it('ONE run + approve suggested leaves ZERO negatives open (script parity)', () => {
      const suggested = result.groups.filter((g) => g.inScenario);
      const used = new Set(suggested.flatMap((g) => groupEntryIds(g)));
      // suggested groups are mutually disjoint
      expect(used.size).toBe(suggested.reduce((s, g) => s + groupEntryIds(g).length, 0));
      const openNegs = entries.filter((e) => e.amount < 0 && !used.has(e.id));
      expect(result.netReport).not.toBeNull();
      expect(result.netReport!.strandedTargetIds).toHaveLength(0);
      expect(openNegs).toHaveLength(0); // the reference script achieves 0 — so must we
      // every suggested group sums to zero
      const map = new Map(entries.map((e) => [e.id, e]));
      for (const g of suggested) {
        expect(groupEntryIds(g).reduce((s, id) => s + map.get(id)!.amount, 0)).toBe(0);
      }
    });
  });
}
