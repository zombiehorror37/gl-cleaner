'use client';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useStore } from '@/lib/store';
import { cleanInBackground } from '@/lib/engine/run-async';
import { ledgerHint, ledgerKindOf, settingsForKind, type LedgerKind } from '@/lib/engine/ledger-hint';
import { buildTemplateWorkbook } from '@/lib/export';
import { formatCents, parseAmount } from '@/lib/parse/values';
import { TEMPLATE_HEADERS } from '@/lib/template';
import type { ValidationIssue } from '@/lib/parse/validate';
import { Badge, Button, Card, cx, downloadBuffer, Field, inputClass, Stat } from '@/components/ui';

export default function CheckStep() {
  const workbook = useStore((s) => s.workbook)!;
  const sheetIndex = useStore((s) => s.sheetIndex);
  const setSheet = useStore((s) => s.setSheet);
  const validation = useStore((s) => s.validation);
  const vopts = useStore((s) => s.validationOptions);
  const setVopts = useStore((s) => s.setValidationOptions);
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const ledgerChosen = useStore((s) => s.ledgerChosen);
  const running = useStore((s) => s.running);
  const progress = useStore((s) => s.progress);
  const setRunning = useStore((s) => s.setRunning);
  const setProgress = useStore((s) => s.setProgress);
  const setResult = useStore((s) => s.setResult);
  const setStep = useStore((s) => s.setStep);
  const reset = useStore((s) => s.reset);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(() => validation?.rows ?? [], [validation]);
  const hint = useMemo(() => ledgerHint(rows), [rows]);
  // Follow the data's suggestion until the user picks a side themselves.
  useEffect(() => {
    if (!ledgerChosen && hint.suggested && hint.suggested !== ledgerKindOf(settings)) setSettings(settingsForKind(hint.suggested));
  }, [hint.suggested, ledgerChosen, settings, setSettings]);
  const kind = ledgerKindOf(settings);

  if (!validation) return null;
  const p = vopts.precision;

  const run = async () => {
    setError(null);
    setRunning(true);
    setProgress(null);
    try {
      const result = await cleanInBackground(rows, settings, setProgress);
      setResult(result);
      setStep('review');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const sheetPicker = workbook.sheets.length > 1 && (
    <select value={sheetIndex} onChange={(e) => setSheet(Number(e.target.value))} className={cx(inputClass, 'w-auto')}>
      {workbook.sheets.map((s, i) => (
        <option key={i} value={i}>
          Sheet: {s.name}
        </option>
      ))}
    </select>
  );

  if (!validation.headerOk) {
    const found = validation.headerRow > 0 ? workbook.sheets[sheetIndex].matrix[validation.headerRow - 1] : null;
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-medium">{workbook.fileName}</span>
          {sheetPicker}
        </div>
        <Card className="border-red-500/30 p-5">
          <h2 className="text-lg font-semibold text-red-600 dark:text-red-400">This file does not match the GL template</h2>
          <p className="mt-1 text-sm opacity-70">
            The template is strict: these {TEMPLATE_HEADERS.length} columns, in this order. Fix the header (or copy your data into the blank template) and upload again.
          </p>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
            {validation.headerProblems.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
          <div className="mt-4 overflow-auto">
            <table className="text-left text-sm">
              <tbody>
                <tr>
                  <th className="pr-3 font-medium opacity-60">Expected</th>
                  {TEMPLATE_HEADERS.map((h) => (
                    <td key={h} className="whitespace-nowrap border border-black/10 px-2 py-1 dark:border-white/10">
                      {h}
                    </td>
                  ))}
                </tr>
                {found && (
                  <tr>
                    <th className="pr-3 font-medium opacity-60">Row {validation.headerRow}</th>
                    {TEMPLATE_HEADERS.map((_, i) => (
                      <td key={i} className="whitespace-nowrap border border-black/10 px-2 py-1 dark:border-white/10">
                        {String((found as unknown[])[validation.columnOffset + i] ?? '')}
                      </td>
                    ))}
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex gap-2">
            <Button onClick={async () => downloadBuffer(await buildTemplateWorkbook(), 'GL-template.xlsx')}>Download blank template</Button>
            <Button variant="ghost" onClick={reset}>
              Choose another file
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const s = validation.stats;
  const balance = rows.reduce((a, r) => a + r.net, 0);
  const skipped = s.blank + s.repeatedHeaders + s.summaryRows + s.headingRows;
  const evidence = hint.invoicesPositive + hint.invoicesNegative + hint.settlementsPositive + hint.settlementsNegative;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium">{workbook.fileName}</span>
        {sheetPicker}
        <Badge tone="good">Template ✓ (header on row {validation.headerRow})</Badge>
      </div>

      <div className="flex flex-wrap gap-2">
        <Stat label="Valid lines" value={s.valid.toLocaleString()} />
        <Stat label="Contacts" value={s.contacts.toLocaleString()} />
        <Stat label="Rejected rows" value={s.rejected} tone={s.rejected ? 'bad' : undefined} hint={s.rejected ? 'listed in export' : 'none'} />
        <Stat label="Skipped rows" value={skipped} hint="blank, totals, headings" />
        <Stat label="Ledger balance" value={formatCents(balance, p)} />
      </div>

      {validation.issues.length > 0 && <IssueList issues={validation.issues} />}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-4 p-5">
          <h3 className="font-semibold">Ledger</h3>
          <div className="grid gap-2 sm:grid-cols-3">
            {LEDGERS.map((l) => (
              <button
                key={l.kind}
                onClick={() => setSettings(settingsForKind(l.kind), true)}
                className={cx(
                  'rounded-lg border p-3 text-left transition',
                  kind === l.kind ? 'border-indigo-500 bg-indigo-500/5 ring-1 ring-indigo-500' : 'border-black/15 hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/5',
                )}
              >
                <div className="font-medium">{l.title}</div>
                <div className="text-sm opacity-70">{l.body}</div>
              </button>
            ))}
          </div>
          <p className="text-xs opacity-70">
            {evidence > 0 && (
              <>
                From the document types: {hint.invoicesPositive} invoice(s) positive, {hint.invoicesNegative} negative; {hint.settlementsNegative} payment/credit note(s) negative,{' '}
                {hint.settlementsPositive} positive{hint.journals > 0 && `; ${hint.journals} journal / accounting document(s)`}.{' '}
              </>
            )}
            {evidence === 0 && hint.journals > 0 && <>{hint.journals} journal / accounting document(s), no invoices or payments recognised. </>}
            {hint.suggested && (
              <>
                This looks like <b>{LEDGERS.find((l) => l.kind === hint.suggested)!.title}</b>.
                {hint.suggested !== kind && <span className="text-amber-600 dark:text-amber-400"> Your choice differs.</span>}
              </>
            )}
          </p>

          <h3 className="pt-2 font-semibold">Reading the file</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Currency decimals">
              <select className={inputClass} value={vopts.precision} onChange={(e) => setVopts({ precision: Number(e.target.value) })}>
                <option value={2}>2 (EGP, USD, EUR, SAR…)</option>
                <option value={3}>3 (KWD, BHD, OMR, JOD)</option>
                <option value={0}>0 (JPY…)</option>
              </select>
            </Field>
            <Field
              label="Date format"
              hint={
                vopts.dateOrder === 'auto'
                  ? {
                      dmy: 'Detected day-first from the file.',
                      mdy: 'Detected month-first from the file.',
                      mixed: 'Mixed formats found: see the warning above.',
                      ambiguous: 'Text dates read both ways: assuming day-first.',
                      none: 'Dates are real Excel dates: nothing to detect.',
                    }[validation.dateOrderDetected]
                  : undefined
              }
            >
              <select className={inputClass} value={vopts.dateOrder} onChange={(e) => setVopts({ dateOrder: e.target.value as 'auto' | 'dmy' | 'mdy' })}>
                <option value="auto">Auto-detect</option>
                <option value="dmy">Day first (DD/MM/YYYY)</option>
                <option value="mdy">Month first (MM/DD/YYYY)</option>
              </select>
            </Field>
          </div>
          <label className={cx('flex items-start gap-2 rounded-lg p-2 text-sm', validation.fillDownCandidates > 0 && !vopts.fillDown && 'bg-amber-500/10')}>
            <input type="checkbox" className="mt-0.5" checked={vopts.fillDown} onChange={(e) => setVopts({ fillDown: e.target.checked })} />
            <span>
              <b>Fill blank contacts from the row above</b>
              <span className="block opacity-70">
                For grouped reports that print the contact only on the first line.
                {validation.fillDownCandidates > 0 && !vopts.fillDown && ` ${validation.fillDownCandidates} row(s) would be kept.`}
                {vopts.fillDown && s.filledDown > 0 && ` ${s.filledDown} row(s) filled.`}
              </span>
            </span>
          </label>
        </Card>

        <Card className="space-y-4 p-5">
          <h3 className="font-semibold">Near misses</h3>
          <p className="-mt-2 text-sm opacity-70">
            A charge and a settlement that differ slightly are <b>proposed</b> only, never suggested. Each one needs your approval, and the difference always stays open as a residual line.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Tolerance (amount)" hint="e.g. bank charges, rounding">
              <MoneyInput cents={settings.toleranceAmount} precision={p} onChange={(c) => setSettings({ toleranceAmount: c })} />
            </Field>
            <Field label="Tolerance (% of charge)" hint="0 = off">
              <NumberInput value={settings.tolerancePercent} step={0.1} onChange={(v) => setSettings({ tolerancePercent: Math.max(0, v) })} />
            </Field>
            <Field label="Withholding / discount rates (%)" hint="A difference equal to one of these is proposed even above the tolerance.">
              <RatesInput rates={settings.withholdingRates} onChange={(r) => setSettings({ withholdingRates: r })} />
            </Field>
            <Field label="VAT included in invoices (%)" hint="Rates are also tested on the pre-VAT amount. 0 = off.">
              <NumberInput value={settings.vatRate} step={1} onChange={(v) => setSettings({ vatRate: Math.max(0, v) })} />
            </Field>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" disabled={kind === 'gl'} checked={settings.balanceForward && kind !== 'gl'} onChange={(e) => setSettings({ balanceForward: e.target.checked })} />
            <span>
              <b>Offer balance-forward (FIFO) allocation</b>
              <span className="block opacity-70">
                {kind === 'gl'
                  ? 'Not used for GL accounts.'
                  : 'For contacts kept on balance-forward: apply leftover payments to the oldest invoices. Always needs individual approval.'}
              </span>
            </span>
          </label>
          <details className="text-sm">
            <summary className="cursor-pointer font-medium">Search limits</summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <Field label="Max lines per combination">
                <NumberInput value={settings.maxComboSize} step={1} onChange={(v) => setSettings({ maxComboSize: Math.min(12, Math.max(2, Math.round(v))) })} />
              </Field>
              <Field label="Time per search (ms)">
                <NumberInput value={settings.perTargetBudgetMs} step={100} onChange={(v) => setSettings({ perTargetBudgetMs: Math.max(50, Math.round(v)) })} />
              </Field>
              <Field label="Total time (s)">
                <NumberInput value={settings.totalComboBudgetMs / 1000} step={10} onChange={(v) => setSettings({ totalComboBudgetMs: Math.max(5, Math.round(v)) * 1000 })} />
              </Field>
            </div>
          </details>
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" onClick={run} disabled={running || rows.length === 0}>
          {running ? 'Cleaning…' : `Clean ${rows.length.toLocaleString()} lines →`}
        </Button>
        {running && progress && (
          <div className="flex min-w-64 items-center gap-2 text-sm">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
              <div className="h-full bg-indigo-600 transition-all" style={{ width: `${(progress.contactsDone / Math.max(1, progress.contactsTotal)) * 100}%` }} />
            </div>
            <span className="tabular-nums opacity-70">
              {progress.contactsDone}/{progress.contactsTotal} contacts
            </span>
          </div>
        )}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}

const LEDGERS: { kind: LedgerKind; title: string; body: ReactNode }[] = [
  {
    kind: 'receivables',
    title: 'Receivables (customers)',
    body: (
      <>
        Invoices <b>positive (+)</b>, receipts and credit notes negative.
      </>
    ),
  },
  {
    kind: 'payables',
    title: 'Payables (suppliers)',
    body: (
      <>
        Invoices <b>negative (−)</b>, payments and debit notes positive.
      </>
    ),
  },
  {
    kind: 'gl',
    title: 'GL account',
    body: (
      <>
        Accruals, clearing, suspense or expense. <b>Debits +, credits −.</b> Matches postings to their reversals.
      </>
    ),
  },
];

const SEV: Record<ValidationIssue['severity'], { tone: 'bad' | 'warn' | 'info'; label: string }> = {
  error: { tone: 'bad', label: 'Error' },
  warning: { tone: 'warn', label: 'Warning' },
  info: { tone: 'info', label: 'Info' },
};

function IssueList({ issues }: { issues: ValidationIssue[] }) {
  const order = { error: 0, warning: 1, info: 2 };
  const sorted = [...issues].sort((a, b) => order[a.severity] - order[b.severity]);
  return (
    <Card className="divide-y divide-black/5 dark:divide-white/5">
      {sorted.map((iss, i) => (
        <div key={i} className="flex gap-3 px-4 py-2.5 text-sm">
          <div className="w-16 shrink-0 pt-0.5">
            <Badge tone={SEV[iss.severity].tone}>{SEV[iss.severity].label}</Badge>
          </div>
          <div className="min-w-0">
            <div>{iss.title}</div>
            {iss.detail && <div className="opacity-70">{iss.detail}</div>}
            {iss.rows && iss.rows.length > 0 && (
              <div className="mt-0.5 truncate text-xs opacity-60">
                Rows {iss.rows.slice(0, 30).join(', ')}
                {iss.rows.length > 30 && ` … +${iss.rows.length - 30} more`}
              </div>
            )}
          </div>
        </div>
      ))}
    </Card>
  );
}

/** Text input that edits a draft and commits on blur (no state syncing effects). */
function DraftInput({ shown, commit }: { shown: string; commit: (text: string) => boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      className={inputClass}
      inputMode="decimal"
      value={draft ?? shown}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null) commit(draft);
        setDraft(null);
      }}
    />
  );
}

function NumberInput({ value, onChange }: { value: number; onChange: (v: number) => void; step?: number }) {
  return (
    <DraftInput
      shown={String(value)}
      commit={(t) => {
        const n = Number(t);
        if (!Number.isFinite(n) || t.trim() === '') return false;
        onChange(n);
        return true;
      }}
    />
  );
}

function MoneyInput({ cents, precision, onChange }: { cents: number; precision: number; onChange: (c: number) => void }) {
  return (
    <DraftInput
      shown={formatCents(cents, precision).replace(/,/g, '')}
      commit={(t) => {
        const a = parseAmount(t, precision);
        if (!a || a.cents < 0) return false;
        onChange(a.cents);
        return true;
      }}
    />
  );
}

function RatesInput({ rates, onChange }: { rates: number[]; onChange: (r: number[]) => void }) {
  return (
    <DraftInput
      shown={rates.join(', ')}
      commit={(t) => {
        const r = t
          .split(/[,;\s]+/)
          .map(Number)
          .filter((n) => Number.isFinite(n) && n > 0 && n < 100);
        onChange([...new Set(r)].sort((a, b) => a - b));
        return true;
      }}
    />
  );
}
