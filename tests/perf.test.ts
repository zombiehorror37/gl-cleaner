// Performance envelope check. Run explicitly: PERF=1 npx vitest run tests/perf.test.ts
import { describe, expect, it } from 'vitest';
import { runAccount } from '../lib/engine/run';
import { DEFAULT_SEARCH, type Entry } from '../lib/engine/types';

const mk = (id: number, amount: number): Entry => ({
  id,
  account: 'PERF',
  date: Date.UTC(2026, 0, 1 + (id % 60)),
  docNo: String(700000 + id),
  docType: 'JE',
  reference: null,
  description: `row ${id}`,
  amount,
  raw: [],
});

describe.skipIf(!process.env.PERF)('5k-row performance', () => {
  it('completes a 5,000-row account within a sane wall time', () => {
    // Deterministic pseudo-random amounts, ~70% positive.
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const entries: Entry[] = [];
    for (let i = 0; i < 5000; i++) {
      const mag = Math.round(rnd() * 5_000_00) + 100;
      entries.push(mk(i, rnd() < 0.7 ? mag : -mag));
    }
    const t0 = Date.now();
    const res = runAccount(entries, {
      ...DEFAULT_SEARCH,
      account: 'PERF',
      nature: 'debit',
      maxComboSize: 4,
      perTargetBudgetMs: 500,
    });
    const elapsed = Date.now() - t0;
    console.log(
      `5k rows: ${elapsed}ms, ${res.groups.length} groups, ${res.stats.statesExplored.toLocaleString()} states, ` +
        `outcomes: ${JSON.stringify(res.outcomes.reduce((m: Record<string, number>, o) => ((m[o.status] = (m[o.status] ?? 0) + 1), m), {}))}`,
    );
    expect(res.groups.length).toBeGreaterThan(0);
    // Single-threaded engine; the browser shards this across cores.
    expect(elapsed).toBeLessThan(15 * 60_000);
  }, 900_000);
});
