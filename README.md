# GL Cleaner

Cleans customer and supplier ledgers that come in one fixed GL template. It works through each contact the way a careful accountant does by hand: it ties payments and credit notes to the invoices they settle and shows why each match was made. Approved matches come out of the ledger, and whatever is genuinely open stays in. Nothing is written off silently.

**Everything runs in your browser.** There is no server and no upload, so ledger data never leaves the machine.

## The template (strict)

| # | Column | Mandatory |
|---|--------|-----------|
| 1 | Contact Code | ✔ |
| 2 | Contact Name | ✔ |
| 3 | Transaction Id | ✔ |
| 4 | Document Type | |
| 5 | Due Date | |
| 6 | Effective Date | |
| 7 | Reference | |
| 8 | Description | |
| 9 | Net | ✔ |

The headers must be exactly these nine, in this order. Matching ignores case, extra spaces and the `*` marker, and nothing else. A file that doesn't match is rejected, and the message says which column is wrong (out of order, missing, unexpected extra). The upload screen offers a blank template to download.

### Real-world file problems handled

- **Report layout:** title rows above the header, a blank first column, headers repeated at page breaks, blank rows, and subtotal / total / balance b/f lines (EN + AR) are all skipped and counted.
- **Grouped reports:** some reports print the contact only on the first line of each group. The app detects this and offers to fill the contact down. Contact heading lines are skipped.
- **Missing fields:** a blank Contact Name is filled from other lines with the same code. Rows missing a mandatory field are excluded and listed in the export with the reason.
- **Amounts:** `1,234.56`, `(1,234.56)`, `1,234.56-` (SAP), `1,234.56 CR/DR`, currency symbols, Arabic-Indic digits, European `1.234,56`, and Excel error values (`#N/A`). Integer minor units are used throughout (no float drift), with 0, 2 or 3 decimals.
- **Dates:**
  - Real Excel date cells are read by their number format.
  - Text dates are checked for day-first vs month-first across the whole file. Mixed formats are flagged row by row.
  - Impossible dates are rejected rather than rolled over.
  - Unreadable dates are kept as text in the output.
- **CSV:** read as plain text, so no silent US date guessing. Arabic ANSI (windows-1256) is detected automatically.
- **Contacts:**
  - Code variants (`00123` vs `123`, case and spaces) are treated as one contact.
  - The same code under different names is flagged.
  - The same name under different codes is flagged as a possible duplicate account. Contacts are never merged automatically.

## How matching works (per contact)

You choose the ledger side: **Receivables** (invoices +) or **Payables** (invoices −). The app suggests one from how the document types are signed and warns if your choice disagrees.

1. **Zero-value lines:** cleared.
2. **Same Transaction Id:** a posting and its reversal, or an invoice settled under the same id. The same id posted twice for the same amount is flagged as a **duplicate**.
3. **Reference links:** a payment or credit note whose Reference or Description cites another line's Transaction Id (`INV-1001`, `inv 1001/1002`, `Pmt for 1001`), or lines sharing an uncommon Reference. The app tries these in order:
   - a full settlement;
   - a settlement completed by an unreferenced second instalment;
   - a **partial settlement**, where the invoice stays open for the remainder (FIFO across several invoices).
4. **Exact amounts without links:**
   - the only charge/settlement pair of an amount;
   - identical amounts paired **oldest-first** (monthly rent, retainers);
   - one payment covering several invoices, or one invoice paid in instalments (subset search).
   
   When several combinations fit, they are offered as alternatives and not suggested.
5. **Nil contacts:** everything left on the contact nets to zero.
6. **Near misses** (proposed only, approved one by one): differences within a tolerance (bank charges, FX, rounding), or equal to a withholding/discount rate on the gross or pre-VAT amount (e.g. 1% WHT on an invoice that includes 14% VAT).
7. **Balance-forward (FIFO)** (proposed only, approved one by one): leftover payments are applied to the oldest invoices.

A line whose Reference cites a document that belongs to *another* contact is never amount-matched. It is flagged as a **possible wrong-contact posting**.

**Residual lines.** When an approved match doesn't fully net (partial payment, near miss, FIFO), the part-settled document stays in the open items with its remaining amount. It keeps its own Transaction Id, dates and reference. So **the open-items total always equals the original total**, and export refuses to run if it doesn't.

## Output workbook

| Sheet | Contents |
|-------|----------|
| Open Items | The cleaned ledger in the exact template. It can be re-imported. |
| Detail | Every line with Status (Open / Cleared / Part-settled), open amount, match id, type, confidence, reasons |
| Matches | One row per approved match |
| Exceptions | Duplicates, wrong-contact postings, sign problems, unapplied cash, credit balances, ambiguous matches, search limits |
| Rejected Rows | Excluded rows and why |
| Contact Summary | Original vs open balance per contact, with live Excel checks |
| Summary | Settings, counts, totals, live integrity checks |

## Development

```bash
npm run dev      # dev server
npm test         # unit + scenario + end-to-end + performance tests
npm run sample   # regenerate sample/sample-ledger.xlsx and sample/blank-template.xlsx
npm run build    # static production build
```

`sample/sample-ledger.xlsx` (also served as `/sample-ledger.xlsx` via the "try it with a sample" link) is a deliberately messy receivables ledger that exercises every case above.

Code map:
- `lib/template.ts`: the template and header checks
- `lib/parse/`: file reading, cell parsing, document-type classification, row validation
- `lib/engine/clean.ts`: the per-contact pipeline
- `lib/engine/apply.ts`: approvals → open items + integrity checks
- `lib/export.ts`: workbook output
- `components/steps/`: the four screens
