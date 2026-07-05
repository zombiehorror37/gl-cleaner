'use client';
import { create } from 'zustand';
import type { ParsedWorkbook } from './parse';
import type { ColumnMapping } from './template';
import { EMPTY_MAPPING } from './template';
import type {
  AccountConfig,
  AmountCluster,
  EngineProgress,
  EngineResult,
  Entry,
  MatchGroup,
  TargetOutcome,
} from './engine/types';
import { DEFAULT_SEARCH, groupEntryIds } from './engine/types';

export type WizardStep = 'upload' | 'map' | 'configure' | 'review' | 'export';
export const STEP_ORDER: WizardStep[] = ['upload', 'map', 'configure', 'review', 'export'];

export interface AccountRun {
  account: string;
  result: EngineResult;
}

interface State {
  step: WizardStep;
  workbook: ParsedWorkbook | null;
  sheetIndex: number;
  mapping: ColumnMapping;
  entries: Entry[];
  skippedRows: number[];
  accounts: string[];
  configs: Record<string, AccountConfig>;
  running: boolean;
  progress: EngineProgress | null;
  runs: AccountRun[];
  approved: Set<string>;
  rejected: Set<string>;

  setStep: (s: WizardStep) => void;
  setWorkbook: (wb: ParsedWorkbook | null) => void;
  setSheetIndex: (i: number) => void;
  setMapping: (m: ColumnMapping) => void;
  setEntries: (entries: Entry[], skipped: number[], accounts: string[]) => void;
  setConfig: (account: string, patch: Partial<AccountConfig>) => void;
  setRunning: (r: boolean) => void;
  setProgress: (p: EngineProgress | null) => void;
  setRuns: (runs: AccountRun[]) => void;
  approve: (id: string) => void;
  unapprove: (id: string) => void;
  reject: (id: string) => void;
  unreject: (id: string) => void;
  approveMany: (ids: string[]) => void;
  resetDecisions: () => void;
  reset: () => void;
}

export const useStore = create<State>((set) => ({
  step: 'upload',
  workbook: null,
  sheetIndex: 0,
  mapping: { ...EMPTY_MAPPING },
  entries: [],
  skippedRows: [],
  accounts: [],
  configs: {},
  running: false,
  progress: null,
  runs: [],
  approved: new Set(),
  rejected: new Set(),

  setStep: (step) => set({ step }),
  setWorkbook: (workbook) => set({ workbook, sheetIndex: 0 }),
  setSheetIndex: (sheetIndex) => set({ sheetIndex }),
  setMapping: (mapping) => set({ mapping }),
  setEntries: (entries, skippedRows, accounts) =>
    set((st) => {
      const configs: Record<string, AccountConfig> = {};
      for (const a of accounts) {
        const existing = st.configs[a];
        if (existing) {
          configs[a] = existing;
        } else {
          // Infer nature from which side dominates; near-balanced → suspense.
          const acctEntries = entries.filter((e) => e.account === a);
          const posN = acctEntries.filter((e) => e.amount > 0).length;
          const negN = acctEntries.length - posN;
          const ratio = acctEntries.length ? Math.min(posN, negN) / acctEntries.length : 0;
          const nature = ratio > 0.25 ? 'suspense' : posN >= negN ? 'debit' : 'credit';
          configs[a] = { ...DEFAULT_SEARCH, account: a, nature };
        }
      }
      return { entries, skippedRows, accounts, configs, runs: [], approved: new Set(), rejected: new Set() };
    }),
  setConfig: (account, patch) =>
    set((st) => ({ configs: { ...st.configs, [account]: { ...st.configs[account], ...patch } } })),
  setRunning: (running) => set({ running }),
  setProgress: (progress) => set({ progress }),
  setRuns: (runs) => set({ runs, approved: new Set(), rejected: new Set() }),
  approve: (id) =>
    set((st) => {
      const approved = new Set(st.approved);
      approved.add(id);
      const rejected = new Set(st.rejected);
      rejected.delete(id);
      return { approved, rejected };
    }),
  unapprove: (id) =>
    set((st) => {
      const approved = new Set(st.approved);
      approved.delete(id);
      return { approved };
    }),
  reject: (id) =>
    set((st) => {
      const rejected = new Set(st.rejected);
      rejected.add(id);
      const approved = new Set(st.approved);
      approved.delete(id);
      return { approved, rejected };
    }),
  unreject: (id) =>
    set((st) => {
      const rejected = new Set(st.rejected);
      rejected.delete(id);
      return { rejected };
    }),
  approveMany: (ids) =>
    set((st) => {
      const approved = new Set(st.approved);
      const rejected = new Set(st.rejected);
      for (const id of ids) {
        approved.add(id);
        rejected.delete(id);
      }
      return { approved, rejected };
    }),
  resetDecisions: () => set({ approved: new Set(), rejected: new Set() }),
  reset: () =>
    set({
      step: 'upload',
      workbook: null,
      sheetIndex: 0,
      mapping: { ...EMPTY_MAPPING },
      entries: [],
      skippedRows: [],
      accounts: [],
      configs: {},
      running: false,
      progress: null,
      runs: [],
      approved: new Set(),
      rejected: new Set(),
    }),
}));

/** All groups across accounts. */
export const allGroups = (runs: AccountRun[]): MatchGroup[] => runs.flatMap((r) => r.result.groups);
export const allClusters = (runs: AccountRun[]): AmountCluster[] => runs.flatMap((r) => r.result.clusters);
export const allOutcomes = (runs: AccountRun[]): TargetOutcome[] => runs.flatMap((r) => r.result.outcomes);

/** entryId -> approved group id (locks). */
export function lockedEntries(groups: MatchGroup[], approved: Set<string>): Map<number, string> {
  const locked = new Map<number, string>();
  for (const g of groups) {
    if (!approved.has(g.id)) continue;
    for (const e of groupEntryIds(g)) locked.set(e, g.id);
  }
  return locked;
}

/** A group is blocked when an entry it needs is locked by a different approved group. */
export function isBlocked(g: MatchGroup, locked: Map<number, string>): boolean {
  return groupEntryIds(g).some((e) => {
    const owner = locked.get(e);
    return owner !== undefined && owner !== g.id;
  });
}
