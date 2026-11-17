import { cleanLedger } from './clean';
import type { CleanProgress, CleanResult, CleanSettings, LedgerRow } from './types';
import type { WorkerJob, WorkerReply } from './worker';

/**
 * Run the cleaner off the main thread so the page stays responsive on large
 * ledgers. Falls back to running inline where Workers are unavailable.
 */
export function cleanInBackground(
  rows: LedgerRow[],
  settings: CleanSettings,
  onProgress?: (p: CleanProgress) => void,
  signal?: AbortSignal,
): Promise<CleanResult> {
  if (typeof Worker === 'undefined') return Promise.resolve(cleanLedger(rows, settings, onProgress));
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./worker.ts', import.meta.url));
    const stop = () => w.terminate();
    signal?.addEventListener('abort', () => {
      stop();
      reject(new DOMException('cancelled', 'AbortError'));
    });
    w.onmessage = (ev: MessageEvent<WorkerReply>) => {
      const m = ev.data;
      if (m.type === 'progress') onProgress?.(m.progress);
      else if (m.type === 'done') {
        stop();
        resolve(m.result);
      } else {
        stop();
        reject(new Error(m.message));
      }
    };
    w.onerror = (e) => {
      stop();
      reject(new Error(`Cleaner crashed: ${e.message}`));
    };
    const job: WorkerJob = { rows, settings };
    w.postMessage(job);
  });
}
