import { subsetSumReachable } from './bitset-dp';

/** Candidate-set size at or below which meet-in-the-middle enumerates exhaustively. */
const MITM_MAX_N = 24;
const TIMEOUT_CHECK_INTERVAL = 2048;

export interface SubsetItem {
  id: number;
  /** Positive amount in cents. */
  value: number;
}

export interface SubsetResult {
  /** Each combo is a list of item ids whose values sum exactly to the target. */
  combos: number[][];
  /** Combos that exist within the size cap (≥ combos.length; capped at maxKeep+1 when truncated). */
  totalFound: number;
  /** True when the search space was fully explored (totalFound is exact). */
  exhausted: boolean;
  /** True when it was proven that no subset of ANY size reaches the target. */
  proven: boolean;
  timedOut: boolean;
}

/**
 * Find subsets of `items` (sizes 1..maxSize) whose values sum exactly to
 * `target`. Exhaustive meet-in-the-middle for small pools, memoized
 * branch-and-bound otherwise, with a bitset proof of impossibility first.
 * Deterministic: items are explored largest-first, ties by id.
 */
export function findSubsets(
  items: SubsetItem[],
  target: number,
  maxSize: number,
  maxKeep: number,
  budgetMs: number,
): SubsetResult {
  const cands = items.filter((x) => x.value > 0 && x.value <= target);
  if (cands.length === 0 || target <= 0) {
    return { combos: [], totalFound: 0, exhausted: true, proven: true, timedOut: false };
  }
  if (subsetSumReachable(cands.map((c) => c.value), target) === 'unreachable') {
    return { combos: [], totalFound: 0, exhausted: true, proven: true, timedOut: false };
  }
  const sorted = [...cands].sort((a, b) => b.value - a.value || a.id - b.id);
  const cap = Math.max(1, maxSize);
  return sorted.length <= MITM_MAX_N
    ? mitm(sorted, target, cap, maxKeep)
    : branchAndBound(sorted, target, cap, maxKeep, budgetMs);
}

function popcount(x: number): number {
  x -= (x >> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  return (((x + (x >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
}

function mitm(sorted: SubsetItem[], target: number, cap: number, maxKeep: number): SubsetResult {
  const n = sorted.length;
  const half = n >> 1;
  const enumerate = (start: number, end: number) => {
    const out = new Map<number, number[][]>();
    const m = end - start;
    for (let mask = 0; mask < 1 << m; mask++) {
      if (popcount(mask) > cap) continue;
      let sum = 0;
      const idx: number[] = [];
      for (let b = 0; b < m; b++) {
        if (mask & (1 << b)) {
          sum += sorted[start + b].value;
          idx.push(start + b);
        }
      }
      if (sum > target) continue;
      let list = out.get(sum);
      if (!list) out.set(sum, (list = []));
      list.push(idx);
    }
    return out;
  };
  const left = enumerate(0, half);
  const right = enumerate(half, n);
  const combos: number[][] = [];
  let totalFound = 0;
  for (const [sumL, lists] of left) {
    const rights = right.get(target - sumL);
    if (!rights) continue;
    for (const l of lists) {
      for (const r of rights) {
        const size = l.length + r.length;
        if (size === 0 || size > cap) continue;
        totalFound++;
        if (combos.length < maxKeep) combos.push([...l, ...r].map((i) => sorted[i].id));
      }
    }
  }
  return { combos, totalFound, exhausted: true, proven: false, timedOut: false };
}

function branchAndBound(sorted: SubsetItem[], target: number, cap: number, maxKeep: number, budgetMs: number): SubsetResult {
  const values = sorted.map((x) => x.value);
  const n = values.length;
  const prefix = new Array<number>(n + 1);
  prefix[0] = 0;
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + values[i];
  const deadline = Date.now() + budgetMs;
  const combos: number[][] = [];
  const chosen: number[] = [];
  const memo = new Map<number, Set<number>>();
  let totalFound = 0;
  let states = 0;
  let timedOut = false;
  let truncated = false;

  const dfs = (idx: number, remaining: number, depth: number): boolean => {
    if (remaining === 0) {
      totalFound++;
      if (combos.length < maxKeep) combos.push(chosen.map((i) => sorted[i].id));
      else truncated = true;
      return true;
    }
    const left = cap - depth;
    if (left === 0 || idx >= n) return true;
    if (++states % TIMEOUT_CHECK_INTERVAL === 0 && Date.now() > deadline) timedOut = true;
    if (timedOut || truncated) return false;
    if (prefix[Math.min(n, idx + left)] - prefix[idx] < remaining) return true;
    const key = idx * (cap + 1) + left;
    if (memo.get(key)?.has(remaining)) return true;

    let lo = idx;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (values[mid] > remaining) lo = mid + 1;
      else hi = mid;
    }
    const before = totalFound;
    let complete = true;
    for (let j = lo; j < n; j++) {
      if (prefix[Math.min(n, j + left)] - prefix[j] < remaining) break;
      chosen.push(j);
      const sub = dfs(j + 1, remaining - values[j], depth + 1);
      chosen.pop();
      if (!sub) complete = false;
      if (timedOut || truncated) return false;
    }
    if (complete && totalFound === before) {
      let set = memo.get(key);
      if (!set) memo.set(key, (set = new Set()));
      set.add(remaining);
    }
    return complete;
  };

  const complete = dfs(0, target, 0);
  return { combos, totalFound, exhausted: complete && !timedOut && !truncated, proven: false, timedOut };
}
