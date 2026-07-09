import { findExactPairs } from './pass1-pairs';
import { findCombos } from './pass2-subset';
import { findDeepGroups } from './pass3-deep';
import { solveGlobalNet } from './net-solver';
import { buildScenario } from './scenario';
import {
  groupEntryIds,
  type AccountConfig,
  type AmountCluster,
  type EngineProgress,
  type EngineResult,
  type Entry,
  type MatchGroup,
  type NetReport,
  type TargetOutcome,
} from './types';

/** Hard cap on match→pack→re-match iterations (each round only sees a shrinking residual). */
const MAX_ROUNDS = 5;

export function netSide(config: AccountConfig): 'negative' | 'positive' {
  if (config.netTargetSide !== 'auto') return config.netTargetSide;
  // Debit-natured (and suspense/clearing) accounts: negatives are the side to
  // clear; credit-natured: positives.
  return config.nature === 'credit' ? 'positive' : 'negative';
}

/** One pass-2 direction: search subsets of `pool` offsetting each entry of `targets`. */
export interface Pass2Direction {
  targets: Entry[];
  pool: Entry[];
}

/** Work item yielded by the pipeline — the driver runs pass 2 (sync or sharded across workers). */
export interface Pass2Work {
  round: number;
  directions: Pass2Direction[];
  /** Driver calls this as targets complete so the UI sees live pass-2 progress. */
  reportProgress: (targetsDone: number) => void;
}

/** What the driver feeds back into the pipeline for one Pass2Work item. */
export interface Pass2WorkResult {
  groups: MatchGroup[];
  outcomes: TargetOutcome[];
  statesExplored: number;
}

const signature = (g: MatchGroup): string =>
  `${[...g.targetIds].sort((a, b) => a - b).join(',')}|${[...g.offsetIds].sort((a, b) => a - b).join(',')}`;

/**
 * The full per-account pipeline as a generator, so the synchronous path
 * (tests/SSR) and the worker coordinator drive the SAME logic. It yields
 * pass-2 work items (the parallelizable part) and receives their results.
 *
 * Iterative match→pack→re-match:
 *   round N: pass 1 pairs + pass 2 combos + pass 3 many-to-many over the
 *   residual, then weighted set-packing over every EVIDENCED group. Entries
 *   claimed by the suggested scenario leave the residual; the next round
 *   re-searches what is left, so second-choice evidenced combos are found for
 *   targets whose first proposals lost a conflict. Only when a round finds
 *   nothing new does the residual fall through to the global net solver —
 *   netting is provably a last resort, never a shortcut.
 *
 * Evidence gate: groups without a documentary signal are still emitted (the
 * reviewer may know better) but NEVER enter the suggested scenario and never
 * consume entries from the search.
 */
export function* pipeline(
  entries: Entry[],
  config: AccountConfig,
  onProgress?: (p: EngineProgress) => void,
): Generator<Pass2Work, EngineResult, Pass2WorkResult> {
  const t0 = Date.now();
  const account = config.account;

  const groups: MatchGroup[] = [];
  const clusters: AmountCluster[] = [];
  const clusterKeys = new Set<string>();
  const emitted = new Set<string>();
  const outcomeByTarget = new Map<number, TargetOutcome>();
  let statesExplored = 0;
  let deepBudgetLeft = config.deepSearch ? config.deepSearchBudgetMs : 0;

  const progress = (p: Omit<EngineProgress, 'account'>) => onProgress?.({ ...p, account });

  /** Add groups, dropping exact duplicates re-found in later rounds. Returns #added. */
  const addGroups = (gs: MatchGroup[]): number => {
    let added = 0;
    for (const g of gs) {
      const sig = signature(g);
      if (emitted.has(sig)) continue;
      emitted.add(sig);
      groups.push(g);
      added++;
    }
    return added;
  };

  /**
   * Merge per-round target outcomes. 'matched' accumulates; a failure verdict
   * never overwrites an earlier one — round 1 searched the widest pool, so its
   * proof ('proven-unmatchable') is the authoritative one.
   */
  const mergeOutcomes = (list: TargetOutcome[]) => {
    for (const o of list) {
      const prev = outcomeByTarget.get(o.targetId);
      if (!prev) {
        outcomeByTarget.set(o.targetId, o);
      } else if (o.combosFound > 0) {
        outcomeByTarget.set(o.targetId, {
          targetId: o.targetId,
          status: 'matched',
          combosFound: prev.combosFound + o.combosFound,
          statesExplored: prev.statesExplored + o.statesExplored,
          elapsedMs: prev.elapsedMs + o.elapsedMs,
        });
      }
    }
  };

  const directionsFor = (residual: Entry[]): Pass2Direction[] => {
    const pos = residual.filter((e) => e.amount > 0);
    const neg = residual.filter((e) => e.amount < 0);
    return config.nature === 'debit'
      ? [{ targets: neg, pool: pos }]
      : config.nature === 'credit'
        ? [{ targets: pos, pool: neg }]
        : [
            { targets: neg, pool: pos },
            { targets: pos, pool: neg },
          ];
  };

  const active = entries.filter((e) => e.amount !== 0);
  let residual = active;
  let prevResidualKey = '';
  let lastTotalTargets = 0;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    // The scenario can only shrink the residual; identical residual ⇒ identical
    // searches ⇒ nothing new. (Also guards against pack oscillation.)
    const residualKey = residual.map((e) => e.id).join(',');
    if (residualKey === prevResidualKey) break;
    prevResidualKey = residualKey;

    // --- Pass 1: exact pairs over the residual -------------------------------
    progress({ phase: 'pass1', round, targetsDone: 0, targetsTotal: 0, groupsFound: groups.length, statesExplored });
    const p1 = findExactPairs(residual, account);
    let added = addGroups(p1.groups);
    for (const c of p1.clusters) {
      if (clusterKeys.has(c.key)) continue;
      clusterKeys.add(c.key);
      clusters.push(c);
    }

    // --- Pass 2: subset-sum per target ---------------------------------------
    // Only decisively evidenced pairs consume entries; weak/unevidenced pairs
    // must not block the combination search (they merely compete downstream).
    const searchable = residual.filter((e) => !p1.consumedIds.has(e.id));
    const directions = directionsFor(searchable);
    const totalTargets = directions.reduce((s, d) => s + d.targets.length, 0);
    lastTotalTargets = totalTargets;
    const groupsAtYield = groups.length;
    progress({ phase: 'pass2', round, targetsDone: 0, targetsTotal: totalTargets, groupsFound: groupsAtYield, statesExplored });
    const p2 = yield {
      round,
      directions,
      reportProgress: (done) =>
        progress({ phase: 'pass2', round, targetsDone: done, targetsTotal: totalTargets, groupsFound: groupsAtYield, statesExplored }),
    };
    added += addGroups(p2.groups);
    mergeOutcomes(p2.outcomes);
    statesExplored += p2.statesExplored;

    // --- Pass 3: many-to-many over targets with no proposal at all -----------
    if (deepBudgetLeft > 0) {
      progress({ phase: 'pass3', round, targetsDone: totalTargets, targetsTotal: totalTargets, groupsFound: groups.length, statesExplored });
      const proposed = new Set<number>();
      for (const g of groups) for (const id of g.targetIds) proposed.add(id);
      const dt0 = Date.now();
      for (const d of directions) {
        const remaining = deepBudgetLeft - (Date.now() - dt0);
        if (remaining <= 0) break;
        const deep = findDeepGroups(
          d.targets.filter((e) => !proposed.has(e.id)),
          d.pool,
          account,
          { ...config, deepSearchBudgetMs: remaining },
        );
        added += addGroups(deep.groups);
        statesExplored += deep.statesExplored;
      }
      deepBudgetLeft -= Date.now() - dt0;
    }

    // --- Pack: suggested scenario over evidenced groups ONLY ------------------
    progress({ phase: 'scenario', round, targetsDone: totalTargets, targetsTotal: totalTargets, groupsFound: groups.length, statesExplored });
    const scenario = buildScenario(groups.filter((g) => g.evidenced));
    for (const g of groups) g.inScenario = scenario.chosen.has(g.id);

    const used = new Set<number>();
    for (const g of groups) {
      if (g.inScenario) for (const id of groupEntryIds(g)) used.add(id);
    }
    residual = active.filter((e) => !used.has(e.id));

    if (added === 0) break; // fixpoint: every evidenced combination has been found
  }

  // --- Last resort: global netting on whatever no evidenced match clears -----
  let netReport: NetReport | null = null;
  if (config.globalNet) {
    progress({ phase: 'net', round: undefined, targetsDone: lastTotalTargets, targetsTotal: lastTotalTargets, groupsFound: groups.length, statesExplored });
    const { group, report } = solveGlobalNet(residual, netSide(config), account);
    if (group) groups.push(group);
    netReport = report;
  }

  progress({ phase: 'done', targetsDone: lastTotalTargets, targetsTotal: lastTotalTargets, groupsFound: groups.length, statesExplored });
  return {
    groups,
    clusters,
    outcomes: [...outcomeByTarget.values()],
    netReport,
    stats: {
      totalEntries: entries.length,
      positiveEntries: entries.filter((e) => e.amount > 0).length,
      negativeEntries: entries.filter((e) => e.amount < 0).length,
      statesExplored,
      elapsedMs: Date.now() - t0,
    },
  };
}

/** Synchronous driver for one pass-2 work item (tests/SSR fallback). */
export function runPass2Sync(work: Pass2Work, config: AccountConfig): Pass2WorkResult {
  const groups: MatchGroup[] = [];
  const outcomes: TargetOutcome[] = [];
  let statesExplored = 0;
  let done = 0;
  for (const d of work.directions) {
    const res = findCombos(d.targets, d.pool, config.account, config, 'combo', (dd) =>
      work.reportProgress(done + dd),
    );
    done += d.targets.length;
    groups.push(...res.groups);
    outcomes.push(...res.outcomes);
    statesExplored += res.statesExplored;
  }
  return { groups, outcomes, statesExplored };
}

/**
 * Run all passes for one account. Pure and synchronous — the coordinator
 * worker drives the same `pipeline` with pass 2 sharded across nested workers.
 */
export function runAccount(
  entries: Entry[],
  config: AccountConfig,
  onProgress?: (p: EngineProgress) => void,
): EngineResult {
  const gen = pipeline(entries, config, onProgress);
  let next = gen.next();
  while (!next.done) {
    next = gen.next(runPass2Sync(next.value, config));
  }
  return next.value;
}
