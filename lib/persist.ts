/**
 * Local persistence (this browser only, nothing leaves the machine):
 *   - review decisions per file, so a refresh, a closed tab or a re-run with
 *     different settings doesn't throw away hours of review;
 *   - the user's preferred settings (ledger, tolerance, VAT, decimals, dates).
 *
 * Decisions are stored by *signature* (match type + source rows + residual),
 * not by match id, so they survive re-runs that renumber the matches.
 */
import type { CleanSettings, LedgerRow, MatchGroup } from './engine/types';
import type { ValidationOptions } from './parse/validate';
import { cellText, type CellValue } from './parse/values';

const PREFIX = 'gl-cleaner:';
const DECISIONS_INDEX = `${PREFIX}decisions-index`;
const PREFS = `${PREFIX}prefs`;
const MAX_FILES = 20;

const storage = (): Storage | null => {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
};

/** FNV-1a over the sheet's content: the same data gives the same fingerprint whatever the file is called. */
export function fingerprint(sheetName: string, matrix: CellValue[][]): string {
  let h = 0x811c9dc5;
  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x1f;
    h = Math.imul(h, 0x01000193);
  };
  feed(sheetName);
  for (const row of matrix) {
    for (const c of row) feed(cellText(c));
    feed('\n');
  }
  return `${(h >>> 0).toString(36)}-${matrix.length}`;
}

export const signature = (g: MatchGroup, rowsById: Map<number, LedgerRow>) =>
  `${g.kind}|${g.memberIds
    .map((id) => rowsById.get(id)!.sourceRow)
    .sort((a, b) => a - b)
    .join(',')}|${g.residual}`;

export interface SavedDecisions {
  approved: string[];
  dismissed: string[];
  savedAt: string;
}

export function loadDecisions(fp: string): SavedDecisions | null {
  try {
    const raw = storage()?.getItem(`${PREFIX}decisions:${fp}`);
    return raw ? (JSON.parse(raw) as SavedDecisions) : null;
  } catch {
    return null;
  }
}

export function saveDecisions(fp: string, d: Omit<SavedDecisions, 'savedAt'>) {
  const s = storage();
  if (!s) return;
  try {
    const key = `${PREFIX}decisions:${fp}`;
    if (!d.approved.length && !d.dismissed.length) {
      s.removeItem(key);
      return;
    }
    s.setItem(key, JSON.stringify({ ...d, savedAt: new Date().toISOString() }));
    // Keep only the most recent files.
    const index = (JSON.parse(s.getItem(DECISIONS_INDEX) ?? '[]') as string[]).filter((k) => k !== fp);
    index.unshift(fp);
    for (const old of index.slice(MAX_FILES)) s.removeItem(`${PREFIX}decisions:${old}`);
    s.setItem(DECISIONS_INDEX, JSON.stringify(index.slice(0, MAX_FILES)));
  } catch {
    // Storage full or blocked: decisions still work for this session.
  }
}

export interface Prefs {
  settings: Partial<CleanSettings>;
  validation: Partial<Pick<ValidationOptions, 'precision' | 'dateOrder'>>;
}

export function loadPrefs(): Prefs | null {
  try {
    const raw = storage()?.getItem(PREFS);
    return raw ? (JSON.parse(raw) as Prefs) : null;
  } catch {
    return null;
  }
}

export function savePrefs(p: Prefs) {
  try {
    storage()?.setItem(PREFS, JSON.stringify(p));
  } catch {
    // ignore
  }
}
