'use client';
import { useCallback, useState } from 'react';
import { parseFile } from '@/lib/parse';
import { useStore } from '@/lib/store';

export default function UploadStep() {
  const setWorkbook = useStore((s) => s.setWorkbook);
  const setStep = useStore((s) => s.setStep);
  const workbook = useStore((s) => s.workbook);
  const sheetIndex = useStore((s) => s.sheetIndex);
  const setSheetIndex = useStore((s) => s.setSheetIndex);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      setBusy(true);
      try {
        const wb = await parseFile(file);
        if (!wb.sheets.some((s) => s.rows.length > 0)) {
          setError('No data rows found in this file.');
          return;
        }
        setWorkbook(wb);
      } catch (e) {
        setError(`Could not read file: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [setWorkbook],
  );

  const sheet = workbook?.sheets[sheetIndex];

  return (
    <div className="space-y-6">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files[0];
          if (f) void handleFile(f);
        }}
        className={`flex flex-col items-center justify-center rounded-2xl border-2 border-dashed p-12 text-center transition ${
          dragging
            ? 'border-indigo-500 bg-indigo-500/5'
            : 'border-black/15 dark:border-white/20'
        }`}
      >
        <p className="text-lg font-medium">Drop your GL file here</p>
        <p className="mt-1 text-sm opacity-60">.xlsx or .csv — parsed locally, never uploaded</p>
        <label className="mt-4 cursor-pointer rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500">
          {busy ? 'Reading…' : 'Choose file'}
          <input
            type="file"
            accept=".xlsx,.xls,.csv,.tsv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
              e.target.value = '';
            }}
          />
        </label>
        {error && <p className="mt-3 text-sm text-red-500">{error}</p>}
      </div>

      {workbook && sheet && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-medium">{workbook.fileName}</span>
            {workbook.sheets.length > 1 && (
              <select
                value={sheetIndex}
                onChange={(e) => setSheetIndex(Number(e.target.value))}
                className="rounded-md border border-black/15 bg-transparent px-2 py-1 text-sm dark:border-white/20 dark:bg-zinc-900"
              >
                {workbook.sheets.map((s, i) => (
                  <option key={s.sheetName} value={i}>
                    {s.sheetName} ({s.rows.length} rows)
                  </option>
                ))}
              </select>
            )}
            <span className="text-sm opacity-60">{sheet.rows.length} data rows</span>
            <button
              onClick={() => setStep('map')}
              className="ml-auto rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
            >
              Continue → Map Columns
            </button>
          </div>

          <div className="overflow-auto rounded-xl border border-black/10 dark:border-white/10">
            <table className="w-full text-left text-sm">
              <thead className="bg-black/5 dark:bg-white/5">
                <tr>
                  {sheet.headers.map((h, i) => (
                    <th key={i} className="whitespace-nowrap px-3 py-2 font-semibold">
                      {h || <span className="opacity-40">(col {i + 1})</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sheet.rows.slice(0, 15).map((r, i) => (
                  <tr key={i} className="border-t border-black/5 dark:border-white/5">
                    {sheet.headers.map((_, j) => (
                      <td key={j} className="whitespace-nowrap px-3 py-1.5 opacity-80">
                        {r[j] instanceof Date
                          ? (r[j] as Date).toLocaleDateString()
                          : String(r[j] ?? '')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
