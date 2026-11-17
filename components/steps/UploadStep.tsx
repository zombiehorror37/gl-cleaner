'use client';
import { useCallback, useState } from 'react';
import { readWorkbook } from '@/lib/parse/read';
import { buildTemplateWorkbook } from '@/lib/export';
import { TEMPLATE } from '@/lib/template';
import { useStore } from '@/lib/store';
import { Button, Card, cx, downloadBuffer } from '@/components/ui';

export default function UploadStep() {
  const loadWorkbook = useStore((s) => s.loadWorkbook);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  const open = useCallback(
    async (name: string, data: ArrayBuffer) => {
      setError(null);
      setBusy(true);
      // Let the "Reading…" state paint before the synchronous parse.
      await new Promise((r) => setTimeout(r, 20));
      try {
        const wb = readWorkbook(data, name);
        if (!wb.sheets.length || wb.sheets.every((s) => s.matrix.length === 0)) {
          setError('This file has no data.');
          return;
        }
        loadWorkbook(wb);
      } catch (e) {
        setError(`Could not read the file: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [loadWorkbook],
  );

  const onFile = (f: File) => void f.arrayBuffer().then((b) => open(f.name, b));

  const trySample = async () => {
    const res = await fetch('/sample-ledger.xlsx');
    await open('sample-ledger.xlsx', await res.arrayBuffer());
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
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
          if (f) onFile(f);
        }}
        className={cx(
          'flex min-h-72 flex-col items-center justify-center rounded-2xl border-2 border-dashed p-10 text-center transition',
          dragging ? 'border-indigo-500 bg-indigo-500/5' : 'border-black/15 dark:border-white/20',
        )}
      >
        <p className="text-lg font-semibold">Drop your ledger here</p>
        <p className="mt-1 text-sm opacity-60">.xlsx, .xls or .csv in the GL template. Read in your browser, never uploaded.</p>
        <label className="mt-5 cursor-pointer rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500">
          {busy ? 'Reading…' : 'Choose file'}
          <input
            type="file"
            accept=".xlsx,.xlsm,.xls,.csv,.tsv,.txt"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onFile(f);
              e.target.value = '';
            }}
          />
        </label>
        <button onClick={trySample} className="mt-3 text-sm text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-400">
          or try it with a messy sample ledger
        </button>
        {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
      </div>

      <Card className="p-5">
        <h2 className="font-semibold">GL template</h2>
        <p className="mt-1 text-sm opacity-70">The file must have exactly these columns, in this order. * = mandatory.</p>
        <ol className="mt-3 space-y-1.5 text-sm">
          {TEMPLATE.map((f, i) => (
            <li key={f.key} className="flex items-center gap-2">
              <span className="w-5 text-right text-xs tabular-nums opacity-40">{i + 1}</span>
              <span className={cx('rounded-md px-2 py-0.5', f.required ? 'bg-indigo-600/10 font-medium text-indigo-800 dark:text-indigo-300' : 'bg-black/5 dark:bg-white/10')}>
                {f.label}
                {f.required && <span className="text-red-500">*</span>}
              </span>
            </li>
          ))}
        </ol>
        <p className="mt-3 text-xs opacity-60">
          Title rows above the header, repeated headers, blank rows and total lines are fine. They are detected and skipped.
        </p>
        <div className="mt-4">
          <Button onClick={async () => downloadBuffer(await buildTemplateWorkbook(), 'GL-template.xlsx')}>Download blank template</Button>
        </div>
      </Card>
    </div>
  );
}
