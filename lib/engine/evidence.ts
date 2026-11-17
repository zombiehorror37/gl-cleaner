import { mentionsReversal, type Side } from '../parse/doc-class';
import { daysBetween, descriptionWords, formatCents } from '../parse/values';
import type { CleanSettings, LedgerRow, Tier } from './types';

export const sideOf = (row: LedgerRow, invoiceSign: 1 | -1): Side =>
  Math.sign(row.net) === invoiceSign ? 'charge' : 'settlement';

export const tierOf = (confidence: number): Tier => (confidence >= 75 ? 'high' : confidence >= 50 ? 'medium' : 'low');

export const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(n)));

/** Sort key: effective date, then due date, then source order. Undated lines sort last. */
export const byDate = (a: LedgerRow, b: LedgerRow): number => {
  const da = a.effectiveDate ?? a.dueDate ?? '9999-12-31';
  const db = b.effectiveDate ?? b.dueDate ?? '9999-12-31';
  return da < db ? -1 : da > db ? 1 : a.sourceRow - b.sourceRow;
};

const dateOf = (r: LedgerRow) => r.effectiveDate ?? r.dueDate;

const CHARGE_CLASSES = new Set(['invoice', 'debit_note', 'refund', 'opening']);
const SETTLEMENT_CLASSES = new Set(['payment', 'credit_note', 'wht', 'discount', 'writeoff']);

export interface Evidence {
  /** Bonus points to add on top of a kind's base confidence. */
  points: number;
  /** The same points, itemised, for the score explanation. */
  parts: { label: string; points: number }[];
  reasons: string[];
  /** Count of document-level signals (reference, wording, reversal), not just dates/types. */
  documentary: number;
  /** Settlement dated before the charge it clears. */
  prepayment: boolean;
}

/**
 * Corroborating signals for a set of lines believed to belong together —
 * what a reviewer looks for before ticking a match: the same reference,
 * matching wording, a reversal note, invoice-vs-payment document types, and
 * dates in a sensible order.
 */
export function corroborate(members: LedgerRow[], invoiceSign: 1 | -1, gl = false): Evidence {
  const reasons: string[] = [];
  const parts: { label: string; points: number }[] = [];
  let points = 0;
  let documentary = 0;
  const add = (n: number, label: string) => {
    points += n;
    parts.push({ label, points: n });
  };
  const charges = members.filter((m) => sideOf(m, invoiceSign) === 'charge');
  const settlements = members.filter((m) => sideOf(m, invoiceSign) === 'settlement');

  const refs = members.map((m) => m.reference?.trim().toLowerCase()).filter((r): r is string => !!r);
  if (refs.length === members.length && new Set(refs).size === 1) {
    add(15, 'All lines carry the same Reference');
    documentary++;
    reasons.push(`same Reference "${members[0].reference}"`);
  }

  if (members.some((m) => m.docClass === 'reversal') || mentionsReversal(...members.map((m) => m.description))) {
    const words = members.map((m) => descriptionWords(m.description));
    const shared = [...words[0]].filter((w) => words.every((s) => s.has(w)));
    if (members.length === 2 || shared.length > 0) {
      add(12, 'Marked as a reversal (document type or wording)');
      documentary++;
      reasons.push('reversal entry');
    }
  } else if (charges.length && settlements.length) {
    const cw = new Set(charges.flatMap((m) => [...descriptionWords(m.description)]));
    const sw = new Set(settlements.flatMap((m) => [...descriptionWords(m.description)]));
    if (cw.size && sw.size) {
      const inter = [...cw].filter((w) => sw.has(w)).length;
      const jac = inter / (cw.size + sw.size - inter);
      if (jac >= 0.5) {
        add(10, 'Descriptions share most of their words');
        documentary++;
        reasons.push('matching descriptions');
      }
    }
  }

  if (
    charges.length &&
    settlements.length &&
    charges.every((m) => CHARGE_CLASSES.has(m.docClass)) &&
    settlements.every((m) => SETTLEMENT_CLASSES.has(m.docClass))
  ) {
    add(6, 'Document types fit (invoice side vs payment / credit side)');
    reasons.push('document types fit (charge vs settlement)');
  }

  let prepayment = false;
  const cDates = charges.map(dateOf).filter((d): d is string => !!d);
  const sDates = settlements.map(dateOf).filter((d): d is string => !!d);
  if (cDates.length && sDates.length) {
    const lastCharge = cDates.reduce((a, b) => (a > b ? a : b));
    const firstSettle = sDates.reduce((a, b) => (a < b ? a : b));
    const gap = daysBetween(lastCharge, firstSettle);
    if (gap >= 0) {
      const after = gl ? 'credit dated on/after the debit' : 'settlement dated on/after the charge';
      if (gap <= 120) add(5, `Dates in a sensible order (${after}, ${gap} day(s) apart)`);
      else add(2, `Dates in order but far apart (${gap} days)`);
      if (gap === 0 && members.length === 2) reasons.push('same date');
    } else {
      prepayment = true;
      // On a GL account a credit before the debit (reclass first, accrual later) is normal.
      if (!gl) reasons.push(`settlement dated ${-gap} day(s) before the charge`);
    }
  }
  return { points, parts, reasons, documentary, prepayment };
}

/**
 * Explain a leftover difference the way a reviewer would: rounding, a
 * withholding-tax rate (on the gross or the pre-VAT amount), small bank/FX
 * charges, or simply an outstanding balance.
 */
export function describeDifference(
  residual: number,
  base: number,
  residualSide: Side,
  settings: CleanSettings,
): { label: string; withinTolerance: boolean; withholding: boolean } {
  const abs = Math.abs(residual);
  const p = settings.precision;
  const unit = 10 ** p;
  const fmt = (c: number) => formatCents(c, p);
  const slack = Math.max(1, Math.round(unit / 50)); // ±0.02 at 2 decimals

  if (residualSide === 'charge' && base > 0 && !settings.glAccount) {
    for (const rate of settings.withholdingRates) {
      const gross = Math.round((base * rate) / 100);
      if (Math.abs(abs - gross) <= slack) {
        return { label: `difference ${fmt(abs)} = ${rate}% of ${fmt(base)} (withholding tax or discount?)`, withinTolerance: true, withholding: true };
      }
      if (settings.vatRate > 0) {
        const preVat = Math.round(base / (1 + settings.vatRate / 100));
        const net = Math.round((preVat * rate) / 100);
        if (Math.abs(abs - net) <= slack) {
          return {
            label: `difference ${fmt(abs)} = ${rate}% of ${fmt(preVat)} (amount before ${settings.vatRate}% VAT, typical withholding tax)`,
            withinTolerance: true,
            withholding: true,
          };
        }
      }
    }
  }
  if (abs <= unit) return { label: `rounding difference of ${fmt(abs)}`, withinTolerance: true, withholding: false };
  if (settings.glAccount) {
    const pctTolGl = settings.tolerancePercent > 0 ? Math.round((base * settings.tolerancePercent) / 100) : 0;
    const within = abs <= Math.max(settings.toleranceAmount, pctTolGl);
    const which = residualSide === 'charge' ? 'debit exceeds the credit' : 'credit exceeds the debit';
    return { label: `${which} by ${fmt(abs)}${within ? ' (small difference)' : ''}`, withinTolerance: within, withholding: false };
  }
  const pctTol = settings.tolerancePercent > 0 ? Math.round((base * settings.tolerancePercent) / 100) : 0;
  if (abs <= Math.max(settings.toleranceAmount, pctTol)) {
    return {
      label:
        residualSide === 'charge'
          ? `short by ${fmt(abs)} (bank charges / FX / discount?)`
          : `over-settled by ${fmt(abs)} (bank charges / FX?)`,
      withinTolerance: true,
      withholding: false,
    };
  }
  return {
    label: residualSide === 'charge' ? `${fmt(abs)} still outstanding` : `${fmt(abs)} over-settled (unapplied credit)`,
    withinTolerance: false,
    withholding: false,
  };
}
