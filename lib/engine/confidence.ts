import type { ConfidenceTier, Entry } from './types';

const REVERSAL_KEYWORDS = [
  'reversal',
  'reverse',
  'reversed',
  'correction',
  'correct',
  'reclass',
  'storno',
  'عكس',
  'تصحيح',
  'إلغاء',
  'الغاء',
  'عكسي',
];

const DAY_MS = 86_400_000;

/** Tier cut-offs, shared by every scorer so the badge always agrees with the number. */
export const HIGH_THRESHOLD = 70;
export const MEDIUM_THRESHOLD = 45;

export function tierFor(confidence: number): ConfidenceTier {
  return confidence >= HIGH_THRESHOLD ? 'high' : confidence >= MEDIUM_THRESHOLD ? 'medium' : 'low';
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export interface ScoreInput {
  targets: Entry[];
  offsets: Entry[];
  /** Number of competing alternative combos for the same target (0 = unique). */
  competingAlternatives: number;
}

export interface ScoreResult {
  /** Raw corroboration strength, 0..100, independent of competition. */
  evidence: number;
  /** Evidence adjusted for how many alternatives compete for the same amount. */
  confidence: number;
  tier: ConfidenceTier;
  reasons: string[];
}

export interface Evidence {
  /** 0..100 corroboration score. */
  score: number;
  reasons: string[];
  /** How many independent corroborating signals fired (excludes the amount match itself). */
  signals: number;
}

const numericDoc = (e: Entry): number | null => {
  if (!e.docNo) return null;
  const m = e.docNo.replace(/\D/g, '');
  if (!m || m.length > 15) return null;
  return Number(m);
};

const tokenize = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length >= 3),
  );

/**
 * Pure corroboration score for one candidate offset group against its target(s):
 * how much independent evidence says these entries are genuinely the same
 * transaction reversed, ignoring whether other combos also clear the amount.
 *
 * Every group already sums to zero (that is the search invariant), so an exact
 * amount match earns only a small base — it is necessary, not sufficient. Real
 * confidence comes from *corroborating* fields (doc numbers, references, dates,
 * descriptions). A group with none of those is treated as a coincidence and
 * capped below the medium tier by the completeness guard.
 */
export function scoreEvidence(targets: Entry[], offsets: Entry[]): Evidence {
  const reasons: string[] = [];
  const all = [...targets, ...offsets];
  let score = 8; // exact offset exists — necessary but weak on its own
  let signals = 0;

  // Document-number proximity: a reversal is very often booked as an adjacent
  // voucher, so a tiny numeric distance is the single strongest signal.
  let minDocDist = Infinity;
  for (const t of targets) {
    const tn = numericDoc(t);
    if (tn === null) continue;
    for (const o of offsets) {
      const on = numericDoc(o);
      if (on === null) continue;
      minDocDist = Math.min(minDocDist, Math.abs(tn - on));
    }
  }
  if (minDocDist === 0) {
    // An identical document number on an exact equal-and-opposite amount is the
    // signature of a voucher reversed against itself — strong enough that a clean
    // 1:1 pair reaches the high tier on this signal alone (8 + 48 + 14 = 70).
    score += 48;
    signals++;
    reasons.push('identical doc numbers');
  } else if (minDocDist <= 3) {
    score += 34;
    signals++;
    reasons.push(`doc numbers within ${minDocDist}`);
  } else if (minDocDist <= 10) {
    score += 18;
    signals++;
    reasons.push(`doc numbers within ${minDocDist}`);
  }

  // Shared reference across the whole group.
  const refs = all.map((e) => e.reference?.trim()).filter((r): r is string => !!r);
  if (refs.length === all.length && new Set(refs.map((r) => r.toLowerCase())).size === 1) {
    score += 28;
    signals++;
    reasons.push('same reference');
  }

  // Description cross-reference: one side's text cites the other's document.
  let crossMatch = false;
  for (const t of targets) {
    for (const o of offsets) {
      const td = t.description ?? '';
      const od = o.description ?? '';
      if ((o.docNo && td.includes(o.docNo)) || (t.docNo && od.includes(t.docNo))) crossMatch = true;
    }
  }
  if (crossMatch) {
    score += 26;
    signals++;
    reasons.push('description cites counterpart document');
  }

  // Description similarity.
  const descs = all.map((e) => (e.description ?? '').trim()).filter(Boolean);
  if (descs.length === all.length && new Set(descs.map((d) => d.toLowerCase())).size === 1) {
    score += 22;
    signals++;
    reasons.push('identical descriptions');
  } else {
    const [a, ...rest] = descs;
    if (a && rest.length) {
      const ta = tokenize(a);
      const shared = rest.every((d) => {
        const td = tokenize(d);
        let inter = 0;
        for (const tok of td) if (ta.has(tok)) inter++;
        const union = new Set([...ta, ...td]).size;
        return union > 0 && inter / union >= 0.5;
      });
      if (shared) {
        score += 11;
        signals++;
        reasons.push('similar descriptions');
      }
    }
  }

  // Reversal keyword anywhere in the group.
  if (
    all.some((e) => {
      const d = (e.description ?? '').toLowerCase();
      return REVERSAL_KEYWORDS.some((k) => d.includes(k));
    })
  ) {
    score += 10;
    signals++;
    reasons.push('reversal keyword in description');
  }

  // Doc-type pattern: a journal entry offsetting source documents.
  const tTypes = new Set(targets.map((e) => e.docType).filter(Boolean));
  const oTypes = new Set(offsets.map((e) => e.docType).filter(Boolean));
  if (tTypes.has('JE') && oTypes.size > 0 && !oTypes.has('JE')) {
    score += 8;
    signals++;
    reasons.push('journal entry offsetting source documents');
  }

  // Date proximity.
  const tDates = targets.map((e) => e.date).filter((d): d is number => d !== null);
  const oDates = offsets.map((e) => e.date).filter((d): d is number => d !== null);
  if (tDates.length && oDates.length) {
    let minDays = Infinity;
    for (const td of tDates) for (const od of oDates) minDays = Math.min(minDays, Math.abs(td - od) / DAY_MS);
    if (minDays <= 1) {
      score += 14;
      signals++;
      reasons.push('same/next day');
    } else if (minDays <= 3) {
      score += 9;
      signals++;
      reasons.push(`${Math.round(minDays)} days apart`);
    } else if (minDays <= 7) {
      score += 6;
      signals++;
      reasons.push('within a week');
    } else if (minDays <= 31) {
      score += 3;
      reasons.push('within a month');
    }
    // Reversal booked on/after the entries it offsets — the expected direction.
    const maxO = Math.max(...oDates);
    const minT = Math.min(...tDates);
    if (minT >= maxO) score += 4;
  }

  // Group size: a clean 1:1 pair is the gold standard; larger combinations are
  // progressively more likely to sum to the target by coincidence.
  if (all.length === 2) {
    score += 14;
  } else {
    score -= Math.min(22, (offsets.length - 1) * 4);
    reasons.push(`${offsets.length}-entry combination`);
  }

  // Completeness guard: with zero corroborating signals this is an amount-only
  // coincidence. Cap it below the medium tier no matter how the base adds up.
  if (signals === 0) {
    score = Math.min(score, 30);
    reasons.push('amount-only match — no supporting detail');
  }

  return { score: clamp(score), reasons, signals };
}

/**
 * Fold competition among alternatives into the confidence of one combo.
 *
 * `crowd` is the number of *other* combos that also clear this exact amount, and
 * `marginOverRival` is how far this combo's evidence leads the best rival (>0
 * only for the leader; 0 otherwise). More rivals means less certainty that this
 * particular combo is the real reversal, so we subtract a crowd penalty — but a
 * decisive evidence lead earns that penalty back. The upshot: a clear winner
 * keeps its high score, while a field of near-ties all drop toward "human,
 * please choose" territory.
 */
export function contest(evidence: number, crowd: number, marginOverRival: number): number {
  if (crowd <= 0) return clamp(evidence);
  const penalty = Math.min(25, crowd * 6);
  const relief = Math.max(0, Math.min(penalty, marginOverRival * 0.8));
  return clamp(evidence - penalty + relief);
}

/**
 * Convenience scorer for call sites that don't rank a whole alternative set
 * (exact pairs, deep many-to-many, the netting sweep). No margin information is
 * available here, so competition is applied conservatively (full crowd penalty).
 */
export function scoreGroup({ targets, offsets, competingAlternatives }: ScoreInput): ScoreResult {
  const ev = scoreEvidence(targets, offsets);
  const confidence = contest(ev.score, competingAlternatives, 0);
  return { evidence: ev.score, confidence, tier: tierFor(confidence), reasons: ev.reasons };
}
