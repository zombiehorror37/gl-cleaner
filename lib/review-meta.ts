import type { ExceptionKind, GroupKind, Tier } from './engine/types';

/**
 * One vocabulary for the review screen: every match type belongs to one of
 * three families, and each family has one colour. Labels are short enough to
 * scan; the description is the tooltip / legend text.
 */
export type Family = 'document' | 'amount' | 'judgement' | 'neutral';

export const FAMILY: Record<Family, { label: string; description: string }> = {
  document: { label: 'Document match', description: 'Tied by Transaction Id, Reference or description, not just by amount.' },
  amount: { label: 'Amount match', description: 'Tied by amounts only: no document links between the lines.' },
  judgement: { label: 'Needs judgement', description: 'Amounts differ or allocation is assumed. Approve one by one.' },
  neutral: { label: 'Housekeeping', description: 'Lines with nothing to settle.' },
};

export const KIND_META: Record<GroupKind, { family: Family; description: string }> = {
  'same-id': { family: 'document', description: 'Lines share one Transaction Id and net to zero (posting + reversal, or settled under the same id).' },
  linked: { family: 'document', description: 'A line cites the other’s Transaction Id, shares an uncommon Reference, or has the same description keys (e.g. meter + period).' },
  partial: { family: 'document', description: 'Linked lines that do not fully net. The settled part clears, and the remainder stays open as a residual line.' },
  pair: { family: 'amount', description: 'The only charge and settlement of this exact amount.' },
  'fifo-pair': { family: 'amount', description: 'Several identical amounts on both sides, paired oldest-first.' },
  combo: { family: 'amount', description: 'One line equals the sum of several lines on the other side.' },
  nil: { family: 'amount', description: 'Everything left on the contact nets to exactly zero.' },
  near: { family: 'judgement', description: 'Amounts differ by a small amount or a withholding rate. The difference stays open.' },
  fifo: { family: 'judgement', description: 'Leftover settlements applied to the oldest charges (balance-forward).' },
  zero: { family: 'neutral', description: 'The line’s Net is zero.' },
};

export const KIND_ORDER: GroupKind[] = ['same-id', 'linked', 'partial', 'pair', 'fifo-pair', 'combo', 'nil', 'near', 'fifo', 'zero'];
export const FAMILY_ORDER: Family[] = ['document', 'amount', 'judgement', 'neutral'];

export const TIER_LABEL: Record<Tier, string> = { high: 'High', medium: 'Medium', low: 'Low' };
export const TIER_ORDER: Tier[] = ['high', 'medium', 'low'];

/** Review status of a proposal, as the reviewer sees it. */
export type ReviewStatus = 'suggested' | 'review' | 'approved' | 'dismissed' | 'blocked';
export const STATUS_ORDER: ReviewStatus[] = ['suggested', 'review', 'approved', 'dismissed', 'blocked'];
export const STATUS_META: Record<ReviewStatus, { label: string; description: string }> = {
  suggested: { label: 'Suggested', description: 'Pending, and part of the suggested clean-up.' },
  review: { label: 'To review', description: 'Pending, but needs your judgement (not suggested).' },
  approved: { label: 'Approved', description: 'Will be removed from the open items.' },
  dismissed: { label: 'Dismissed', description: 'You rejected this proposal.' },
  blocked: { label: 'Blocked', description: 'A line in it is already in an approved match.' },
};

export const EXCEPTION_SEVERITY_LABEL = { warning: 'Warning', info: 'Note' } as const;
export type { ExceptionKind };
