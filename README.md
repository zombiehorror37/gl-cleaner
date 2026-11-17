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

**Pick the ledger:**
- **Receivables:** invoices are positive (+).
- **Payables:** invoices are negative (−).
- **GL account:** accruals, clearing, suspense or expense. Debits are positive and credits negative. Each "contact" is an account, journals may hit several accounts, and there is no balance-forward or "unapplied cash" logic.

The app suggests a ledger from the document types, including SAP codes such as DR/KR/DZ/KZ/SA/AB.

1. **Zero-value lines:** cleared.
2. **Same Transaction Id:** a posting and its reversal, or an invoice settled under the same id. The same id posted twice for the same amount is flagged as a **duplicate**.
3. **Links:**
   - a line whose Reference or Description cites another line's Transaction Id (`INV-1001`, `inv 1001/1002`);
   - lines sharing an uncommon Reference;
   - lines whose descriptions carry the same identifiers, e.g. meter + period, so `ACC-1/2025E07-ELEC` matches `R/ACR E7 1/25`.

   The app then tries, in order: a full settlement; a settlement completed by an unreferenced second instalment; or a **partial settlement**, where the document stays open for the remainder (FIFO across several invoices). If lines are linked only by their descriptions and the amounts differ, the match is proposed but never suggested.
4. **Exact amounts without links:**
   - the only pair of an amount;
   - identical amounts paired **oldest-first**;
   - one line equal to several on the other side.

   When several combinations fit, they are offered as alternatives. An amount-only combination is suggested only when a coincidence is unlikely. The app estimates the chance from the number of candidate lines and how round the amounts are.
5. **Nil contacts:** everything left nets to zero.
6. **Near misses** (approved one by one): differences within a tolerance, or equal to a withholding/discount rate on the gross or pre-VAT amount. The difference must be small next to the amounts themselves.
7. **Balance-forward (FIFO)** (receivables/payables only, approved one by one): leftover payments are applied to the oldest invoices.

A line that cites a document belonging to *another* contact is never amount-matched. It is flagged as a **possible wrong-contact posting** (customer/supplier ledgers only).

**Notes the app adds:** open lines that refer to a period before the file starts, accruals for the last period whose reversal falls after the file ends, and descriptions whose Arabic text was replaced by `#` in the export.

**Residual lines.** When an approved match doesn't fully net, the part-settled document stays in the open items with its remaining amount. It keeps its own Transaction Id, dates and reference. So **the open-items total always equals the original total**, and export refuses to run if it doesn't.

## Reviewing

- **Tags:** every proposal has a type tag in one of three colour families: blue = *document match*, violet = *amount match*, amber = *needs judgement*. Each also has a confidence tag. Hover the confidence to see how the score was built: the starting score, the evidence points, and any ceiling.
- **Filters:** click any tag, facet, family name or contact to filter by it.
- **Rows:** each proposal is one line; click it to see the full lines.
- **Bulk approval:** "Approve all suggested" and "Approve N shown" never include near misses, balance-forward or alternatives.
- **Keyboard:** `j`/`k` move, `Enter` expands, `a` approves, `d` dismisses, `u` undoes, `/` searches, `?` shows help.
- **Saved decisions:** decisions are saved in this browser for each file, matched on the file's content. They come back after a refresh, a re-upload of the same data, or a re-run with different settings. Settings are remembered too.

## Output workbook

| Sheet | Contents |
|-------|----------|
| Open Items | The cleaned ledger in the exact template. It can be re-imported. |
| Detail | Every line with Status (Open / Cleared / Part-settled), open amount, match id, type, confidence, reasons |
| Matches | Every proposal with your decision (approved / dismissed / not reviewed), how its confidence was scored, and why |
| Exceptions | Duplicates, wrong-contact postings, sign problems, unapplied cash, credit balances, ambiguous matches, out-of-period counterparts, lost text, search limits |
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
- `lib/persist.ts`: saved decisions and settings (browser storage)
- `lib/review-meta.ts`, `components/review/`: tag vocabulary, match rows
- `lib/export.ts`: workbook output
- `components/steps/`: the four screens
