'use client';
import { useEffect, useMemo, useState } from 'react';
import { buildEntries } from '@/lib/parse';
import {
  TEMPLATE_FIELDS,
  guessMapping,
  loadTemplates,
  matchTemplate,
  saveTemplate,
  type ColumnMapping,
  type SavedTemplate,
} from '@/lib/template';
import { useStore } from '@/lib/store';

const sampleOf = (rows: unknown[][], col: number): string => {
  if (col < 0) return '';
  for (const r of rows) {
    const v = r[col];
    if (v === null || v === undefined || v === '') continue;
    const s = v instanceof Date ? v.toLocaleDateString() : String(v);
    return s.length > 28 ? s.slice(0, 27) + '…' : s;
  }
  return '';
};

export default function MapStep() {
  const workbook = useStore((s) => s.workbook);
  const sheetIndex = useStore((s) => s.sheetIndex);
  const mapping = useStore((s) => s.mapping);
  const setMapping = useStore((s) => s.setMapping);
  const setEntries = useStore((s) => s.setEntries);
  const setStep = useStore((s) => s.setStep);

  const sheet = workbook?.sheets[sheetIndex];
  const [templates, setTemplates] = useState<SavedTemplate[]>([]);
  const [templateName, setTemplateName] = useState('');
  const [autoNote, setAutoNote] = useState<string | null>(null);

  useEffect(() => {
    setTemplates(loadTemplates());
  }, []);

  // Auto-map on first arrival: saved template (exact header match) wins, else guess.
  useEffect(() => {
    if (!sheet) return;
    if (mapping.amount !== -1) return; // already mapped
    const saved = matchTemplate(sheet.headers);
    if (saved) {
      setMapping(saved.mapping);
      setAutoNote(`Applied saved template "${saved.name}" (headers matched exactly).`);
    } else {
      setMapping(guessMapping(sheet.headers));
      setAutoNote('Columns guessed from header names — verify below.');
    }
  }, [sheet, mapping.amount, setMapping]);

  const preview = useMemo(() => {
    if (!sheet || mapping.amount < 0) return null;
    return buildEntries(sheet.rows, mapping);
  }, [sheet, mapping]);

  const mappedCount = useMemo(
    () => TEMPLATE_FIELDS.filter((f) => mapping[f.field] >= 0).length,
    [mapping],
  );

  if (!sheet) return <p>No file loaded.</p>;

  const setField = (field: keyof ColumnMapping, col: number) => {
    const next = { ...mapping };
    // A column can serve only one field.
    for (const f of Object.keys(next) as (keyof ColumnMapping)[]) {
      if (next[f] === col && f !== field) next[f] = -1;
    }
    next[field] = col;
    setMapping(next);
  };

  const proceed = () => {
    if (!preview) return;
    setEntries(preview.entries, preview.skippedRows, preview.accounts);
    setStep('configure');
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold tracking-tight">Map onto the GL header</h2>
        <p className="mt-1 text-sm opacity-70">
          The matcher reads a fixed set of GL columns. Line up each one with a column from your file
          — <b>Amount</b> is required; every other field you map sharpens the confidence scoring.
        </p>
      </div>

      {autoNote && (
        <p className="rounded-lg bg-indigo-500/10 px-4 py-2 text-sm text-indigo-700 dark:text-indigo-300">
          {autoNote}
        </p>
      )}

      {/* Fixed GL header ↔ source column mapping */}
      <div className="overflow-hidden rounded-xl border border-black/10 dark:border-white/10">
        <table className="w-full text-left text-sm">
          <thead className="bg-black/[0.03] text-xs uppercase tracking-wide opacity-60 dark:bg-white/[0.04]">
            <tr>
              <th className="px-4 py-2 font-semibold">GL field</th>
              <th className="px-4 py-2 font-semibold">Your column</th>
              <th className="px-4 py-2 font-semibold">Sample value</th>
            </tr>
          </thead>
          <tbody>
            {TEMPLATE_FIELDS.map((spec, i) => {
              const col = mapping[spec.field];
              const unmappedRequired = spec.required && col < 0;
              return (
                <tr
                  key={spec.field}
                  className="border-t border-black/5 dark:border-white/5"
                >
                  <td className="px-4 py-2.5">
                    <span className="flex items-center gap-2">
                      <span className="grid h-5 w-5 place-items-center rounded bg-black/5 text-[10px] font-semibold opacity-60 dark:bg-white/10">
                        {i + 1}
                      </span>
                      <span className="font-medium">{spec.label}</span>
                      {spec.required && (
                        <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-red-600 dark:text-red-400">
                          required
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <select
                      value={col}
                      onChange={(e) => setField(spec.field, Number(e.target.value))}
                      className={`w-full max-w-xs rounded-md border bg-transparent px-2 py-1.5 dark:bg-zinc-900 ${
                        unmappedRequired
                          ? 'border-red-500/60'
                          : col >= 0
                            ? 'border-emerald-500/40'
                            : 'border-black/15 dark:border-white/20'
                      }`}
                    >
                      <option value={-1}>— not mapped —</option>
                      {sheet.headers.map((h, j) => (
                        <option key={j} value={j}>
                          {h || `(col ${j + 1})`}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs opacity-60">
                    {col >= 0 ? sampleOf(sheet.rows, col) || <span className="opacity-40">(empty)</span> : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="flex items-center justify-between border-t border-black/5 bg-black/[0.02] px-4 py-2 text-xs opacity-70 dark:border-white/5 dark:bg-white/[0.02]">
          <span>
            {mappedCount}/{TEMPLATE_FIELDS.length} GL fields mapped
          </span>
          {mapping.amount < 0 && <span className="text-red-500">Map the Amount column to continue.</span>}
        </div>
      </div>

      {/* Reusable templates */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-black/10 p-4 dark:border-white/10">
        <span className="text-sm font-medium opacity-70">Reuse this mapping:</span>
        <input
          value={templateName}
          onChange={(e) => setTemplateName(e.target.value)}
          placeholder="Template name (e.g. Oracle GL export)"
          className="w-60 rounded-md border border-black/15 bg-transparent px-3 py-1.5 text-sm dark:border-white/20 dark:bg-zinc-900"
        />
        <button
          disabled={!templateName.trim()}
          onClick={() => {
            saveTemplate({
              name: templateName.trim(),
              headers: sheet.headers,
              mapping,
              savedAt: new Date().toISOString(),
            });
            setTemplates(loadTemplates());
            setTemplateName('');
          }}
          className="rounded-md bg-black/10 px-3 py-1.5 text-sm font-medium hover:bg-black/15 disabled:opacity-40 dark:bg-white/10 dark:hover:bg-white/15"
        >
          Save as template
        </button>
        {templates.length > 0 && (
          <select
            defaultValue=""
            onChange={(e) => {
              const t = templates.find((x) => x.name === e.target.value);
              if (t) {
                setMapping(t.mapping);
                setAutoNote(`Applied template "${t.name}".`);
              }
            }}
            className="rounded-md border border-black/15 bg-transparent px-2 py-1.5 text-sm dark:border-white/20 dark:bg-zinc-900"
          >
            <option value="" disabled>
              Apply saved template…
            </option>
            {templates.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {preview && (
        <div className="sticky bottom-0 flex flex-wrap items-center gap-4 rounded-xl border border-black/10 bg-white/90 p-4 text-sm backdrop-blur dark:border-white/10 dark:bg-zinc-950/90">
          <span>
            <b>{preview.entries.length}</b> rows parsed
          </span>
          <span>
            <b>{preview.accounts.length}</b> account{preview.accounts.length === 1 ? '' : 's'} detected
          </span>
          {preview.skippedRows.length > 0 && (
            <span className="text-amber-600 dark:text-amber-400">
              {preview.skippedRows.length} rows skipped (no valid amount) — first at data row{' '}
              {preview.skippedRows[0] + 1}
            </span>
          )}
          <button
            onClick={proceed}
            disabled={preview.entries.length === 0}
            className="ml-auto rounded-lg bg-indigo-600 px-5 py-2 font-semibold text-white hover:bg-indigo-500 disabled:opacity-40"
          >
            Continue → Configure
          </button>
        </div>
      )}
    </div>
  );
}
