'use client';
import { STEP_ORDER, useStore, type WizardStep } from '@/lib/store';
import UploadStep from '@/components/steps/UploadStep';
import MapStep from '@/components/steps/MapStep';
import ConfigureStep from '@/components/steps/ConfigureStep';
import ReviewStep from '@/components/steps/ReviewStep';
import ExportStep from '@/components/steps/ExportStep';

const STEP_LABELS: Record<WizardStep, string> = {
  upload: 'Upload',
  map: 'Map Columns',
  configure: 'Configure & Run',
  review: 'Review Matches',
  export: 'Export',
};

export default function Home() {
  const step = useStore((s) => s.step);
  const setStep = useStore((s) => s.setStep);
  const workbook = useStore((s) => s.workbook);
  const entries = useStore((s) => s.entries);
  const runs = useStore((s) => s.runs);
  const approved = useStore((s) => s.approved);
  const reset = useStore((s) => s.reset);

  const reachable = (target: WizardStep): boolean => {
    switch (target) {
      case 'upload':
        return true;
      case 'map':
        return workbook !== null;
      case 'configure':
        return entries.length > 0;
      case 'review':
      case 'export':
        return runs.length > 0;
    }
  };

  // A step is "done" once you've produced what it exists to produce.
  const done: Record<WizardStep, boolean> = {
    upload: workbook !== null,
    map: entries.length > 0,
    configure: runs.length > 0,
    review: approved.size > 0,
    export: false,
  };

  const activeIndex = STEP_ORDER.indexOf(step);

  return (
    <div className="flex w-full flex-1 flex-col">
      <header className="sticky top-0 z-20 border-b border-black/10 bg-white/80 backdrop-blur dark:border-white/10 dark:bg-zinc-950/80">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-indigo-600 text-sm font-bold text-white">
              GL
            </span>
            <h1 className="text-lg font-bold tracking-tight">GL Cleaner</h1>
          </div>
          <span className="hidden items-center gap-1.5 rounded-full bg-emerald-600/10 px-2.5 py-1 text-xs font-medium text-emerald-700 sm:inline-flex dark:text-emerald-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            100% in-browser — data never leaves this machine
          </span>
          {workbook && (
            <button
              onClick={reset}
              className="ml-auto rounded-md px-2.5 py-1 text-xs font-medium text-black/60 hover:bg-black/5 dark:text-white/60 dark:hover:bg-white/10"
            >
              Start over
            </button>
          )}
        </div>

        {/* Stepper */}
        <nav className="mx-auto w-full max-w-6xl px-4 pb-3">
          <ol className="flex items-center">
            {STEP_ORDER.map((s, i) => {
              const active = s === step;
              const enabled = reachable(s);
              const isDone = done[s] && !active;
              return (
                <li key={s} className="flex flex-1 items-center last:flex-none">
                  <button
                    onClick={() => enabled && setStep(s)}
                    disabled={!enabled}
                    aria-current={active ? 'step' : undefined}
                    className={`group flex items-center gap-2 rounded-lg px-2 py-1.5 transition ${
                      enabled ? 'cursor-pointer hover:bg-black/5 dark:hover:bg-white/5' : 'cursor-not-allowed'
                    }`}
                  >
                    <span
                      className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold transition ${
                        active
                          ? 'bg-indigo-600 text-white'
                          : isDone
                            ? 'bg-emerald-600 text-white'
                            : enabled
                              ? 'bg-black/10 text-black/70 dark:bg-white/15 dark:text-white/70'
                              : 'bg-black/5 text-black/30 dark:bg-white/5 dark:text-white/25'
                      }`}
                    >
                      {isDone ? '✓' : i + 1}
                    </span>
                    <span
                      className={`hidden whitespace-nowrap text-sm sm:inline ${
                        active
                          ? 'font-semibold text-indigo-700 dark:text-indigo-300'
                          : enabled
                            ? 'font-medium'
                            : 'opacity-40'
                      }`}
                    >
                      {STEP_LABELS[s]}
                    </span>
                  </button>
                  {i < STEP_ORDER.length - 1 && (
                    <span
                      className={`mx-1 h-px flex-1 ${
                        i < activeIndex ? 'bg-emerald-500/50' : 'bg-black/10 dark:bg-white/10'
                      }`}
                    />
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        {step === 'upload' && <UploadStep />}
        {step === 'map' && <MapStep />}
        {step === 'configure' && <ConfigureStep />}
        {step === 'review' && <ReviewStep />}
        {step === 'export' && <ExportStep />}
      </main>
    </div>
  );
}
