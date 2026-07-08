import { gcd } from './cents';
import type { Entry, MatchGroup, NetReport } from './types';

/** Max DP states for exact reconstruction (Uint8+Int32: 5 bytes/state ⇒ 160 MB cap). */
const MAX_DP_STATES = 32_000_000;
/** Overall time budget for one net solve (drop-loop included). */
const NET_BUDGET_MS = 20_000;
/** Per-DFS time slice. */
const DFS_BUDGET_MS = 8_000;

export interface NetSolveResult {
  group: MatchGroup | null;
  report: NetReport;
}

type ExactVerdict =
  | { verdict: 'found'; subset: number[] }
  | { verdict: 'unreachable' }
  | { verdict: 'too-large' };

/**
 * Global netting solve — the browser equivalent of the reference script's
 * CP-SAT phase. Given the residual entries of one account, pick a subset of
 * the offset side summing EXACTLY to the total of target-side entries,
 * clearing every target in one zero-sum group.
 *
 * Key trick for huge targets: a subset summing to `need` exists iff a subset
 * summing to the COMPLEMENT `total - need` exists (the excluded offsets). The
 * complement is tiny in the common clearing-account case (it equals the
 * account's net balance), so solve whichever side has the smaller state space:
 *   1. exact DP with reconstruction (GCD-reduced) on the smaller side;
 *   2. unbounded-size branch-and-bound DFS with failure memoization;
 *   3. greedy descent + bounded repair.
 * Attempt B: if `need` is proven/appears unreachable, drop targets smallest-
 * first (each re-tested) — maximizing cleared targets; dropped ones reported.
 */
export function solveGlobalNet(
  residual: Entry[],
  side: 'negative' | 'positive',
  account: string,
): NetSolveResult {
  const sign = side === 'negative' ? -1 : 1;
  const targets = residual
    .filter((e) => Math.sign(e.amount) === sign)
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount) || a.id - b.id);
  const offsets = residual
    .filter((e) => Math.sign(e.amount) === -sign)
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount) || a.id - b.id);

  const empty = (stranded: Entry[]): NetSolveResult => ({
    group: null,
    report: { side, clearedTargets: 0, strandedTargetIds: stranded.map((e) => e.id), method: 'none' },
  });

  if (targets.length === 0) return empty([]);
  if (offsets.length === 0) return empty(targets);

  const offsetVals = offsets.map((e) => Math.abs(e.amount));
  const offsetTotal = offsetVals.reduce((s, v) => s + v, 0);
  const deadline = Date.now() + NET_BUDGET_MS;

  const kept = [...targets];
  const dropped: Entry[] = [];
  while (kept.length > 0) {
    const need = kept.reduce((s, e) => s + Math.abs(e.amount), 0);
    if (need <= offsetTotal) {
      const sub = findOffsetSubset(offsetVals, need, offsetTotal, deadline);
      if (sub.verdict === 'found') {
        const method = dropped.length === 0 ? 'exact' : 'partial';
        return buildGroup(kept, sub.subset.map((i) => offsets[i]), dropped, side, account, method);
      }
      if (sub.verdict === 'too-large' || Date.now() > deadline) {
        // Not proven unreachable — last-ditch greedy before giving up on this need.
        const greedy = greedySolve(offsetVals, need);
        if (greedy) {
          return buildGroup(kept, greedy.map((i) => offsets[i]), dropped, side, account, 'greedy');
        }
      }
    }
    dropped.push(kept.pop()!); // kept sorted desc → pop = smallest target
  }
  return empty(targets);
}

/** Find offset indices summing exactly to `need`, via the cheaper of the direct/complement sides. */
function findOffsetSubset(
  vals: number[],
  need: number,
  total: number,
  deadline: number,
): ExactVerdict {
  const all = () => vals.map((_, i) => i);
  if (need === 0) return { verdict: 'found', subset: [] };
  if (need === total) return { verdict: 'found', subset: all() };
  if (need > total) return { verdict: 'unreachable' };

  const comp = total - need;
  const complement = (excl: number[]) => {
    const ex = new Set(excl);
    return all().filter((i) => !ex.has(i));
  };

  // Exact DP on the smaller state space first, then the other if it also fits.
  const sides: ('direct' | 'comp')[] = need <= comp ? ['direct', 'comp'] : ['comp', 'direct'];
  for (const s of sides) {
    const target = s === 'direct' ? need : comp;
    const r = exactSubsetDP(vals, target);
    if (r.verdict === 'found') {
      return { verdict: 'found', subset: s === 'direct' ? r.subset : complement(r.subset) };
    }
    if (r.verdict === 'unreachable') return { verdict: 'unreachable' }; // proof (symmetric)
    // too-large → try the other side / fall through
  }

  // Branch-and-bound DFS on the smaller target, unbounded subset size.
  const s = need <= comp ? 'direct' : 'comp';
  const target = s === 'direct' ? need : comp;
  const r = dfsSubset(vals, target, Math.min(deadline, Date.now() + DFS_BUDGET_MS));
  if (r.verdict === 'found') {
    return { verdict: 'found', subset: s === 'direct' ? r.subset : complement(r.subset) };
  }
  return r; // 'unreachable' only when the DFS exhausted the space in time
}

/**
 * Subset-sum with reconstruction: who[s] = index of the value that first made
 * sum s reachable. Backtracking is safe because who[s] = i implies s - v[i]
 * was reachable strictly before value i was processed.
 */
export function exactSubsetDP(values: number[], target: number): ExactVerdict {
  if (target === 0) return { verdict: 'found', subset: [] };
  let g = target;
  for (const v of values) {
    if (v > 0) g = gcd(g, v);
    if (g === 1) break;
  }
  const t = target / g;
  if (t + 1 > MAX_DP_STATES) return { verdict: 'too-large' };

  const who = new Int32Array(t + 1).fill(-1);
  const reachable = new Uint8Array(t + 1);
  reachable[0] = 1;
  for (let i = 0; i < values.length; i++) {
    if (values[i] <= 0 || values[i] % g !== 0) continue;
    const v = values[i] / g;
    if (v > t) continue;
    // Descending scan = 0/1 knapsack (each value used at most once).
    for (let s = t; s >= v; s--) {
      if (!reachable[s] && reachable[s - v]) {
        reachable[s] = 1;
        who[s] = i;
      }
    }
    if (reachable[t]) break;
  }
  if (!reachable[t]) return { verdict: 'unreachable' };

  const chosen: number[] = [];
  let s = t;
  while (s > 0) {
    const i = who[s];
    if (i < 0) return { verdict: 'unreachable' }; // corrupt chain — impossible
    chosen.push(i);
    s -= values[i] / g;
  }
  return { verdict: 'found', subset: chosen.sort((a, b) => a - b) };
}

/** Back-compat convenience used by tests: subset indices or null. */
export function reconstructSubset(values: number[], target: number): number[] | null {
  const r = exactSubsetDP(values, target);
  return r.verdict === 'found' ? r.subset : null;
}

/**
 * Unbounded-size branch-and-bound: first subset summing exactly to target.
 * Values sorted descending; suffix-sum pruning; failure memoization on
 * (index, remaining) makes revisits cheap. Deterministic.
 */
function dfsSubset(values: number[], target: number, deadline: number): ExactVerdict {
  const order = values
    .map((_, i) => i)
    .filter((i) => values[i] > 0 && values[i] <= target)
    .sort((a, b) => values[b] - values[a] || a - b);
  const v = order.map((i) => values[i]);
  const n = v.length;
  const suffix = new Array<number>(n + 1);
  suffix[n] = 0;
  for (let i = n - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + v[i];
  if (suffix[0] < target) return { verdict: 'unreachable' };

  const dead = new Map<number, Set<number>>();
  let timedOut = false;
  let ticks = 0;

  const rec = (idx: number, remaining: number): number[] | null => {
    if (remaining === 0) return [];
    if (idx >= n || suffix[idx] < remaining) return null;
    if (++ticks % 8192 === 0 && Date.now() > deadline) {
      timedOut = true;
    }
    if (timedOut) return null;
    const deadSet = dead.get(idx);
    if (deadSet?.has(remaining)) return null;

    // First index whose value <= remaining.
    let lo = idx;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (v[mid] > remaining) lo = mid + 1;
      else hi = mid;
    }
    for (let j = lo; j < n; j++) {
      if (suffix[j] < remaining) break;
      const sub = rec(j + 1, remaining - v[j]);
      if (sub) {
        sub.push(j);
        return sub;
      }
      if (timedOut) return null;
    }
    let set = dead.get(idx);
    if (!set) {
      set = new Set();
      dead.set(idx, set);
    }
    set.add(remaining);
    return null;
  };

  const found = rec(0, target);
  if (found) {
    return { verdict: 'found', subset: found.map((j) => order[j]).sort((a, b) => a - b) };
  }
  return timedOut ? { verdict: 'too-large' } : { verdict: 'unreachable' };
}

function buildGroup(
  kept: Entry[],
  chosenOffsets: Entry[],
  dropped: Entry[],
  side: 'negative' | 'positive',
  account: string,
  method: NetReport['method'],
): NetSolveResult {
  const targetSum = kept.reduce((s, e) => s + e.amount, 0);
  const offsetSum = chosenOffsets.reduce((s, e) => s + e.amount, 0);
  if (targetSum + offsetSum !== 0) {
    // Hard invariant — a broken solve must never surface as a group.
    return {
      group: null,
      report: {
        side,
        clearedTargets: 0,
        strandedTargetIds: [...kept, ...dropped].map((e) => e.id),
        method: 'none',
      },
    };
  }
  const reasons = [
    `global netting: clears ${kept.length} ${side} entr${kept.length === 1 ? 'y' : 'ies'} with ${chosenOffsets.length} offsets`,
  ];
  if (dropped.length > 0) {
    reasons.push(`${dropped.length} ${side} entr${dropped.length === 1 ? 'y' : 'ies'} could not be cleared, left open`);
  }
  return {
    group: {
      id: `${account}|net|0`,
      account,
      kind: 'net',
      targetIds: kept.map((e) => e.id),
      offsetIds: chosenOffsets.map((e) => e.id),
      confidence: dropped.length === 0 ? 90 : 75,
      tier: dropped.length === 0 ? 'high' : 'medium',
      reasons,
      clusterKey: null,
      inScenario: true,
      altKey: null,
    },
    report: {
      side,
      clearedTargets: kept.length,
      strandedTargetIds: dropped.map((e) => e.id),
      method,
    },
  };
}

/**
 * Greedy descent + bounded repair DP for cases beyond the exact/DFS budgets.
 */
function greedySolve(values: number[], target: number): number[] | null {
  const order = values.map((_, i) => i).sort((a, b) => values[b] - values[a] || a - b);
  const picked: number[] = [];
  const skipped: number[] = [];
  let remaining = target;
  for (const i of order) {
    if (values[i] <= remaining) {
      picked.push(i);
      remaining -= values[i];
    } else {
      skipped.push(i);
    }
    if (remaining === 0) return picked.sort((a, b) => a - b);
  }

  // Free the smallest picks until the remainder fits an exact repair DP.
  const freeing: number[] = [];
  while (picked.length > 0) {
    const idx = picked.pop()!;
    freeing.push(idx);
    remaining += values[idx];
    if (remaining > MAX_DP_STATES) break;
    const pool = [...freeing, ...skipped].filter((i) => values[i] <= remaining);
    const r = exactSubsetDP(pool.map((i) => values[i]), remaining);
    if (r.verdict === 'found') {
      return [...picked, ...r.subset.map((k) => pool[k])].sort((a, b) => a - b);
    }
  }
  return null;
}
