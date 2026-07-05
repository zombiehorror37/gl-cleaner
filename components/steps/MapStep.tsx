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
    <div className="space-y-6">
      {autoNote && (
        <p className="rounded-lg bg-indigo-500/10 px-4 py-2 text-sm text-indigo-700 dark:text-indigo-300">
          {autoNote}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {TEMPLATE_FIELDS.map((spec) => (
          <label key={spec.field} className="flex flex-col gap-1 text-sm">
            <span className="font-medium">
              {spec.label}
              {spec.required && <span className="text-red-500"> *</span>}
            </span>
            <select
              value={mapping[spec.field]}
              onChange={(e) => setField(spec.field, Number(e.target.value))}
              className="rounded-md border border-black/15 bg-transparent px-2 py-1.5 dark:border-white/20 dark:bg-zinc-900"
            >
              <option value={-1}>— not mapped —</option>
              {sheet.headers.map((h, i) => (
                <option key={i} value={i}>
                  {h || `(col ${i + 1})`}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-black/10 p-4 dark:border-white/10">
        <input
          value={templateName}
          onChange={(e) => setTemplateName(e.target.value)}
          placeholder="Template name (e.g. Oracle GL export)"
          className="w-64 rounded-md border border-black/15 bg-transparent px-3 py-1.5 text-sm dark:border-white/20 dark:bg-zinc-900"
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
        <div className="flex flex-wrap items-center gap-4 rounded-xl border border-black/10 p-4 text-sm dark:border-white/10">
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
      {mapping.amount < 0 && (
        <p className="text-sm text-red-500">Map the Amount column to continue.</p>
      )}
    </div>
  );
}
