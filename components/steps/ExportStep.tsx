'use client';
import { useMemo, useState } from 'react';
import { useStore } from '@/lib/store';
import { applyDecisions } from '@/lib/engine/apply';
import { buildWorkbook } from '@/lib/export';
import { formatCents } from '@/lib/parse/values';
import { Button, Card, cx, downloadBuffer } from '@/components/ui';

const SHEETS: [string, string][] = [
  ['Open Items', 'The cleaned ledger in the forced template: untouched open lines plus residual lines for part-settled documents. Ready to re-import.'],
  ['Detail', 'Every valid line in source order with its status (Open / Cleared / Part-settled), match id, match type, confidence and the reasons.'],
  ['Matches', 'One row per approved match: lines, transaction ids, what was kept open, and why.'],
  ['Exceptions', 'Duplicates, wrong-contact postings, sign problems, unapplied cash, ambiguous matches.'],
  ['Rejected Rows', 'Rows excluded from cleaning (missing mandatory fields, unreadable Net, totals, headings) with the reason.'],
  ['Contact Summary', 'Per contact: original balance, cleared / open lines, open balance, with live Excel checks.'],
  ['Summary', 'Settings used, counts, totals and the integrity checks (live formulas).'],
];

export default function ExportStep() {
  const workbook = useStore((s) => s.workbook)!;
  const sheetIndex = useStore((s) => s.sheetIndex);
  const validation = useStore((s) => s.validation)!;
  const result = useStore((s) => s.result)!;
  const approved = useStore((s) => s.approved);
  const setStep = useStore((s) => s.setStep);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const p = result.settings.precision;
  const fmt = (c: number) => formatCents(c, p);
  const outcome = useMemo(() => applyDecisions(validation.rows, result.groups, approved, p), [validation.rows, result.groups, approved, p]);
  const t = outcome.totals;
  const pendingSuggested = result.groups.filter((g) => g.suggested && !approved.has(g.id)).length;

  const download = async () => {
    setError(null);
    setBusy(true);
    try {
      const buf = await buildWorkbook({
        fileName: workbook.fileName,
        sheetName: workbook.sheets[sheetIndex].name,
        rows: validation.rows,
        rejected: validation.rejected,
        result,
        approvedIds: approved,
        dateOrder: validation.dateOrderUsed,
      });
      downloadBuffer(buf, `${workbook.fileName.replace(/\.[^.]+$/, '')}-cleaned.xlsx`);
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const checks: [string, boolean, string][] = [
    ['No line is in two approved matches', !outcome.errors.some((e) => e.includes('two approved')), ''],
    ['Every match nets to zero or keeps its remainder open', !outcome.errors.some((e) => e.includes('sum') || e.includes('residual')), `${t.residualLines} residual line(s)`],
    ['Open balance equals the original balance', t.openNet === t.originalNet, `${fmt(t.openNet)} = ${fmt(t.originalNet)}`],
  ];

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_24rem]">
      <Card className="p-5">
        <h2 className="text-lg font-semibold">Ready to export</h2>
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-3">
          <Item k="Approved matches" v={outcome.approved.length} />
          <Item k="Lines cleared" v={`${t.clearedRows} of ${t.originalRows}`} />
          <Item k="Open items" v={t.openRows} />
          <Item k="Original balance" v={fmt(t.originalNet)} />
          <Item k="Open balance" v={fmt(t.openNet)} />
          <Item k="Rejected rows" v={validation.rejected.filter((r) => r.kind === 'invalid').length} />
        </dl>

        <h3 className="mt-5 text-sm font-semibold">Integrity checks</h3>
        <ul className="mt-2 space-y-1 text-sm">
          {checks.map(([label, ok, detail]) => (
            <li key={label} className="flex items-center gap-2">
              <span className={cx('grid h-5 w-5 place-items-center rounded-full text-xs font-bold text-white', ok ? 'bg-emerald-600' : 'bg-red-600')}>{ok ? '✓' : '✗'}</span>
              <span>{label}</span>
              {detail && <span className="opacity-60">({detail})</span>}
            </li>
          ))}
        </ul>
        {outcome.errors.length > 0 && <pre className="mt-3 whitespace-pre-wrap rounded bg-red-500/10 p-2 text-xs text-red-700">{outcome.errors.join('\n')}</pre>}
        {pendingSuggested > 0 && (
          <p className="mt-4 rounded-lg bg-amber-500/10 px-3 py-2 text-sm">
            {pendingSuggested} suggested match(es) are not approved. Their lines stay in Open Items.{' '}
            <button className="font-medium underline" onClick={() => setStep('review')}>
              Back to review
            </button>
          </p>
        )}

        <div className="mt-5 flex items-center gap-3">
          <Button variant="primary" onClick={download} disabled={busy || outcome.errors.length > 0}>
            {busy ? 'Building…' : 'Download cleaned workbook (.xlsx)'}
          </Button>
          {done && <span className="text-sm text-emerald-600 dark:text-emerald-400">Downloaded ✓</span>}
          {error && <span className="text-sm text-red-600">{error}</span>}
        </div>
      </Card>

      <Card className="p-5">
        <h3 className="font-semibold">What&apos;s in the workbook</h3>
        <dl className="mt-2 space-y-2 text-sm">
          {SHEETS.map(([name, desc]) => (
            <div key={name}>
              <dt className="font-medium">{name}</dt>
              <dd className="opacity-70">{desc}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  );
}

function Item({ k, v }: { k: string; v: string | number }) {
  return (
    <div>
      <dt className="text-xs opacity-60">{k}</dt>
      <dd className="font-medium tabular-nums">{v}</dd>
    </div>
  );
}
