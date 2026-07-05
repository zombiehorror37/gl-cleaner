// All amounts are integer "cents" (scaled by 10^precision). Never floats.
export type Cents = number;

export interface Entry {
  /** Stable index of the row in the source file (0-based over data rows). */
  id: number;
  /** Account key; empty string when the file has no account column. */
  account: string;
  /** Epoch milliseconds, or null when unparseable/missing. */
  date: number | null;
  docNo: string | null;
  docType: string | null;
  reference: string | null;
  description: string | null;
  amount: Cents;
  /** Original cell values, preserved verbatim for export. */
  raw: unknown[];
}

export type Nature = 'debit' | 'credit' | 'suspense';

export interface SearchConfig {
  /** Max entries on the offsetting side of a combo (2..10). */
  maxComboSize: number;
  /** Per-target search time budget in ms. */
  perTargetBudgetMs: number;
  /** Max alternative combos kept per target. */
  maxAlternatives: number;
  /** Only combine entries within this many days of the target; null = no limit. */
  dateWindowDays: number | null;
  /** Enable pass 3 many-to-many search. */
  deepSearch: boolean;
  /** Global budget for pass 3 in ms. */
  deepSearchBudgetMs: number;
}

export interface AccountConfig extends SearchConfig {
  account: string;
  nature: Nature;
}

export const DEFAULT_SEARCH: SearchConfig = {
  maxComboSize: 5,
  perTargetBudgetMs: 5000,
  maxAlternatives: 20,
  dateWindowDays: null,
  deepSearch: false,
  deepSearchBudgetMs: 30000,
};

export type GroupKind = 'pair' | 'combo' | 'deep';
export type ConfidenceTier = 'high' | 'medium' | 'low';

export interface MatchGroup {
  id: string;
  account: string;
  kind: GroupKind;
  /** Unnatural-sign side (the reversal / target entries). */
  targetIds: number[];
  /** Natural-sign side offsetting the target. */
  offsetIds: number[];
  /** 0..100 */
  confidence: number;
  tier: ConfidenceTier;
  reasons: string[];
  /** Groups sharing a clusterKey compete for the same absolute amount (pass 1 ambiguity). */
  clusterKey: string | null;
  /** True if part of the suggested maximum-cleaning scenario. */
  inScenario: boolean;
  /** Alternative combos for the same target share an altKey (targetIds joined). */
  altKey: string | null;
}

export const groupEntryIds = (g: MatchGroup): number[] => [...g.targetIds, ...g.offsetIds];

export type TargetStatus =
  | 'matched'
  | 'proven-unmatchable' // bitset oracle proved no subset of any size sums to target
  | 'exhausted-no-combo' // search space fully explored within size cap, none found
  | 'budget-exhausted'; // timed out before exhausting the space

export interface TargetOutcome {
  targetId: number;
  status: TargetStatus;
  combosFound: number;
  statesExplored: number;
  elapsedMs: number;
}

export interface AmountCluster {
  key: string;
  account: string;
  absAmount: Cents;
  positiveIds: number[];
  negativeIds: number[];
}

export interface EngineProgress {
  phase: 'pass1' | 'pass2' | 'pass3' | 'scenario' | 'done';
  account: string;
  targetsDone: number;
  targetsTotal: number;
  groupsFound: number;
  statesExplored: number;
}

export interface EngineResult {
  groups: MatchGroup[];
  clusters: AmountCluster[];
  outcomes: TargetOutcome[];
  stats: {
    totalEntries: number;
    positiveEntries: number;
    negativeEntries: number;
    statesExplored: number;
    elapsedMs: number;
  };
}
