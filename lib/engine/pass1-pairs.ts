import { scoreGroup } from './confidence';
import type { AmountCluster, Entry, MatchGroup } from './types';

export interface Pass1Result {
  groups: MatchGroup[];
  clusters: AmountCluster[];
  /** Entry ids consumed by proposed pairs (used to build pass-2 residual). */
  pairedIds: Set<number>;
}

/**
 * Exact 1:1 pairs: bucket by absolute amount; within each two-sided bucket
 * propose min(pos, neg) pairings chosen greedily by confidence.
 * Buckets with multiple candidates are also reported as AmountClusters so the
 * review UI can show the full competing set (the "sorted helper column" view).
 */
export function findExactPairs(entries: Entry[], account: string): Pass1Result {
  const buckets = new Map<number, { pos: Entry[]; neg: Entry[] }>();
  for (const e of entries) {
    if (e.amount === 0) continue;
    const key = Math.abs(e.amount);
    let b = buckets.get(key);
    if (!b) {
      b = { pos: [], neg: [] };
      buckets.set(key, b);
    }
    (e.amount > 0 ? b.pos : b.neg).push(e);
  }

  const groups: MatchGroup[] = [];
  const clusters: AmountCluster[] = [];
  const pairedIds = new Set<number>();
  let seq = 0;

  const sortedKeys = [...buckets.keys()].sort((a, b) => b - a);
  for (const abs of sortedKeys) {
    const { pos, neg } = buckets.get(abs)!;
    if (pos.length === 0 || neg.length === 0) continue;

    const ambiguous = pos.length > 1 || neg.length > 1;
    const clusterKey = ambiguous ? `${account}|${abs}` : null;
    if (ambiguous) {
      clusters.push({
        key: clusterKey!,
        account,
        absAmount: abs,
        positiveIds: pos.map((e) => e.id),
        negativeIds: neg.map((e) => e.id),
      });
    }

    // Score every cross pairing, then greedy-assign best first (deterministic:
    // ties broken by row order).
    const candidates: { p: Entry; n: Entry; confidence: number }[] = [];
    for (const p of pos) {
      for (const n of neg) {
        const { confidence } = scoreGroup({ targets: [n], offsets: [p], competingAlternatives: 0 });
        candidates.push({ p, n, confidence });
      }
    }
    candidates.sort(
      (a, b) => b.confidence - a.confidence || a.p.id - b.p.id || a.n.id - b.n.id,
    );

    const usedP = new Set<number>();
    const usedN = new Set<number>();
    for (const c of candidates) {
      if (usedP.has(c.p.id) || usedN.has(c.n.id)) continue;
      usedP.add(c.p.id);
      usedN.add(c.n.id);
      const { confidence, tier, reasons } = scoreGroup({
        targets: [c.n],
        offsets: [c.p],
        competingAlternatives: ambiguous ? pos.length * neg.length - 1 : 0,
      });
      groups.push({
        id: `${account}|pair|${seq++}`,
        account,
        kind: 'pair',
        targetIds: [c.n.id],
        offsetIds: [c.p.id],
        confidence,
        tier,
        reasons,
        clusterKey,
        inScenario: false,
        altKey: null,
      });
      pairedIds.add(c.p.id);
      pairedIds.add(c.n.id);
    }
  }

  return { groups, clusters, pairedIds };
}
