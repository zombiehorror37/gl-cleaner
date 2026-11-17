import type { LedgerRow } from '../parse/validate';
import type { Cents } from '../parse/values';

export type { LedgerRow, Cents };

/**
 * How a group of lines was matched, in the order the engine tries them —
 * the same order a careful accountant works a contact ledger.
 */
export type GroupKind =
  /** A line whose Net is zero. Nothing to settle. */
  | 'zero'
  /** Lines sharing one Transaction Id that net to zero (posting + reversal, invoice + settlement under the same id). */
  | 'same-id'
  /** Lines linked by a Reference/Description citing another line's Transaction Id, or by matching description keys (meter + period), netting to zero. */
  | 'linked'
  /** Linked lines that do NOT fully net: settled part removed, remainder kept open as a residual line. */
  | 'partial'
  /** One charge and one settlement of exactly the same amount, the only such pair for that amount. */
  | 'pair'
  /** Several identical amounts on both sides: oldest settlement applied to oldest charge. */
  | 'fifo-pair'
  /** One line settled by several lines on the other side summing exactly to it. */
  | 'combo'
  /** Everything left on a contact nets to exactly zero. */
  | 'nil'
  /** One charge and one settlement that differ by a small amount (tolerance / withholding rate). */
  | 'near'
  /** Balance-forward: all remaining settlements applied to the oldest charges. */
  | 'fifo';

export const KIND_LABEL: Record<GroupKind, string> = {
  zero: 'Zero line',
  'same-id': 'Same ID',
  linked: 'Reference link',
  partial: 'Partial',
  pair: 'Exact pair',
  'fifo-pair': 'FIFO pair',
  combo: 'Combination',
  nil: 'Nets to zero',
  near: 'Near miss',
  fifo: 'Balance-forward',
};

export type Tier = 'high' | 'medium' | 'low';

/** Confidence = base (why this kind of match is plausible) + evidence points, limited to 0..cap. */
export interface ScoreBreakdown {
  /** Plain-language reason for the starting score. */
  basis: string;
  base: number;
  /** Corroborating evidence, each worth some points. */
  parts: { label: string; points: number }[];
  /** Set when the total was limited: the ceiling for this kind of match. */
  cap: number | null;
}

export interface MatchGroup {
  /** Stable, human-readable id: M00001… */
  id: string;
  contactKey: string;
  kind: GroupKind;
  memberIds: number[];
  /**
   * Sum of the members' Net. 0 for exact groups. When non-zero the group can
   * only be approved together with a residual line carrying this amount, so
   * the open-items total never changes.
   */
  residual: Cents;
  /** Member whose fields the residual line inherits (the partly-settled document). */
  residualFromId: number | null;
  confidence: number;
  tier: Tier;
  /** How the confidence was built, for the on-hover explanation. */
  score: ScoreBreakdown;
  reasons: string[];
  /** Part of the engine's suggested clean-up ("Approve all suggested"). */
  suggested: boolean;
  /** Near misses and balance-forward allocations can only be approved one by one. */
  individualOnly: boolean;
  /** Competing alternatives for the same anchor line share a key. */
  altKey: string | null;
}

export type ExceptionKind =
  | 'duplicate'
  | 'possible-duplicate'
  | 'sign'
  | 'misposting'
  | 'shared-id'
  | 'unapplied'
  | 'opposite-balance'
  | 'ambiguous'
  | 'search-limit'
  | 'other-period'
  | 'lost-text';

export const EXCEPTION_LABEL: Record<ExceptionKind, string> = {
  duplicate: 'Duplicate posting',
  'possible-duplicate': 'Possible duplicate',
  sign: 'Unexpected sign',
  misposting: 'Possible wrong contact',
  'shared-id': 'Transaction Id on several contacts',
  unapplied: 'Unapplied settlement',
  'opposite-balance': 'Balance on the wrong side',
  ambiguous: 'Ambiguous match',
  'search-limit': 'Search limit reached',
  'other-period': 'Counterpart outside this file',
  'lost-text': 'Text lost in export',
};

export interface LedgerException {
  id: string;
  kind: ExceptionKind;
  severity: 'warning' | 'info';
  contactKey: string | null;
  rowIds: number[];
  message: string;
}

export interface CleanSettings {
  /** Sign invoices carry in this file: +1 receivables (debit), −1 payables (credit). */
  invoiceSign: 1 | -1;
  /**
   * A plain GL account (accruals, clearing, suspense, expense) rather than a
   * customer/supplier ledger: sides are just debit (+) and credit (−); no
   * balance-forward, no "unapplied cash" logic.
   */
  glAccount: boolean;
  /** Currency decimals (matches the validation precision). */
  precision: number;
  /** Near-miss tolerance in minor units (cents). */
  toleranceAmount: Cents;
  /** Near-miss tolerance as % of the charge; 0 = off. */
  tolerancePercent: number;
  /** Differences equal to one of these % of the charge are proposed as withholding/discount. */
  withholdingRates: number[];
  /** VAT % included in invoice totals; withholding is also tested on the pre-VAT amount. 0 = off. */
  vatRate: number;
  /** Largest number of lines on the many side of a combination. */
  maxComboSize: number;
  /** Time budget per combination search (ms). */
  perTargetBudgetMs: number;
  /** Total time budget for combination searches across the file (ms). */
  totalComboBudgetMs: number;
  /** Offer balance-forward FIFO allocation for whatever cannot be matched. */
  balanceForward: boolean;
}

export const DEFAULT_SETTINGS: CleanSettings = {
  invoiceSign: 1,
  glAccount: false,
  precision: 2,
  toleranceAmount: 1000, // 10.00
  tolerancePercent: 0,
  withholdingRates: [0.5, 1, 3, 5],
  vatRate: 14,
  maxComboSize: 6,
  perTargetBudgetMs: 300,
  totalComboBudgetMs: 60_000,
  balanceForward: true,
};

export interface ContactSummary {
  key: string;
  code: string;
  name: string;
  rowIds: number[];
  balance: Cents;
  charges: number;
  settlements: number;
}

export interface CleanResult {
  groups: MatchGroup[];
  exceptions: LedgerException[];
  contacts: ContactSummary[];
  settings: CleanSettings;
  elapsedMs: number;
}

export interface CleanProgress {
  contactsDone: number;
  contactsTotal: number;
  contact: string;
}
