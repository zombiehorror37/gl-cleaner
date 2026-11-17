import type { LedgerRow } from './types';

export interface LedgerHint {
  /** Suggested invoice sign, or null when the file gives too little evidence. */
  suggested: 1 | -1 | null;
  invoicesPositive: number;
  invoicesNegative: number;
  settlementsPositive: number;
  settlementsNegative: number;
}

/**
 * Guess receivables vs payables from how document types are signed:
 * receivables book invoices positive and receipts negative, payables the
 * reverse. Only document types we recognise count as evidence.
 */
export function ledgerHint(rows: LedgerRow[]): LedgerHint {
  let ip = 0;
  let ineg = 0;
  let sp = 0;
  let sneg = 0;
  for (const r of rows) {
    if (r.net === 0) continue;
    const pos = r.net > 0;
    if (r.docClass === 'invoice' || r.docClass === 'debit_note') {
      if (pos) ip++;
      else ineg++;
    } else if (r.docClass === 'payment' || r.docClass === 'credit_note') {
      if (pos) sp++;
      else sneg++;
    }
  }
  const ar = ip + sneg;
  const ap = ineg + sp;
  const total = ar + ap;
  const suggested = total < 3 ? null : ar >= ap * 3 ? 1 : ap >= ar * 3 ? -1 : null;
  return { suggested, invoicesPositive: ip, invoicesNegative: ineg, settlementsPositive: sp, settlementsNegative: sneg };
}
