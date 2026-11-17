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
  /** Lines linked by a Reference/Description that cites another line's Transaction Id, netting to zero. */
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
  zero: 'Zero-value line',
  'same-id': 'Same Transaction Id',
  linked: 'Linked by reference',
  partial: 'Partial settlement',
  pair: 'Exact amount pair',
  'fifo-pair': 'Identical amounts (FIFO)',
  combo: 'Amount combination',
  nil: 'Contact nets to zero',
  near: 'Near miss',
  fifo: 'Balance-forward (FIFO)',
};

export type Tier = 'high' | 'medium' | 'low';

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
  | 'search-limit';

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
