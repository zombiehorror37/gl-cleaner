/// <reference lib="webworker" />
import { cleanLedger } from './clean';
import type { CleanProgress, CleanResult, CleanSettings, LedgerRow } from './types';

export interface WorkerJob {
  rows: LedgerRow[];
  settings: CleanSettings;
}

export type WorkerReply =
  | { type: 'progress'; progress: CleanProgress }
  | { type: 'done'; result: CleanResult }
  | { type: 'error'; message: string };

self.onmessage = (ev: MessageEvent<WorkerJob>) => {
  const post = (m: WorkerReply) => (self as unknown as Worker).postMessage(m);
  try {
    let last = 0;
    const result = cleanLedger(ev.data.rows, ev.data.settings, (progress) => {
      const now = Date.now();
      if (now - last < 80 && progress.contactsDone < progress.contactsTotal) return;
      last = now;
      post({ type: 'progress', progress });
    });
    post({ type: 'done', result });
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
