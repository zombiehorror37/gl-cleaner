import { formatCents } from '../parse/values';
import type { Cents, LedgerRow, MatchGroup } from './types';

export interface OpenItem {
  /** 'original' = an untouched source line; 'residual' = the open remainder of a part-settled line. */
  kind: 'original' | 'residual';
  row: LedgerRow;
  /** For residual lines: the group that produced it. */
  groupId?: string;
}

export interface Outcome {
  approved: MatchGroup[];
  /** row id → approved group id */
  clearedBy: Map<number, string>;
  /** Open items in source order; a residual line sits where its source line was. */
  openItems: OpenItem[];
  totals: {
    originalRows: number;
    clearedRows: number;
    openRows: number;
    residualLines: number;
    originalNet: Cents;
    clearedNet: Cents;
    openNet: Cents;
  };
  /** Integrity violations. Export refuses to run when this is non-empty. */
  errors: string[];
  /** The same checks as pass/fail flags, for display. */
  checks: {
    /** No line sits in two approved matches. */
    noOverlap: boolean;
    /** Every approved match nets to zero, or its remainder is a genuine part of one member line. */
    residualsValid: boolean;
    /** Open items total equals the original total. */
    balanced: boolean;
  };
}

const RESIDUAL_KINDS = new Set(['partial', 'near', 'fifo']);

/**
 * Apply approved groups to the ledger. Approved lines leave the open items;
 * a group that does not fully net leaves one residual line (the part-settled
 * document with its remaining amount), so the open-items total ALWAYS equals
 * the original total — nothing is written off silently.
 */
export function applyDecisions(rows: LedgerRow[], groups: MatchGroup[], approvedIds: Set<string>, precision = 2): Outcome {
  const errors: string[] = [];
  let overlap = false;
  let badResidual = false;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const approved = groups.filter((g) => approvedIds.has(g.id));
  const clearedBy = new Map<number, string>();
  const residualAt = new Map<number, { group: MatchGroup; amount: Cents }>();

  for (const g of approved) {
    let sum = 0;
    for (const id of g.memberIds) {
      const r = byId.get(id);
      if (!r) {
        errors.push(`${g.id}: line ${id} does not exist.`);
        continue;
      }
      if (r.contactKey !== g.contactKey) errors.push(`${g.id}: line on row ${r.sourceRow} belongs to another contact.`);
      const prev = clearedBy.get(id);
      if (prev) {
        overlap = true;
        errors.push(`Row ${r.sourceRow} is in two approved matches (${prev} and ${g.id}).`);
      }
      else clearedBy.set(id, g.id);
      sum += r.net;
    }
    if (sum !== g.residual) badResidual = true;
    if (sum !== g.residual) errors.push(`${g.id}: lines sum to ${formatCents(sum, precision)} but the match records ${formatCents(g.residual, precision)}.`);
    if (g.residual !== 0) {
      if (!RESIDUAL_KINDS.has(g.kind)) {
        badResidual = true;
        errors.push(`${g.id}: a ${g.kind} match must net to zero.`);
      }
      if (g.residualFromId === null || !g.memberIds.includes(g.residualFromId)) {
        badResidual = true;
        errors.push(`${g.id}: residual has no source line.`);
      } else {
        const from = byId.get(g.residualFromId)!;
        if (Math.sign(from.net) !== Math.sign(g.residual) || Math.abs(g.residual) >= Math.abs(from.net)) {
          badResidual = true;
          errors.push(`${g.id}: residual ${formatCents(g.residual, precision)} is not a part of row ${from.sourceRow} (${formatCents(from.net, precision)}).`);
        }
        residualAt.set(g.residualFromId, { group: g, amount: g.residual });
      }
    }
  }

  const openItems: OpenItem[] = [];
  let originalNet = 0;
  let clearedNet = 0;
  let openNet = 0;
  for (const r of rows) {
    originalNet += r.net;
    const res = residualAt.get(r.id);
    if (clearedBy.has(r.id)) {
      clearedNet += r.net;
      if (res) {
        const note = `[open remainder of ${formatCents(r.net, precision)} after match ${res.group.id}]`;
        openItems.push({
          kind: 'residual',
          groupId: res.group.id,
          row: { ...r, net: res.amount, description: r.description ? `${r.description} ${note}` : note },
        });
        openNet += res.amount;
      }
    } else {
      openItems.push({ kind: 'original', row: r });
      openNet += r.net;
    }
  }
  const residualTotal = [...residualAt.values()].reduce((s, x) => s + x.amount, 0);
  if (clearedNet !== residualTotal) {
    errors.push(`Cleared lines net to ${formatCents(clearedNet, precision)} but residual lines carry ${formatCents(residualTotal, precision)}.`);
  }
  if (openNet !== originalNet) {
    errors.push(`Open items total ${formatCents(openNet, precision)} differs from the original ${formatCents(originalNet, precision)}.`);
  }

  return {
    approved,
    clearedBy,
    openItems,
    totals: {
      originalRows: rows.length,
      clearedRows: clearedBy.size,
      openRows: openItems.length,
      residualLines: residualAt.size,
      originalNet,
      clearedNet,
      openNet,
    },
    errors,
    checks: { noOverlap: !overlap, residualsValid: !badResidual && clearedNet === residualTotal, balanced: openNet === originalNet },
  };
}

/** Line id → owner of every approved group (for locking conflicting proposals in the UI). */
export function lockedLines(groups: MatchGroup[], approvedIds: Set<string>): Map<number, string> {
  const locked = new Map<number, string>();
  for (const g of groups) if (approvedIds.has(g.id)) for (const id of g.memberIds) locked.set(id, g.id);
  return locked;
}

export const isBlocked = (g: MatchGroup, locked: Map<number, string>) =>
  g.memberIds.some((id) => {
    const owner = locked.get(id);
    return owner !== undefined && owner !== g.id;
  });
