import { contest, scoreEvidence, tierFor } from './confidence';
import type { AmountCluster, Entry, MatchGroup } from './types';

/** Best evidence in a sorted-desc list, using every value but one instance of `e`. */
function bestExcluding(sortedDesc: number[], e: number): number {
  if (sortedDesc.length <= 1) return -Infinity;
  // The chosen pair is the unique max ⇒ next value is the best rival; a tie at the
  // top ⇒ that equal value stays and the margin is (correctly) zero.
  return sortedDesc[0] !== e ? sortedDesc[0] : sortedDesc[1];
}

export interface Pass1Result {
  groups: MatchGroup[];
  clusters: AmountCluster[];
  /**
   * Entry ids consumed by HIGH-confidence evidenced pairs only. Weak or
   * unevidenced pairs must never block the pass-2 combination search for the
   * same entries — that is the packer's and the reviewer's call, not pass 1's.
   */
  consumedIds: Set<number>;
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
  const consumedIds = new Set<number>();
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

    // Score every cross pairing by raw evidence, then greedy-assign best first
    // (deterministic: ties broken by row order). Competition is folded in only
    // when the group is emitted, so a pairing that decisively out-scores its
    // rivals keeps its evidence instead of eating a flat ambiguity penalty.
    const candidates: { p: Entry; n: Entry; ev: number; reasons: string[]; documentary: number }[] = [];
    const evByN = new Map<number, number[]>(); // n.id -> evidences over all positives
    const evByP = new Map<number, number[]>(); // p.id -> evidences over all negatives
    for (const p of pos) {
      for (const n of neg) {
        const { score, reasons, documentary } = scoreEvidence([n], [p]);
        candidates.push({ p, n, ev: score, reasons, documentary });
        (evByN.get(n.id) ?? evByN.set(n.id, []).get(n.id)!).push(score);
        (evByP.get(p.id) ?? evByP.set(p.id, []).get(p.id)!).push(score);
      }
    }
    for (const list of evByN.values()) list.sort((a, b) => b - a);
    for (const list of evByP.values()) list.sort((a, b) => b - a);
    candidates.sort((a, b) => b.ev - a.ev || a.p.id - b.p.id || a.n.id - b.n.id);

    // Conflict degree: how many other pairings compete for this pair's positive
    // or negative (a pairing (p',n') with p'≠p and n'≠n does not conflict).
    const crowd = ambiguous ? pos.length - 1 + (neg.length - 1) : 0;

    const usedP = new Set<number>();
    const usedN = new Set<number>();
    for (const c of candidates) {
      if (usedP.has(c.p.id) || usedN.has(c.n.id)) continue;
      usedP.add(c.p.id);
      usedN.add(c.n.id);

      // Margin = how far this pairing leads the best conflicting alternative (a
      // different positive for the same negative, or vice-versa).
      const rival = Math.max(
        bestExcluding(evByN.get(c.n.id)!, c.ev),
        bestExcluding(evByP.get(c.p.id)!, c.ev),
      );
      const margin = rival === -Infinity ? c.ev : c.ev - rival;
      const confidence = contest(c.ev, crowd, margin);
      const reasons = [...c.reasons];
      if (crowd > 0) {
        reasons.push(margin >= 12 ? 'clearest of the alternatives' : `${crowd} competing entr${crowd === 1 ? 'y' : 'ies'} at this amount — review`);
      }
      const tier = tierFor(confidence);
      groups.push({
        id: `${account}|pair|${seq++}`,
        account,
        kind: 'pair',
        targetIds: [c.n.id],
        offsetIds: [c.p.id],
        confidence,
        tier,
        reasons,
        evidenced: c.documentary > 0,
        clusterKey,
        inScenario: false,
        altKey: null,
      });
      // Only a decisively evidenced pair takes its entries out of the deeper
      // search; anything weaker still competes with combinations downstream.
      if (tier === 'high' && c.documentary > 0) {
        consumedIds.add(c.p.id);
        consumedIds.add(c.n.id);
      }
    }
  }

  return { groups, clusters, consumedIds };
}
