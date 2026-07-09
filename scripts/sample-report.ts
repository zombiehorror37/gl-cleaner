// Dev diagnostic: run the full pipeline on sample/Book1 (2).xlsx and print
// coverage/noise stats. Usage: npx tsx scripts/sample-report.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import { buildEntries } from '../lib/parse';
import { guessMapping } from '../lib/template';
import { runAccount } from '../lib/engine/run';
import { DEFAULT_SEARCH, groupEntryIds } from '../lib/engine/types';
import { fromCents } from '../lib/engine/cents';

const src = fileURLToPath(new URL('../sample/Book1 (2).xlsx', import.meta.url));
const wb = XLSX.read(readFileSync(src), { cellDates: true });
const matrix = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], {
  header: 1,
  raw: true,
  defval: null,
});
const headers = (matrix[0] as string[]).map((h) => String(h ?? ''));
const mapping = guessMapping(headers);
const { entries } = buildEntries(matrix.slice(1), mapping);

const t0 = Date.now();
const result = runAccount(entries, {
  ...DEFAULT_SEARCH,
  account: '1679',
  nature: 'suspense',
});
const elapsed = Date.now() - t0;

const groups = result.groups;
const byKind = (k: string) => groups.filter((g) => g.kind === k);
const suggested = groups.filter((g) => g.inScenario);
const clearedIds = new Set(suggested.flatMap((g) => groupEntryIds(g)));
const net = groups.find((g) => g.kind === 'net');
const netIds = new Set(net ? groupEntryIds(net) : []);

console.log(`elapsed: ${(elapsed / 1000).toFixed(1)}s, states: ${result.stats.statesExplored.toLocaleString()}`);
console.log(`rows: ${entries.length} (pos ${result.stats.positiveEntries} / neg ${result.stats.negativeEntries})`);
console.log(`groups total: ${groups.length}`);
for (const k of ['pair', 'combo', 'deep', 'net'] as const) {
  const g = byKind(k);
  console.log(
    `  ${k}: ${g.length} (evidenced ${g.filter((x) => x.evidenced).length}, suggested ${g.filter((x) => x.inScenario).length})`,
  );
}
console.log(
  `suggested scenario: ${suggested.length} groups covering ${clearedIds.size} rows (${((clearedIds.size / entries.length) * 100).toFixed(1)}%)`,
);
const negCleared = entries.filter((e) => e.amount < 0 && clearedIds.has(e.id)).length;
console.log(`  negatives cleared by evidence: ${negCleared} / ${result.stats.negativeEntries}`);
console.log(
  `net sweep: ${net ? `${net.targetIds.length} targets + ${net.offsetIds.length} offsets = ${netIds.size} rows` : 'none'}`,
);
console.log(`net report: ${JSON.stringify(result.netReport)}`);
const outcome = new Map<string, number>();
for (const o of result.outcomes) outcome.set(o.status, (outcome.get(o.status) ?? 0) + 1);
console.log(`target outcomes: ${JSON.stringify([...outcome])}`);
const openNeg = entries.filter((e) => e.amount < 0 && !clearedIds.has(e.id) && !netIds.has(e.id));
console.log(
  `open negatives after suggested+net: ${openNeg.length} (${fromCents(openNeg.reduce((s, e) => s + e.amount, 0))})`,
);
const altKeys = new Set(groups.filter((g) => g.altKey).map((g) => g.altKey));
console.log(
  `review noise: ${groups.length} groups → ${altKeys.size + groups.filter((g) => !g.altKey).length} collapsed rows; unevidenced ${groups.filter((g) => !g.evidenced).length}`,
);
