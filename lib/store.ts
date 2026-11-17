'use client';
import { create } from 'zustand';
import type { RawWorkbook } from './parse/read';
import { validateSheet, DEFAULT_VALIDATION, type ValidationOptions, type ValidationResult } from './parse/validate';
import { DEFAULT_SETTINGS, type CleanProgress, type CleanResult, type CleanSettings } from './engine/types';
import { isBlocked } from './engine/apply';
import { fingerprint, loadDecisions, loadPrefs, saveDecisions, savePrefs, signature } from './persist';

export type Step = 'upload' | 'check' | 'review' | 'export';
export const STEPS: Step[] = ['upload', 'check', 'review', 'export'];
export const STEP_LABEL: Record<Step, string> = {
  upload: 'Upload',
  check: 'Check & Settings',
  review: 'Review Matches',
  export: 'Export',
};

export interface RestoredInfo {
  approved: number;
  dismissed: number;
  /** Saved decisions that no longer match any proposal (settings changed what is proposed). */
  missing: number;
  savedAt: string;
}

interface State {
  step: Step;
  workbook: RawWorkbook | null;
  sheetIndex: number;
  /** Content fingerprint of the selected sheet: the key for saved decisions. */
  fingerprint: string | null;
  validationOptions: ValidationOptions;
  validation: ValidationResult | null;
  settings: CleanSettings;
  /** True once the user picked the ledger side explicitly (stops auto-suggestion overriding it). */
  ledgerChosen: boolean;
  running: boolean;
  progress: CleanProgress | null;
  result: CleanResult | null;
  approved: Set<string>;
  dismissed: Set<string>;
  /** Set when decisions from an earlier session / run were re-applied. */
  restored: RestoredInfo | null;

  setStep: (s: Step) => void;
  loadWorkbook: (wb: RawWorkbook) => void;
  setSheet: (i: number) => void;
  setValidationOptions: (patch: Partial<ValidationOptions>) => void;
  setSettings: (patch: Partial<CleanSettings>, ledgerChosen?: boolean) => void;
  setRunning: (r: boolean) => void;
  setProgress: (p: CleanProgress | null) => void;
  setResult: (r: CleanResult | null) => void;
  approve: (ids: string[]) => void;
  unapprove: (id: string) => void;
  dismiss: (id: string) => void;
  undismiss: (id: string) => void;
  clearDecisions: () => void;
  dismissRestored: () => void;
  reset: () => void;
}

const revalidate = (wb: RawWorkbook | null, sheetIndex: number, opts: ValidationOptions) =>
  wb && wb.sheets[sheetIndex] ? validateSheet(wb.sheets[sheetIndex].matrix, opts) : null;

const fpOf = (wb: RawWorkbook | null, i: number) => (wb && wb.sheets[i] ? fingerprint(wb.sheets[i].name, wb.sheets[i].matrix) : null);

const firstValidSheet = (wb: RawWorkbook, opts: ValidationOptions) => {
  for (let i = 0; i < wb.sheets.length; i++) {
    const v = validateSheet(wb.sheets[i].matrix, opts);
    if (v.headerOk) return { i, v };
  }
  return { i: 0, v: validateSheet(wb.sheets[0]?.matrix ?? [], opts) };
};

/** Results are recomputed after any setting change; decisions live on in storage and are re-applied. */
const cleared = { result: null, approved: new Set<string>(), dismissed: new Set<string>(), progress: null, restored: null };

const prefs = loadPrefs();
const initialValidation: ValidationOptions = { ...DEFAULT_VALIDATION, ...(prefs?.validation ?? {}) };
const initialSettings: CleanSettings = { ...DEFAULT_SETTINGS, ...(prefs?.settings ?? {}), precision: initialValidation.precision };

const persistPrefs = (settings: CleanSettings, v: ValidationOptions) =>
  savePrefs({ settings, validation: { precision: v.precision, dateOrder: v.dateOrder } });

/** Write the current decisions (as signatures) for this file. */
function persistDecisions(st: Pick<State, 'fingerprint' | 'result' | 'validation' | 'approved' | 'dismissed'>) {
  if (!st.fingerprint || !st.result || !st.validation) return;
  const rowsById = new Map(st.validation.rows.map((r) => [r.id, r]));
  const byId = new Map(st.result.groups.map((g) => [g.id, g]));
  const sig = (id: string) => signature(byId.get(id)!, rowsById);
  saveDecisions(st.fingerprint, { approved: [...st.approved].map(sig), dismissed: [...st.dismissed].map(sig) });
}

export const useStore = create<State>((set, get) => ({
  step: 'upload',
  workbook: null,
  sheetIndex: 0,
  fingerprint: null,
  validationOptions: initialValidation,
  validation: null,
  settings: initialSettings,
  ledgerChosen: false,
  running: false,
  progress: null,
  result: null,
  approved: new Set(),
  dismissed: new Set(),
  restored: null,

  setStep: (step) => set({ step }),
  loadWorkbook: (workbook) => {
    const { i, v } = firstValidSheet(workbook, get().validationOptions);
    set({ workbook, sheetIndex: i, fingerprint: fpOf(workbook, i), validation: v, step: 'check', ledgerChosen: false, ...cleared });
  },
  setSheet: (sheetIndex) =>
    set((st) => ({ sheetIndex, fingerprint: fpOf(st.workbook, sheetIndex), validation: revalidate(st.workbook, sheetIndex, st.validationOptions), ...cleared })),
  setValidationOptions: (patch) =>
    set((st) => {
      const validationOptions = { ...st.validationOptions, ...patch };
      const settings = { ...st.settings, precision: validationOptions.precision };
      persistPrefs(settings, validationOptions);
      return { validationOptions, validation: revalidate(st.workbook, st.sheetIndex, validationOptions), settings, ...cleared };
    }),
  setSettings: (patch, ledgerChosen) =>
    set((st) => {
      const settings = { ...st.settings, ...patch };
      persistPrefs(settings, st.validationOptions);
      return { settings, ledgerChosen: ledgerChosen ?? st.ledgerChosen, ...cleared };
    }),
  setRunning: (running) => set({ running }),
  setProgress: (progress) => set({ progress }),
  setResult: (result) => {
    const st = get();
    if (!result || !st.validation || !st.fingerprint) {
      set({ result, approved: new Set(), dismissed: new Set(), restored: null });
      return;
    }
    // Re-apply decisions saved for this file (earlier run, refresh, or an earlier session).
    const saved = loadDecisions(st.fingerprint);
    const approved = new Set<string>();
    const dismissed = new Set<string>();
    let missing = 0;
    if (saved) {
      const rowsById = new Map(st.validation.rows.map((r) => [r.id, r]));
      const bySig = new Map(result.groups.map((g) => [signature(g, rowsById), g]));
      const locked = new Map<number, string>();
      for (const s of saved.approved) {
        const g = bySig.get(s);
        if (!g) {
          missing++;
          continue;
        }
        if (isBlocked(g, locked)) continue;
        approved.add(g.id);
        for (const id of g.memberIds) locked.set(id, g.id);
      }
      for (const s of saved.dismissed) {
        const g = bySig.get(s);
        if (g && !approved.has(g.id)) dismissed.add(g.id);
        else if (!g) missing++;
      }
    }
    set({
      result,
      approved,
      dismissed,
      restored: saved && approved.size + dismissed.size + missing > 0 ? { approved: approved.size, dismissed: dismissed.size, missing, savedAt: saved.savedAt } : null,
    });
  },
  approve: (ids) => {
    set((st) => {
      const approved = new Set(st.approved);
      const dismissed = new Set(st.dismissed);
      for (const id of ids) {
        approved.add(id);
        dismissed.delete(id);
      }
      return { approved, dismissed };
    });
    persistDecisions(get());
  },
  unapprove: (id) => {
    set((st) => {
      const approved = new Set(st.approved);
      approved.delete(id);
      return { approved };
    });
    persistDecisions(get());
  },
  dismiss: (id) => {
    set((st) => {
      const dismissed = new Set(st.dismissed);
      dismissed.add(id);
      const approved = new Set(st.approved);
      approved.delete(id);
      return { approved, dismissed };
    });
    persistDecisions(get());
  },
  undismiss: (id) => {
    set((st) => {
      const dismissed = new Set(st.dismissed);
      dismissed.delete(id);
      return { dismissed };
    });
    persistDecisions(get());
  },
  clearDecisions: () => {
    set({ approved: new Set(), dismissed: new Set(), restored: null });
    persistDecisions(get());
  },
  dismissRestored: () => set({ restored: null }),
  reset: () =>
    set({
      step: 'upload',
      workbook: null,
      sheetIndex: 0,
      fingerprint: null,
      validation: null,
      ledgerChosen: false,
      running: false,
      ...cleared,
    }),
}));
