import { subsetSumReachable } from './bitset-dp';
import { scoreGroup } from './confidence';
import type { Entry, MatchGroup, SearchConfig, TargetOutcome } from './types';

const DAY_MS = 86_400_000;
const TIMEOUT_CHECK_INTERVAL = 4096;
/** Candidate-set size at or below which meet-in-the-middle enumerates exhaustively. */
const MITM_MAX_N = 30;

export interface ComboSearchResult {
  /** Each combo is a list of candidate entries summing exactly to the target. */
  combos: Entry[][];
  /** Total combos that exist within the size cap (may exceed combos.length). */
  totalFound: number;
  exhausted: boolean;
  proven: boolean; // true when 'unreachable' proof was obtained
  statesExplored: number;
}

interface SearchCtx {
  values: number[]; // sorted descending, parallel to cands
  cands: Entry[];
  prefix: number[]; // prefix[i] = sum of values[0..i-1]
  cap: number;
  maxKeep: number;
  deadline: number;
  states: number;
  truncated: boolean;
  timedOut: boolean;
  combos: Entry[][];
  totalFound: number;
  chosen: number[];
  memo: Map<number, Set<number>>; // (idx*(cap+1)+depthLeft) -> dead remainders
}

function dfs(ctx: SearchCtx, idx: number, remaining: number, depth: number): boolean {
  // Returns true if the subtree was fully explored (safe to memoize failures).
  if (remaining === 0) {
    ctx.totalFound++;
    if (ctx.combos.length < ctx.maxKeep) {
      ctx.combos.push(ctx.chosen.map((i) => ctx.cands[i]));
    }
    // Enough alternatives kept → stop the whole search instead of exhausting
    // the space just to count what we'd throw away.
    if (ctx.combos.length >= ctx.maxKeep) ctx.truncated = true;
    return true;
  }
  const depthLeft = ctx.cap - depth;
  if (depthLeft === 0 || idx >= ctx.values.length) return true;

  if (++ctx.states % TIMEOUT_CHECK_INTERVAL === 0 && Date.now() > ctx.deadline) {
    ctx.timedOut = true;
  }
  if (ctx.timedOut || ctx.truncated) return false;

  const n = ctx.values.length;
  // Upper bound: taking the depthLeft largest remaining values still short.
  const maxTake = ctx.prefix[Math.min(n, idx + depthLeft)] - ctx.prefix[idx];
  if (maxTake < remaining) return true;
  // Lower bound: even one smallest value overshoots only if remaining < suffix min —
  // handled by the loop's binary-search start plus the values being positive.

  const memoKey = idx * (ctx.cap + 1) + depthLeft;
  const dead = ctx.memo.get(memoKey);
  if (dead?.has(remaining)) return true;

  // First index whose value <= remaining (values sorted descending).
  let lo = idx;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ctx.values[mid] > remaining) lo = mid + 1;
    else hi = mid;
  }

  const before = ctx.totalFound;
  let complete = true;
  for (let j = lo; j < n; j++) {
    // Re-check upper bound as j advances past large values.
    const mt = ctx.prefix[Math.min(n, j + depthLeft)] - ctx.prefix[j];
    if (mt < remaining) break;
    ctx.chosen.push(j);
    const sub = dfs(ctx, j + 1, remaining - ctx.values[j], depth + 1);
    ctx.chosen.pop();
    if (!sub) complete = false;
    if (ctx.timedOut || ctx.truncated) return false;
  }

  if (complete && ctx.totalFound === before) {
    let set = ctx.memo.get(memoKey);
    if (!set) {
      set = new Set();
      ctx.memo.set(memoKey, set);
    }
    set.add(remaining);
  }
  return complete;
}

/** Exhaustive meet-in-the-middle for small candidate sets. */
function mitm(cands: Entry[], values: number[], target: number, cap: number, maxKeep: number): ComboSearchResult {
  const n = values.length;
  const half = n >> 1;
  // Enumerate subsets (size<=cap) of each half: map sum -> list of index arrays.
  const enumerate = (start: number, end: number): Map<number, number[][]> => {
    const out = new Map<number, number[][]>();
    const m = end - start;
    for (let mask = 0; mask < 1 << m; mask++) {
      const bits = popcount(mask);
      if (bits > cap) continue;
      let sum = 0;
      const ids: number[] = [];
      for (let b = 0; b < m; b++) {
        if (mask & (1 << b)) {
          sum += values[start + b];
          ids.push(start + b);
        }
      }
      if (sum > target) continue;
      let list = out.get(sum);
      if (!list) {
        list = [];
        out.set(sum, list);
      }
      list.push(ids);
    }
    return out;
  };
  const left = enumerate(0, half);
  const right = enumerate(half, n);

  const combos: Entry[][] = [];
  let totalFound = 0;
  let states = 0;
  for (const [sumL, listsL] of left) {
    const need = target - sumL;
    const listsR = right.get(need);
    if (!listsR) continue;
    for (const l of listsL) {
      for (const r of listsR) {
        states++;
        const size = l.length + r.length;
        if (size === 0 || size > cap) continue;
        totalFound++;
        if (combos.length < maxKeep) combos.push([...l, ...r].map((i) => cands[i]));
      }
    }
  }
  return { combos, totalFound, exhausted: true, proven: false, statesExplored: states };
}

function popcount(x: number): number {
  x -= (x >> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  return (((x + (x >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
}

/**
 * Find subsets of `candidates` whose amounts sum exactly to `targetAbs`.
 * Candidates must all be same-sign entries; amounts compared by absolute value.
 */
export function searchCombosForTarget(
  target: Entry,
  candidates: Entry[],
  config: SearchConfig,
): ComboSearchResult {
  const targetAbs = Math.abs(target.amount);

  let cands = candidates.filter((c) => {
    const v = Math.abs(c.amount);
    return v > 0 && v <= targetAbs;
  });
  if (config.dateWindowDays !== null && target.date !== null) {
    const win = config.dateWindowDays * DAY_MS;
    cands = cands.filter((c) => c.date === null || Math.abs(c.date - target.date!) <= win);
  }

  if (cands.length === 0) {
    return { combos: [], totalFound: 0, exhausted: true, proven: true, statesExplored: 0 };
  }

  // Oracle first: a proof of unreachability short-circuits everything.
  const verdict = subsetSumReachable(cands.map((c) => Math.abs(c.amount)), targetAbs);
  if (verdict === 'unreachable') {
    return { combos: [], totalFound: 0, exhausted: true, proven: true, statesExplored: cands.length };
  }

  // Sort descending by amount, ties by row order (determinism).
  const order = cands
    .map((c, i) => i)
    .sort((a, b) => Math.abs(cands[b].amount) - Math.abs(cands[a].amount) || cands[a].id - cands[b].id);
  const sorted = order.map((i) => cands[i]);
  const values = sorted.map((c) => Math.abs(c.amount));

  const cap = Math.max(2, Math.min(10, config.maxComboSize));

  if (sorted.length <= MITM_MAX_N) {
    return mitm(sorted, values, targetAbs, cap, config.maxAlternatives);
  }

  const prefix = new Array<number>(values.length + 1);
  prefix[0] = 0;
  for (let i = 0; i < values.length; i++) prefix[i + 1] = prefix[i] + values[i];

  const ctx: SearchCtx = {
    values,
    cands: sorted,
    prefix,
    cap,
    maxKeep: config.maxAlternatives,
    deadline: Date.now() + config.perTargetBudgetMs,
    states: 0,
    truncated: false,
    timedOut: false,
    combos: [],
    totalFound: 0,
    chosen: [],
    memo: new Map(),
  };
  const complete = dfs(ctx, 0, targetAbs, 0);
  return {
    combos: ctx.combos,
    totalFound: ctx.totalFound,
    exhausted: complete && !ctx.timedOut && !ctx.truncated,
    proven: false,
    statesExplored: ctx.states,
  };
}

export interface Pass2Result {
  groups: MatchGroup[];
  outcomes: TargetOutcome[];
  statesExplored: number;
}

/**
 * One-to-many search: every unnatural-sign entry is a target; subsets of
 * natural-sign entries are searched for exact offsets. Nothing is consumed —
 * overlaps between proposals are resolved by the scenario optimizer + user.
 */
export function findCombos(
  targets: Entry[],
  naturalPool: Entry[],
  account: string,
  config: SearchConfig,
  kind: 'combo' | 'deep' = 'combo',
  onProgress?: (done: number, total: number) => void,
): Pass2Result {
  const groups: MatchGroup[] = [];
  const outcomes: TargetOutcome[] = [];
  let statesExplored = 0;
  let seq = 0;

  const ordered = [...targets].sort(
    (a, b) => Math.abs(b.amount) - Math.abs(a.amount) || a.id - b.id,
  );

  ordered.forEach((target, ti) => {
    const t0 = Date.now();
    const res = searchCombosForTarget(target, naturalPool, config);
    statesExplored += res.statesExplored;

    // Rank alternatives by confidence, deterministic tie-break by member ids.
    const scored = res.combos
      .map((combo) => {
        const { confidence, tier, reasons } = scoreGroup({
          targets: [target],
          offsets: combo,
          competingAlternatives: res.totalFound - 1,
        });
        return { combo, confidence, tier, reasons };
      })
      .sort(
        (a, b) =>
          b.confidence - a.confidence ||
          a.combo.length - b.combo.length ||
          String(a.combo.map((e) => e.id)).localeCompare(String(b.combo.map((e) => e.id))),
      );

    const altKey = `${account}|t|${target.id}`;
    for (const s of scored) {
      groups.push({
        id: `${account}|${kind}|${target.id}|${seq++}`,
        account,
        kind,
        targetIds: [target.id],
        offsetIds: s.combo.map((e) => e.id),
        confidence: s.confidence,
        tier: s.tier,
        reasons: s.reasons,
        clusterKey: null,
        inScenario: false,
        altKey,
      });
    }

    outcomes.push({
      targetId: target.id,
      status:
        res.totalFound > 0
          ? 'matched'
          : res.proven
            ? 'proven-unmatchable'
            : res.exhausted
              ? 'exhausted-no-combo'
              : 'budget-exhausted',
      combosFound: res.totalFound,
      statesExplored: res.statesExplored,
      elapsedMs: Date.now() - t0,
    });
    onProgress?.(ti + 1, ordered.length);
  });

  return { groups, outcomes, statesExplored };
}
