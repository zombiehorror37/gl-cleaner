# GL Cleaner

Find and remove offsetting general-ledger entries — the automated version of "sort by absolute value and eyeball the matching +/− amounts", plus everything manual review can't do.

**Everything runs in your browser.** No server, no upload — GL data never leaves your machine. Deployable as a static site (Vercel free tier).

## What it does

1. **Upload** an `.xlsx`/`.csv` GL export.
2. **Map columns** to the template (Amount required; Date, Doc No, Doc Type, Account, Description, Reference optional). Mappings are saved as reusable templates.
3. **Configure** per account: nature (debit / credit / suspense-both-directions), max combination size (2–10), per-target time budget, optional date window, optional many-to-many deep search.
4. **Review** proposed match groups. Nothing is ever removed automatically:
   - exact 1:1 pairs, one-to-many combinations, many-to-many groups;
   - confidence scoring (doc-number proximity, references, descriptions, doc types, dates);
   - ambiguous amount clusters shown as clusters, alternatives labeled `alt x/y`;
   - approving a group locks its entries — conflicting groups grey out;
   - a set-packing **scenario optimizer** suggests the assignment that cleans the most rows;
   - a **global netting solver** sweeps the residual: one group clearing ALL remaining
     unnatural-side entries against an exactly-summing offset subset (solved on the cheaper of
     the direct/complement sides — GCD-reduced DP with reconstruction, branch-and-bound
     fallback). One run + one click = zero open negatives whenever mathematically possible;
   - every target labeled matched / **proven unmatchable** (bitset oracle proof) / none within limits / budget exhausted.
5. **Export** a new workbook: Detail (all rows annotated Status/Group/Type, open negatives red, live Excel check formulas), Cleaned GL, Removed Entries (group IDs + reasons), Summary (reconciliation). Hard invariants checked before export: every group sums to exactly 0, no entry in two groups, cleaned total equals original total.

All amounts are integer cents internally — no floating-point anywhere in matching.

## Engine

- Pass 1: exact pairs via hash buckets (O(n)).
- Pass 2: subset-sum per target — meet-in-the-middle (exhaustive, small sets) or memoized branch-and-bound with suffix-sum pruning; a GCD-reduced bitset reachability DP proves unmatchable targets.
- Pass 3 (optional): many-to-many via synthetic targets.
- Final pass: scenario set-packing + global netting solve on the residual.
- The entire pipeline runs in a coordinator Web Worker; pass 2 shards across nested workers
  (one per CPU core). The main thread only renders — review list is windowed with
  `content-visibility` so thousands of groups stay smooth.

## Development

```bash
npm run dev        # dev server
npx vitest run     # unit + e2e + real-data tests
PERF=1 npx vitest run tests/perf.test.ts  # 5k-row perf check
npm run build      # static production build
```
