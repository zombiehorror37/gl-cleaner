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

export interface ScoreInput {
  targets: Entry[];
  offsets: Entry[];
  /** Number of competing alternative combos for the same target (0 = unique). */
  competingAlternatives: number;
}

export interface ScoreResult {
  confidence: number;
  tier: ConfidenceTier;
  reasons: string[];
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

export function scoreGroup({ targets, offsets, competingAlternatives }: ScoreInput): ScoreResult {
  const reasons: string[] = [];
  let score = 30;
  const all = [...targets, ...offsets];

  // Document-number proximity (measured strong signal: reversal booked as adjacent doc)
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
  if (minDocDist <= 3) {
    score += 35;
    reasons.push(`doc numbers ${minDocDist === 0 ? 'identical' : `within ${minDocDist}`}`);
  } else if (minDocDist <= 10) {
    score += 20;
    reasons.push(`doc numbers within ${minDocDist}`);
  }

  // Shared reference
  const refs = all.map((e) => e.reference?.trim()).filter((r): r is string => !!r);
  if (refs.length === all.length && new Set(refs).size === 1) {
    score += 30;
    reasons.push('same reference');
  }

  // Description cross-match: one side's description contains the other's doc number
  let crossMatch = false;
  for (const t of targets) {
    for (const o of offsets) {
      const td = t.description ?? '';
      const od = o.description ?? '';
      if ((o.docNo && td.includes(o.docNo)) || (t.docNo && od.includes(t.docNo))) {
        crossMatch = true;
      }
    }
  }
  if (crossMatch) {
    score += 30;
    reasons.push('description references counterpart document');
  }

  // Identical or overlapping descriptions
  const descs = all.map((e) => (e.description ?? '').trim()).filter(Boolean);
  if (descs.length === all.length && new Set(descs.map((d) => d.toLowerCase())).size === 1) {
    score += 25;
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
        score += 12;
        reasons.push('similar descriptions');
      }
    }
  }

  // Reversal keywords anywhere in the group
  if (
    all.some((e) => {
      const d = (e.description ?? '').toLowerCase();
      return REVERSAL_KEYWORDS.some((k) => d.includes(k));
    })
  ) {
    score += 10;
    reasons.push('reversal keyword in description');
  }

  // Doc-type pattern: JE offsetting receipts/payments
  const tTypes = new Set(targets.map((e) => e.docType).filter(Boolean));
  const oTypes = new Set(offsets.map((e) => e.docType).filter(Boolean));
  if (tTypes.has('JE') && oTypes.size > 0 && !oTypes.has('JE')) {
    score += 8;
    reasons.push('journal entry offsetting source documents');
  }

  // Date proximity
  const tDates = targets.map((e) => e.date).filter((d): d is number => d !== null);
  const oDates = offsets.map((e) => e.date).filter((d): d is number => d !== null);
  if (tDates.length && oDates.length) {
    let minDays = Infinity;
    for (const td of tDates) for (const od of oDates) minDays = Math.min(minDays, Math.abs(td - od) / DAY_MS);
    if (minDays <= 1) {
      score += 15;
      reasons.push('same/next day');
    } else if (minDays <= 3) {
      score += 10;
      reasons.push(`${Math.round(minDays)} days apart`);
    } else if (minDays <= 7) {
      score += 6;
      reasons.push('within a week');
    } else if (minDays <= 31) {
      score += 3;
      reasons.push('within a month');
    }
    // Reversal booked on/after the entries it offsets
    const maxO = Math.max(...oDates);
    const minT = Math.min(...tDates);
    if (minT >= maxO) score += 4;
  }

  // Group size: 1:1 pairs strongest, large combos weaker
  const size = all.length;
  if (size === 2) {
    score += 15;
  } else {
    score -= (size - 2) * 4;
    reasons.push(`${offsets.length}-entry combination`);
  }

  // Uniqueness: no competing combo for this target
  if (competingAlternatives === 0 && size > 2) {
    score += 12;
    reasons.push('only combination found for this amount');
  } else if (competingAlternatives > 0) {
    reasons.push(`${competingAlternatives} competing alternative${competingAlternatives > 1 ? 's' : ''}`);
  }

  const confidence = Math.max(0, Math.min(100, score));
  const tier: ConfidenceTier = confidence >= 70 ? 'high' : confidence >= 45 ? 'medium' : 'low';
  return { confidence, tier, reasons };
}
