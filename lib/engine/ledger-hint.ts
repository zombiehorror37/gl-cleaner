import type { LedgerRow } from './types';

export type LedgerKind = 'receivables' | 'payables' | 'gl';

export interface LedgerHint {
  /** Suggested ledger kind, or null when the file gives too little evidence. */
  suggested: LedgerKind | null;
  invoicesPositive: number;
  invoicesNegative: number;
  settlementsPositive: number;
  settlementsNegative: number;
  /** Lines whose document type reads as a journal / accounting document. */
  journals: number;
}

/**
 * Guess the ledger from how document types are signed: receivables book
 * invoices positive and receipts negative, payables the reverse. A file that is
 * mostly journals (SAP AB/SA, JV…) with few recognisable invoices or payments
 * is a plain GL account (accruals, clearing, expense).
 */
export function ledgerHint(rows: LedgerRow[]): LedgerHint {
  let ip = 0;
  let ineg = 0;
  let sp = 0;
  let sneg = 0;
  let journals = 0;
  for (const r of rows) {
    if (r.net === 0) continue;
    const pos = r.net > 0;
    if (r.docClass === 'invoice' || r.docClass === 'debit_note') {
      if (pos) ip++;
      else ineg++;
    } else if (r.docClass === 'payment' || r.docClass === 'credit_note') {
      if (pos) sp++;
      else sneg++;
    } else if (r.docClass === 'journal' || r.docClass === 'reversal') {
      journals++;
    }
  }
  const ar = ip + sneg;
  const ap = ineg + sp;
  const total = ar + ap;
  let suggested: LedgerKind | null = null;
  if (journals >= 10 && journals > total * 2) suggested = 'gl';
  else if (total >= 3) suggested = ar >= ap * 3 ? 'receivables' : ap >= ar * 3 ? 'payables' : null;
  return { suggested, invoicesPositive: ip, invoicesNegative: ineg, settlementsPositive: sp, settlementsNegative: sneg, journals };
}

export const ledgerKindOf = (s: { invoiceSign: 1 | -1; glAccount: boolean }): LedgerKind =>
  s.glAccount ? 'gl' : s.invoiceSign === 1 ? 'receivables' : 'payables';

export const settingsForKind = (k: LedgerKind) =>
  k === 'gl' ? { glAccount: true, invoiceSign: 1 as const } : { glAccount: false, invoiceSign: (k === 'receivables' ? 1 : -1) as 1 | -1 };
