import { scoreGroup } from './confidence';
import { searchCombosForTarget } from './pass2-subset';
import type { Entry, MatchGroup, SearchConfig } from './types';

const MAX_TARGET_SUBSET = 4;
const MAX_OFFSET_SIZE = 6;

/**
 * Pass 3 — many-to-many "deep search". Over residual unmatched entries only:
 * every subset (size 2..4) of unnatural entries becomes a synthetic target,
 * fed through the pass-2 subset machinery against the natural residual.
 * Bounded by a global time budget.
 */
export function findDeepGroups(
  unmatchedTargets: Entry[],
  naturalResidual: Entry[],
  account: string,
  config: SearchConfig,
): { groups: MatchGroup[]; statesExplored: number } {
  const groups: MatchGroup[] = [];
  let statesExplored = 0;
  const deadline = Date.now() + config.deepSearchBudgetMs;
  let seq = 0;

  const targets = [...unmatchedTargets]
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount) || a.id - b.id)
    .slice(0, 60); // combinatorial guard: subsets of the 60 largest residuals

  const deepConfig: SearchConfig = {
    ...config,
    maxComboSize: Math.min(config.maxComboSize, MAX_OFFSET_SIZE),
    maxAlternatives: 5,
    perTargetBudgetMs: Math.min(config.perTargetBudgetMs, 2000),
  };

  const subset: number[] = [];
  const recurse = (start: number, sum: number) => {
    if (Date.now() > deadline) return;
    if (subset.length >= 2) {
      const synthetic: Entry = {
        ...targets[subset[0]],
        amount: -sum, // sign irrelevant to search; magnitude is what matters
      };
      const res = searchCombosForTarget(synthetic, naturalResidual, deepConfig);
      statesExplored += res.statesExplored;
      const memberTargets = subset.map((i) => targets[i]);
      for (const combo of res.combos) {
        const { confidence, tier, reasons } = scoreGroup({
          targets: memberTargets,
          offsets: combo,
          competingAlternatives: res.totalFound - 1,
        });
        groups.push({
          id: `${account}|deep|${seq++}`,
          account,
          kind: 'deep',
          targetIds: memberTargets.map((e) => e.id),
          offsetIds: combo.map((e) => e.id),
          confidence,
          tier,
          reasons: [...reasons, `${memberTargets.length} reversals settled together`],
          clusterKey: null,
          inScenario: false,
          altKey: `${account}|deep-t|${memberTargets.map((e) => e.id).join(',')}`,
        });
      }
    }
    if (subset.length === MAX_TARGET_SUBSET) return;
    for (let i = start; i < targets.length; i++) {
      subset.push(i);
      recurse(i + 1, sum + Math.abs(targets[i].amount));
      subset.pop();
      if (Date.now() > deadline) return;
    }
  };
  recurse(0, 0);

  return { groups, statesExplored };
}
