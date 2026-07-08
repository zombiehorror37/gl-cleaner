import { groupEntryIds, type MatchGroup } from './types';

/** Weight favors cleaning more rows, then higher confidence. */
const weight = (g: MatchGroup) => groupEntryIds(g).length * 1000 + g.confidence;

const EXACT_COMPONENT_LIMIT = 22;
/** Node budget for the exact branch-and-bound; beyond it fall back to greedy. */
const EXACT_NODE_BUDGET = 200_000;

export interface ScenarioResult {
  /** Group ids included in the maximum-cleaning scenario. */
  chosen: Set<string>;
  totalEntriesCleaned: number;
}

/**
 * Weighted set packing over the conflict graph (groups conflict when they
 * share an entry). Exact branch-and-bound per connected component when small,
 * greedy + pairwise-swap local search otherwise. Deterministic.
 */
export function buildScenario(groups: MatchGroup[]): ScenarioResult {
  const byEntry = new Map<number, string[]>();
  const byId = new Map<string, MatchGroup>();
  for (const g of groups) {
    byId.set(g.id, g);
    for (const e of groupEntryIds(g)) {
      let list = byEntry.get(e);
      if (!list) {
        list = [];
        byEntry.set(e, list);
      }
      list.push(g.id);
    }
  }

  // Adjacency between conflicting groups.
  const adj = new Map<string, Set<string>>();
  for (const g of groups) adj.set(g.id, new Set());
  for (const ids of byEntry.values()) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        adj.get(ids[i])!.add(ids[j]);
        adj.get(ids[j])!.add(ids[i]);
      }
    }
  }

  // Connected components.
  const seen = new Set<string>();
  const chosen = new Set<string>();
  const sortedIds = groups.map((g) => g.id).sort();

  for (const startId of sortedIds) {
    if (seen.has(startId)) continue;
    const comp: string[] = [];
    const stack = [startId];
    seen.add(startId);
    while (stack.length) {
      const id = stack.pop()!;
      comp.push(id);
      for (const nb of adj.get(id)!) {
        if (!seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
    comp.sort();

    const picked =
      comp.length <= EXACT_COMPONENT_LIMIT
        ? exactPack(comp, adj, byId)
        : greedyPack(comp, adj, byId);
    for (const id of picked) chosen.add(id);
  }

  let total = 0;
  for (const id of chosen) total += groupEntryIds(byId.get(id)!).length;
  return { chosen, totalEntriesCleaned: total };
}

function exactPack(
  comp: string[],
  adj: Map<string, Set<string>>,
  byId: Map<string, MatchGroup>,
): string[] {
  // Order by weight descending for better bounding.
  const ordered = [...comp].sort((a, b) => weight(byId.get(b)!) - weight(byId.get(a)!) || a.localeCompare(b));
  const weights = ordered.map((id) => weight(byId.get(id)!));
  const suffix = new Array<number>(ordered.length + 1);
  suffix[ordered.length] = 0;
  for (let i = ordered.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + weights[i];

  let bestScore = -1;
  let best: string[] = [];
  const current: string[] = [];
  const blocked = new Map<string, number>();
  let nodes = 0;
  let exhausted = true;

  const dfs = (i: number, score: number) => {
    if (++nodes > EXACT_NODE_BUDGET) {
      exhausted = false;
      return;
    }
    if (score + suffix[i] <= bestScore) return;
    if (i === ordered.length) {
      if (score > bestScore) {
        bestScore = score;
        best = [...current];
      }
      return;
    }
    const id = ordered[i];
    // Include (if not blocked by an already-picked conflicting group).
    if (!blocked.get(id)) {
      current.push(id);
      for (const nb of adj.get(id)!) blocked.set(nb, (blocked.get(nb) ?? 0) + 1);
      dfs(i + 1, score + weights[i]);
      for (const nb of adj.get(id)!) blocked.set(nb, blocked.get(nb)! - 1);
      current.pop();
    }
    // Exclude.
    dfs(i + 1, score);
  };
  dfs(0, 0);
  if (!exhausted) {
    const greedy = greedyPack(comp, adj, byId);
    const greedyScore = greedy.reduce((s, id) => s + weight(byId.get(id)!), 0);
    if (greedyScore > bestScore) return greedy;
  }
  return best;
}

function greedyPack(
  comp: string[],
  adj: Map<string, Set<string>>,
  byId: Map<string, MatchGroup>,
): string[] {
  const ordered = [...comp].sort((a, b) => weight(byId.get(b)!) - weight(byId.get(a)!) || a.localeCompare(b));
  const picked = new Set<string>();
  const blocked = new Set<string>();
  for (const id of ordered) {
    if (blocked.has(id)) continue;
    picked.add(id);
    for (const nb of adj.get(id)!) blocked.add(nb);
  }

  // Local search: try swapping one picked group for two blocked neighbors.
  let improved = true;
  let rounds = 0;
  while (improved && rounds++ < 10) {
    improved = false;
    for (const id of [...picked].sort()) {
      const w = weight(byId.get(id)!);
      // Neighbors blocked solely by this pick:
      const candidates = [...adj.get(id)!]
        .filter((nb) => {
          if (picked.has(nb)) return false;
          for (const nb2 of adj.get(nb)!) {
            if (nb2 !== id && picked.has(nb2)) return false;
          }
          return true;
        })
        .sort((a, b) => weight(byId.get(b)!) - weight(byId.get(a)!) || a.localeCompare(b));
      // Pick a mutually non-conflicting subset of candidates greedily.
      const take: string[] = [];
      let gain = 0;
      for (const c of candidates) {
        if (take.every((t) => !adj.get(c)!.has(t))) {
          take.push(c);
          gain += weight(byId.get(c)!);
        }
      }
      if (gain > w) {
        picked.delete(id);
        for (const t of take) picked.add(t);
        improved = true;
        break;
      }
    }
  }
  return [...picked];
}
