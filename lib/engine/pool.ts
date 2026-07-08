import { runAccount } from './run';
import type { CoordinatorJob, CoordinatorReply } from './coordinator';
import type { AccountConfig, EngineProgress, EngineResult, Entry } from './types';

/**
 * Main-thread entry point: hands the whole pipeline to the coordinator worker
 * (which fans pass-2 shards out to nested workers, one per core) and just
 * relays throttled progress. `raw` cell values are stripped from the payload —
 * the engine never reads them — cutting structured-clone cost and worker
 * memory; results reference entries by id so nothing needs rehydration.
 * Falls back to the synchronous engine when Workers are unavailable (SSR/tests).
 */
export async function runAccountParallel(
  entries: Entry[],
  config: AccountConfig,
  onProgress?: (p: EngineProgress) => void,
  signal?: AbortSignal,
): Promise<EngineResult> {
  if (typeof Worker === 'undefined') {
    return runAccount(entries, config, onProgress);
  }

  const wireEntries: Entry[] = entries.map((e) => ({ ...e, raw: [] }));

  return new Promise<EngineResult>((resolve, reject) => {
    const w = new Worker(new URL('./coordinator.ts', import.meta.url));
    const cleanup = () => w.terminate();
    signal?.addEventListener('abort', () => {
      cleanup();
      reject(new DOMException('cancelled', 'AbortError'));
    });
    w.onmessage = (ev: MessageEvent<CoordinatorReply>) => {
      const msg = ev.data;
      if (msg.type === 'progress') {
        onProgress?.(msg.progress);
      } else if (msg.type === 'done') {
        cleanup();
        resolve(msg.result);
      } else {
        cleanup();
        reject(new Error(msg.message));
      }
    };
    w.onerror = (e) => {
      cleanup();
      reject(new Error(`coordinator error: ${e.message}`));
    };
    const job: CoordinatorJob = { entries: wireEntries, config };
    w.postMessage(job);
  });
}
