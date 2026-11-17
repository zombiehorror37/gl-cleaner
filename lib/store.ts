'use client';
import { create } from 'zustand';
import type { RawWorkbook } from './parse/read';
import { validateSheet, DEFAULT_VALIDATION, type ValidationOptions, type ValidationResult } from './parse/validate';
import { DEFAULT_SETTINGS, type CleanProgress, type CleanResult, type CleanSettings } from './engine/types';

export type Step = 'upload' | 'check' | 'review' | 'export';
export const STEPS: Step[] = ['upload', 'check', 'review', 'export'];
export const STEP_LABEL: Record<Step, string> = {
  upload: 'Upload',
  check: 'Check & Settings',
  review: 'Review Matches',
  export: 'Export',
};

interface State {
  step: Step;
  workbook: RawWorkbook | null;
  sheetIndex: number;
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
  reset: () => void;
}

const revalidate = (wb: RawWorkbook | null, sheetIndex: number, opts: ValidationOptions) =>
  wb && wb.sheets[sheetIndex] ? validateSheet(wb.sheets[sheetIndex].matrix, opts) : null;

const firstValidSheet = (wb: RawWorkbook, opts: ValidationOptions) => {
  for (let i = 0; i < wb.sheets.length; i++) {
    const v = validateSheet(wb.sheets[i].matrix, opts);
    if (v.headerOk) return { i, v };
  }
  return { i: 0, v: validateSheet(wb.sheets[0]?.matrix ?? [], opts) };
};

const cleared = { result: null, approved: new Set<string>(), dismissed: new Set<string>(), progress: null };

export const useStore = create<State>((set, get) => ({
  step: 'upload',
  workbook: null,
  sheetIndex: 0,
  validationOptions: { ...DEFAULT_VALIDATION },
  validation: null,
  settings: { ...DEFAULT_SETTINGS },
  ledgerChosen: false,
  running: false,
  progress: null,
  result: null,
  approved: new Set(),
  dismissed: new Set(),

  setStep: (step) => set({ step }),
  loadWorkbook: (workbook) => {
    const { i, v } = firstValidSheet(workbook, get().validationOptions);
    set({ workbook, sheetIndex: i, validation: v, step: 'check', ledgerChosen: false, ...cleared });
  },
  setSheet: (sheetIndex) =>
    set((st) => ({ sheetIndex, validation: revalidate(st.workbook, sheetIndex, st.validationOptions), ...cleared })),
  setValidationOptions: (patch) =>
    set((st) => {
      const validationOptions = { ...st.validationOptions, ...patch };
      return {
        validationOptions,
        validation: revalidate(st.workbook, st.sheetIndex, validationOptions),
        settings: { ...st.settings, precision: validationOptions.precision },
        ...cleared,
      };
    }),
  setSettings: (patch, ledgerChosen) =>
    set((st) => ({ settings: { ...st.settings, ...patch }, ledgerChosen: ledgerChosen ?? st.ledgerChosen, ...cleared })),
  setRunning: (running) => set({ running }),
  setProgress: (progress) => set({ progress }),
  setResult: (result) => set({ result, approved: new Set(), dismissed: new Set() }),
  approve: (ids) =>
    set((st) => {
      const approved = new Set(st.approved);
      const dismissed = new Set(st.dismissed);
      for (const id of ids) {
        approved.add(id);
        dismissed.delete(id);
      }
      return { approved, dismissed };
    }),
  unapprove: (id) =>
    set((st) => {
      const approved = new Set(st.approved);
      approved.delete(id);
      return { approved };
    }),
  dismiss: (id) =>
    set((st) => {
      const dismissed = new Set(st.dismissed);
      dismissed.add(id);
      const approved = new Set(st.approved);
      approved.delete(id);
      return { approved, dismissed };
    }),
  undismiss: (id) =>
    set((st) => {
      const dismissed = new Set(st.dismissed);
      dismissed.delete(id);
      return { dismissed };
    }),
  clearDecisions: () => set({ approved: new Set(), dismissed: new Set() }),
  reset: () =>
    set({
      step: 'upload',
      workbook: null,
      sheetIndex: 0,
      validation: null,
      ledgerChosen: false,
      running: false,
      ...cleared,
    }),
}));
