'use client';
import { useMemo, useState } from 'react';
import { buildWorkbook } from '@/lib/export';
import { fromCents } from '@/lib/engine/cents';
import { reconcile, verifyApproved } from '@/lib/engine/verify';
import { groupEntryIds } from '@/lib/engine/types';
import { allGroups, useStore } from '@/lib/store';

export default function ExportStep() {
  const workbook = useStore((s) => s.workbook);
  const sheetIndex = useStore((s) => s.sheetIndex);
  const entries = useStore((s) => s.entries);
  const runs = useStore((s) => s.runs);
  const approved = useStore((s) => s.approved);
  const [error, setError] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState(false);

  const approvedGroups = useMemo(
    () => allGroups(runs).filter((g) => approved.has(g.id)),
    [runs, approved],
  );
  const entryMap = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);
  const check = useMemo(() => verifyApproved(approvedGroups, entryMap), [approvedGroups, entryMap]);
  const removedIds = useMemo(
    () => new Set(approvedGroups.flatMap((g) => groupEntryIds(g))),
    [approvedGroups],
  );
  const totals = useMemo(() => reconcile(entries, removedIds), [entries, removedIds]);

  const download = async () => {
    if (!workbook) return;
    setError(null);
    try {
      const blob = await buildWorkbook({
        fileName: workbook.fileName,
        headers: workbook.sheets[sheetIndex].headers,
        entries,
        approvedGroups,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = workbook.fileName.replace(/\.[^.]+$/, '') + '-cleaned.xlsx';
      a.click();
      URL.revokeObjectURL(url);
      setDownloaded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const Row = ({ label, value, mono = false, ok }: { label: string; value: string | number; mono?: boolean; ok?: boolean }) => (
    <div className="flex justify-between gap-8 border-b border-black/5 py-2 text-sm last:border-0 dark:border-white/5">
      <span className="opacity-70">{label}</span>
      <span className={`${mono ? 'font-mono' : ''} font-medium ${ok === true ? 'text-emerald-600 dark:text-emerald-400' : ok === false ? 'text-red-500' : ''}`}>
        {value}
      </span>
    </div>
  );

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="rounded-xl border border-black/10 p-6 dark:border-white/10">
        <h2 className="mb-4 text-lg font-semibold">Pre-export integrity check</h2>
        <Row label="Approved groups" value={approvedGroups.length} />
        <Row label="Rows to remove" value={totals.removedRows} />
        <Row label="Rows remaining" value={totals.cleanedRows} />
        <Row label="Original total" value={fromCents(totals.originalTotal)} mono />
        <Row
          label="Removed total (must be 0.00)"
          value={fromCents(totals.removedTotal)}
          mono
          ok={totals.removedTotal === 0}
        />
        <Row label="Cleaned total" value={fromCents(totals.cleanedTotal)} mono />
        <Row
          label="Every group sums to zero, no entry reused"
          value={check.ok ? 'PASSED' : 'FAILED'}
          ok={check.ok}
        />
        {!check.ok && (
          <pre className="mt-3 overflow-auto rounded bg-red-500/10 p-3 text-xs text-red-600">
            {check.errors.join('\n')}
          </pre>
        )}
      </div>

      <div className="flex items-center gap-4">
        <button
          onClick={() => void download()}
          disabled={!check.ok || approvedGroups.length === 0}
          className="rounded-lg bg-indigo-600 px-6 py-2.5 font-semibold text-white hover:bg-indigo-500 disabled:opacity-40"
        >
          Download cleaned workbook (.xlsx)
        </button>
        {downloaded && <span className="text-sm text-emerald-600 dark:text-emerald-400">Downloaded ✓</span>}
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
      <p className="text-xs opacity-50">
        The workbook contains three sheets: Cleaned GL (surviving rows, original columns), Removed
        Entries (with group ID, confidence and match reasons), and Summary (reconciliation). Your
        original file is never modified.
      </p>
    </div>
  );
}
