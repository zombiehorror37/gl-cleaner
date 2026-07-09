'use client';
import { useState } from 'react';
import { fromCents } from '@/lib/engine/cents';
import { runAccountParallel } from '@/lib/engine/pool';
import type { Nature } from '@/lib/engine/types';
import { useStore, type AccountRun } from '@/lib/store';

const NATURE_LABELS: Record<Nature, string> = {
  debit: 'Debit (positive natural — negatives are reversals)',
  credit: 'Credit (negative natural — positives are reversals)',
  suspense: 'Suspense / both (search both directions)',
};

export default function ConfigureStep() {
  const entries = useStore((s) => s.entries);
  const accounts = useStore((s) => s.accounts);
  const configs = useStore((s) => s.configs);
  const setConfig = useStore((s) => s.setConfig);
  const running = useStore((s) => s.running);
  const setRunning = useStore((s) => s.setRunning);
  const progress = useStore((s) => s.progress);
  const setProgress = useStore((s) => s.setProgress);
  const setRuns = useStore((s) => s.setRuns);
  const setStep = useStore((s) => s.setStep);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setError(null);
    setRunning(true);
    try {
      const runs: AccountRun[] = [];
      for (const account of accounts) {
        const acctEntries = entries.filter((e) => e.account === account);
        const result = await runAccountParallel(acctEntries, configs[account], (p) =>
          setProgress(p),
        );
        runs.push({ account, result });
      }
      setRuns(runs);
      setStep('review');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        {accounts.map((account) => {
          const cfg = configs[account];
          const acctEntries = entries.filter((e) => e.account === account);
          const pos = acctEntries.filter((e) => e.amount > 0);
          const neg = acctEntries.filter((e) => e.amount < 0);
          const total = acctEntries.reduce((s, e) => s + e.amount, 0);
          return (
            <div key={account} className="rounded-xl border border-black/10 p-4 dark:border-white/10">
              <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <h3 className="text-lg font-semibold">{account || '(single account)'}</h3>
                <span className="text-sm opacity-60">
                  {acctEntries.length} rows · {pos.length} positive / {neg.length} negative ·
                  balance {fromCents(total)}
                </span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium">Account nature</span>
                  <select
                    value={cfg.nature}
                    onChange={(e) => setConfig(account, { nature: e.target.value as Nature })}
                    className="rounded-md border border-black/15 bg-transparent px-2 py-1.5 dark:border-white/20 dark:bg-zinc-900"
                  >
                    {(Object.keys(NATURE_LABELS) as Nature[]).map((n) => (
                      <option key={n} value={n}>
                        {NATURE_LABELS[n]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium">Max entries per combination: {cfg.maxComboSize}</span>
                  <input
                    type="range"
                    min={2}
                    max={10}
                    value={cfg.maxComboSize}
                    onChange={(e) => setConfig(account, { maxComboSize: Number(e.target.value) })}
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium">
                    Time budget per target: {cfg.perTargetBudgetMs / 1000}s
                  </span>
                  <input
                    type="range"
                    min={1000}
                    max={120000}
                    step={1000}
                    value={cfg.perTargetBudgetMs}
                    onChange={(e) => setConfig(account, { perTargetBudgetMs: Number(e.target.value) })}
                  />
                </label>
                <div className="flex flex-col gap-2 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={cfg.dateWindowDays !== null}
                      onChange={(e) =>
                        setConfig(account, { dateWindowDays: e.target.checked ? 60 : null })
                      }
                    />
                    <span>
                      Date window{' '}
                      {cfg.dateWindowDays !== null && (
                        <input
                          type="number"
                          min={1}
                          value={cfg.dateWindowDays}
                          onChange={(e) =>
                            setConfig(account, { dateWindowDays: Math.max(1, Number(e.target.value)) })
                          }
                          className="w-16 rounded border border-black/15 bg-transparent px-1 py-0.5 dark:border-white/20"
                        />
                      )}{' '}
                      {cfg.dateWindowDays !== null && 'days'}
                    </span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={cfg.deepSearch}
                      onChange={(e) => setConfig(account, { deepSearch: e.target.checked })}
                    />
                    <span>Many-to-many search (budget-guarded, runs before netting)</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={cfg.globalNet}
                      onChange={(e) => setConfig(account, { globalNet: e.target.checked })}
                    />
                    <span>
                      Global netting sweep — clear{' '}
                      <select
                        value={cfg.netTargetSide}
                        onChange={(e) =>
                          setConfig(account, {
                            netTargetSide: e.target.value as 'auto' | 'negative' | 'positive',
                          })
                        }
                        className="rounded border border-black/15 bg-transparent px-1 py-0.5 dark:border-white/20 dark:bg-zinc-900"
                      >
                        <option value="auto">auto (by nature)</option>
                        <option value="negative">all negatives</option>
                        <option value="positive">all positives</option>
                      </select>
                    </span>
                  </label>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-4">
        <button
          onClick={() => void run()}
          disabled={running}
          className="rounded-lg bg-indigo-600 px-6 py-2.5 font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {running ? 'Searching…' : 'Run Matching Engine'}
        </button>
        {running && progress && (
          <div className="text-sm opacity-80">
            <span className="font-medium capitalize">{progress.phase}</span>
            {progress.round !== undefined && <span className="opacity-70"> · round {progress.round}</span>}
            {progress.phase === 'pass2' && (
              <>
                {' '}
                — target {progress.targetsDone}/{progress.targetsTotal} ·{' '}
                {progress.groupsFound} groups ·{' '}
                {progress.statesExplored.toLocaleString()} states explored
              </>
            )}
            {progress.account && <span className="opacity-60"> · account {progress.account}</span>}
          </div>
        )}
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>
    </div>
  );
}
