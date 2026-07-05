import { findExactPairs } from './pass1-pairs';
import { findCombos } from './pass2-subset';
import { findDeepGroups } from './pass3-deep';
import { buildScenario } from './scenario';
import type { AccountConfig, EngineProgress, EngineResult, Entry, MatchGroup, TargetOutcome } from './types';

/**
 * Run all passes for one account. Pure and synchronous — the worker wraps it.
 * Nothing is consumed across proposals except pass-1 pairs (their residual
 * feeds pass 2); overlap between pass-2/3 proposals is resolved by the
 * scenario optimizer and, finally, by the user.
 */
export function runAccount(
  entries: Entry[],
  config: AccountConfig,
  onProgress?: (p: EngineProgress) => void,
): EngineResult {
  const t0 = Date.now();
  const account = config.account;
  const progress = (p: Omit<EngineProgress, 'account'>) => onProgress?.({ ...p, account });

  progress({ phase: 'pass1', targetsDone: 0, targetsTotal: 0, groupsFound: 0, statesExplored: 0 });
  const pass1 = findExactPairs(entries, account);
  const groups: MatchGroup[] = [...pass1.groups];
  const outcomes: TargetOutcome[] = [];
  let statesExplored = 0;

  const residual = entries.filter((e) => !pass1.pairedIds.has(e.id) && e.amount !== 0);
  const pos = residual.filter((e) => e.amount > 0);
  const neg = residual.filter((e) => e.amount < 0);

  // Direction list: [targets, pool] pairs by account nature.
  const directions: [Entry[], Entry[]][] =
    config.nature === 'debit'
      ? [[neg, pos]]
      : config.nature === 'credit'
        ? [[pos, neg]]
        : [
            [neg, pos],
            [pos, neg],
          ];

  const totalTargets = directions.reduce((s, [t]) => s + t.length, 0);
  let done = 0;
  for (const [targets, pool] of directions) {
    const res = findCombos(targets, pool, account, config, 'combo', (d) => {
      progress({
        phase: 'pass2',
        targetsDone: done + d,
        targetsTotal: totalTargets,
        groupsFound: groups.length,
        statesExplored,
      });
    });
    done += targets.length;
    groups.push(...res.groups);
    outcomes.push(...res.outcomes);
    statesExplored += res.statesExplored;
  }

  if (config.deepSearch) {
    progress({ phase: 'pass3', targetsDone: 0, targetsTotal: 0, groupsFound: groups.length, statesExplored });
    const matchedTargets = new Set(
      outcomes.filter((o) => o.status === 'matched').map((o) => o.targetId),
    );
    for (const [targets, pool] of directions) {
      const residualTargets = targets.filter((e) => !matchedTargets.has(e.id));
      const deep = findDeepGroups(residualTargets, pool, account, config);
      groups.push(...deep.groups);
      statesExplored += deep.statesExplored;
    }
  }

  progress({ phase: 'scenario', targetsDone: totalTargets, targetsTotal: totalTargets, groupsFound: groups.length, statesExplored });
  const scenario = buildScenario(groups);
  for (const g of groups) g.inScenario = scenario.chosen.has(g.id);

  progress({ phase: 'done', targetsDone: totalTargets, targetsTotal: totalTargets, groupsFound: groups.length, statesExplored });
  return {
    groups,
    clusters: pass1.clusters,
    outcomes,
    stats: {
      totalEntries: entries.length,
      positiveEntries: entries.filter((e) => e.amount > 0).length,
      negativeEntries: entries.filter((e) => e.amount < 0).length,
      statesExplored,
      elapsedMs: Date.now() - t0,
    },
  };
}
