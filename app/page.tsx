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

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">
          GL Cleaner
          <span className="ml-3 rounded bg-emerald-600/10 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            100% in-browser — your data never leaves this machine
          </span>
        </h1>
        <nav className="mt-4 flex flex-wrap gap-1">
          {STEP_ORDER.map((s, i) => {
            const active = s === step;
            const enabled = reachable(s);
            return (
              <button
                key={s}
                onClick={() => enabled && setStep(s)}
                disabled={!enabled}
                className={`rounded-full px-4 py-1.5 text-sm transition ${
                  active
                    ? 'bg-indigo-600 font-semibold text-white'
                    : enabled
                      ? 'bg-black/5 hover:bg-black/10 dark:bg-white/10 dark:hover:bg-white/15'
                      : 'cursor-not-allowed bg-black/5 opacity-40 dark:bg-white/5'
                }`}
              >
                {i + 1}. {STEP_LABELS[s]}
              </button>
            );
          })}
        </nav>
      </header>
      <main className="flex-1">
        {step === 'upload' && <UploadStep />}
        {step === 'map' && <MapStep />}
        {step === 'configure' && <ConfigureStep />}
        {step === 'review' && <ReviewStep />}
        {step === 'export' && <ExportStep />}
      </main>
    </div>
  );
}
