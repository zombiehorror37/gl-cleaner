/**
 * What kind of document a line is, read the way a person reads it: the
 * Document Type column first, then the Transaction Id prefix, then the
 * Description. English and Arabic vocabulary.
 */
export type DocClass =
  | 'invoice'
  | 'debit_note'
  | 'credit_note'
  | 'payment'
  | 'refund'
  | 'discount'
  | 'wht'
  | 'writeoff'
  | 'reversal'
  | 'opening'
  | 'journal'
  | 'unknown';

/** charge = raises what the contact owes / is owed (invoice side); settlement = reduces it. */
export type Side = 'charge' | 'settlement';

export const DOC_CLASS_LABEL: Record<DocClass, string> = {
  invoice: 'Invoice',
  debit_note: 'Debit note',
  credit_note: 'Credit note',
  payment: 'Payment',
  refund: 'Refund',
  discount: 'Discount',
  wht: 'Withholding tax',
  writeoff: 'Write-off',
  reversal: 'Reversal',
  opening: 'Opening balance',
  journal: 'Journal',
  unknown: 'Other',
};

/** Which side a document type is normally booked on; null = either is normal. */
export const EXPECTED_SIDE: Record<DocClass, Side | null> = {
  invoice: 'charge',
  debit_note: 'charge',
  refund: 'charge',
  credit_note: 'settlement',
  payment: 'settlement',
  discount: 'settlement',
  wht: 'settlement',
  writeoff: 'settlement',
  reversal: null,
  opening: null,
  journal: null,
  unknown: null,
};

// Ordered: the first pattern that matches wins.
const PATTERNS: [DocClass, RegExp][] = [
  ['reversal', /revers|\brev\b|\bvoid|cancel|storno|عكس|إلغاء|الغاء|ملغ/i],
  ['opening', /opening|\bo\/b\b|\bob\b|\bb\/f\b|brought\s*forward|رصيد\s*(افتتاحي|أول|اول)|(أول|اول)\s*المدة/i],
  ['wht', /withholding|\bw\.?h\.?t\b|tax\s*deduct|خصم\s*(و\s*)?(إضافة|اضافة)|المنبع|ضريبة\s*الخصم/i],
  ['writeoff', /write[\s-]*off|bad\s*debt|إعدام|اعدام|شطب/i],
  ['credit_note', /credit\s*(note|memo)|\bc\.?n\b|\bcrn\b|إشعار\s*دائن|اشعار\s*دائن|مرتجع|sales\s*return|purchase\s*return/i],
  ['debit_note', /debit\s*(note|memo)|\bd\.?n\b|إشعار\s*مدين|اشعار\s*مدين/i],
  ['refund', /refund|استرداد|رد\s*مبلغ/i],
  ['discount', /discount|خصم\s*(مسموح|مكتسب|تعجيل)/i],
  ['payment', /payment|receipt|remittance|\bpmt\b|\brct\b|\bpay\b|cheque|\bcheck\b|\bchq\b|transfer|\bwire\b|deposit|collection|\bcash\b|\bbank\b|سداد|تحصيل|دفع|شيك|تحويل|إيصال|ايصال|سند\s*(قبض|صرف)|نقد/i],
  ['invoice', /invoice|\binv\b|\bbill\b|فاتور/i],
  ['journal', /journal|\bj\.?v\b|\bj\.?e\b|adjust|reclass|قيد|تسوية/i],
];

const ID_PREFIX: [DocClass, RegExp][] = [
  ['reversal', /^(rev|void)[-_/ .#]?/i],
  ['credit_note', /^(cn|crn|cm)[-_/ .#]?\d/i],
  ['debit_note', /^(dn|dm)[-_/ .#]?\d/i],
  ['payment', /^(pmt|pay|rct|rcpt|rec|rv|pv|chq|br|bp)[-_/ .#]?\d/i],
  ['invoice', /^(inv|si|pi|bill|tinv)[-_/ .#]?\d/i],
  ['journal', /^(jv|je|jnl)[-_/ .#]?\d/i],
];

/**
 * Standard SAP FI/MM document type codes (the 2-letter "Document Type" in SAP
 * line-item exports). Only applied when the cell is exactly the code.
 */
const SAP_CODES: Record<string, DocClass> = {
  DR: 'invoice', RV: 'invoice', KR: 'invoice', RE: 'invoice', RN: 'invoice',
  DG: 'credit_note', KG: 'credit_note',
  DZ: 'payment', KZ: 'payment', ZP: 'payment', DA: 'payment', KA: 'payment',
  SA: 'journal', AB: 'journal', SB: 'journal', SK: 'journal', SU: 'journal', AF: 'journal', AA: 'journal',
};

const match = (text: string | null, table: [DocClass, RegExp][]): DocClass | null => {
  if (!text) return null;
  for (const [cls, re] of table) if (re.test(text)) return cls;
  return null;
};

export function classifyDocument(
  documentType: string | null,
  transactionId: string,
  description: string | null,
): DocClass {
  const code = documentType?.trim().toUpperCase();
  return (
    (code && code.length <= 3 ? SAP_CODES[code] : undefined) ??
    match(documentType, PATTERNS) ??
    match(transactionId, ID_PREFIX) ??
    match(description, PATTERNS) ??
    'unknown'
  );
}

const REVERSAL_WORDS = /revers|\brev\b|\bvoid|cancel|storno|correct|عكس|إلغاء|الغاء|تصحيح/i;

export const mentionsReversal = (...texts: (string | null)[]) => texts.some((t) => !!t && REVERSAL_WORDS.test(t));
