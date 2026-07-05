import { groupEntryIds, type Entry, type MatchGroup } from './types';

export interface VerifyResult {
  ok: boolean;
  errors: string[];
}

/**
 * Hard invariants enforced before any export:
 *  1. every approved group sums to exactly 0 cents;
 *  2. no entry belongs to two approved groups;
 *  3. every referenced entry exists.
 * These are the "100% accuracy" guarantees — a violation aborts the export.
 */
export function verifyApproved(groups: MatchGroup[], entries: Map<number, Entry>): VerifyResult {
  const errors: string[] = [];
  const used = new Map<number, string>();

  for (const g of groups) {
    let sum = 0;
    for (const id of groupEntryIds(g)) {
      const e = entries.get(id);
      if (!e) {
        errors.push(`group ${g.id}: entry ${id} not found`);
        continue;
      }
      sum += e.amount;
      const prev = used.get(id);
      if (prev) {
        errors.push(`entry ${id} appears in both ${prev} and ${g.id}`);
      } else {
        used.set(id, g.id);
      }
    }
    if (sum !== 0) {
      errors.push(`group ${g.id} sums to ${sum} cents, not zero`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Reconciliation totals shown in the UI and written to the Summary sheet. */
export function reconcile(all: Entry[], removedIds: Set<number>) {
  let originalTotal = 0;
  let removedTotal = 0;
  let cleanedTotal = 0;
  for (const e of all) {
    originalTotal += e.amount;
    if (removedIds.has(e.id)) removedTotal += e.amount;
    else cleanedTotal += e.amount;
  }
  return {
    originalTotal,
    removedTotal,
    cleanedTotal,
    balanced: removedTotal === 0 && originalTotal === cleanedTotal + removedTotal,
    originalRows: all.length,
    removedRows: removedIds.size,
    cleanedRows: all.length - removedIds.size,
  };
}
