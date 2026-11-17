'use client';
import { STEPS, STEP_LABEL, useStore, type Step } from '@/lib/store';
import UploadStep from '@/components/steps/UploadStep';
import CheckStep from '@/components/steps/CheckStep';
import ReviewStep from '@/components/steps/ReviewStep';
import ExportStep from '@/components/steps/ExportStep';
import { cx } from '@/components/ui';

export default function Home() {
  const step = useStore((s) => s.step);
  const setStep = useStore((s) => s.setStep);
  const workbook = useStore((s) => s.workbook);
  const validation = useStore((s) => s.validation);
  const result = useStore((s) => s.result);
  const approved = useStore((s) => s.approved);
  const reset = useStore((s) => s.reset);

  const reachable: Record<Step, boolean> = {
    upload: true,
    check: workbook !== null,
    review: result !== null,
    export: result !== null,
  };
  const done: Record<Step, boolean> = {
    upload: workbook !== null,
    check: !!validation?.headerOk && result !== null,
    review: approved.size > 0,
    export: false,
  };
  const active = STEPS.indexOf(step);

  return (
    <div className="flex w-full flex-1 flex-col">
      <header className="sticky top-0 z-20 border-b border-black/10 bg-white/80 backdrop-blur dark:border-white/10 dark:bg-zinc-950/80">
        <div className="mx-auto flex w-full max-w-7xl items-center gap-3 px-4 py-3">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-indigo-600 text-sm font-bold text-white">GL</span>
          <h1 className="text-lg font-bold tracking-tight">GL Cleaner</h1>
          <span className="hidden items-center gap-1.5 rounded-full bg-emerald-600/10 px-2.5 py-1 text-xs font-medium text-emerald-700 sm:inline-flex dark:text-emerald-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Runs in your browser. Data never leaves this machine.
          </span>
          {workbook && (
            <button onClick={reset} className="ml-auto rounded-md px-2.5 py-1 text-xs font-medium opacity-60 hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10">
              Start over
            </button>
          )}
        </div>
        <nav className="mx-auto w-full max-w-7xl px-4 pb-3">
          <ol className="flex items-center">
            {STEPS.map((s, i) => {
              const isActive = s === step;
              const enabled = reachable[s];
              const isDone = done[s] && !isActive;
              return (
                <li key={s} className="flex flex-1 items-center last:flex-none">
                  <button
                    onClick={() => enabled && setStep(s)}
                    disabled={!enabled}
                    aria-current={isActive ? 'step' : undefined}
                    className={cx('flex items-center gap-2 rounded-lg px-2 py-1.5 transition', enabled ? 'hover:bg-black/5 dark:hover:bg-white/5' : 'cursor-not-allowed')}
                  >
                    <span
                      className={cx(
                        'grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold',
                        isActive ? 'bg-indigo-600 text-white' : isDone ? 'bg-emerald-600 text-white' : enabled ? 'bg-black/10 dark:bg-white/15' : 'bg-black/5 opacity-40 dark:bg-white/5',
                      )}
                    >
                      {isDone ? '✓' : i + 1}
                    </span>
                    <span className={cx('hidden whitespace-nowrap text-sm sm:inline', isActive ? 'font-semibold text-indigo-700 dark:text-indigo-300' : enabled ? 'font-medium' : 'opacity-40')}>
                      {STEP_LABEL[s]}
                    </span>
                  </button>
                  {i < STEPS.length - 1 && <span className={cx('mx-1 h-px flex-1', i < active ? 'bg-emerald-500/50' : 'bg-black/10 dark:bg-white/10')} />}
                </li>
              );
            })}
          </ol>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
        {step === 'upload' && <UploadStep />}
        {step === 'check' && workbook && <CheckStep />}
        {step === 'review' && result && <ReviewStep />}
        {step === 'export' && result && <ExportStep />}
      </main>
    </div>
  );
}
