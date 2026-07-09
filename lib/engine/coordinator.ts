/// <reference lib="webworker" />
// Coordinator worker: drives the SAME `pipeline` generator as the sync engine,
// off the main thread. Each yielded pass-2 work item is sharded across nested
// workers (one per core); everything else (pass 1, pass 3, packing, netting)
// runs inline here. Emits throttled progress; the main thread only renders.
import { pipeline, runPass2Sync, type Pass2Work, type Pass2WorkResult } from './run';
import type { WorkerJob, WorkerReply } from './worker';
import type { AccountConfig, EngineProgress, EngineResult, Entry } from './types';

export interface CoordinatorJob {
  entries: Entry[];
  config: AccountConfig;
}

export type CoordinatorReply =
  | { type: 'progress'; progress: EngineProgress }
  | { type: 'done'; result: EngineResult }
  | { type: 'error'; message: string };

const PROGRESS_INTERVAL_MS = 100;

self.onmessage = async (ev: MessageEvent<CoordinatorJob>) => {
  const post = (msg: CoordinatorReply) => (self as unknown as Worker).postMessage(msg);
  try {
    const { entries, config } = ev.data;

    // Throttle by time, but always let phase transitions through.
    let lastEmit = 0;
    let lastPhase: EngineProgress['phase'] | null = null;
    const onProgress = (p: EngineProgress) => {
      const now = Date.now();
      if (p.phase === lastPhase && now - lastEmit < PROGRESS_INTERVAL_MS) return;
      lastPhase = p.phase;
      lastEmit = now;
      post({ type: 'progress', progress: p });
    };

    const gen = pipeline(entries, config, onProgress);
    let next = gen.next();
    while (!next.done) {
      const work = next.value;
      const result =
        typeof Worker === 'undefined'
          ? runPass2Sync(work, config)
          : await runPass2Sharded(work, config);
      next = gen.next(result);
    }
    post({ type: 'done', result: next.value });
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};

/** Shard one pass-2 work item across nested workers, one per core. */
async function runPass2Sharded(work: Pass2Work, config: AccountConfig): Promise<Pass2WorkResult> {
  const cores = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 16));

  const jobs: WorkerJob[] = [];
  for (const { targets, pool } of work.directions) {
    const ordered = [...targets].sort(
      (a, b) => Math.abs(b.amount) - Math.abs(a.amount) || a.id - b.id,
    );
    const n = Math.min(cores, Math.max(1, ordered.length));
    const buckets: Entry[][] = Array.from({ length: n }, () => []);
    ordered.forEach((t, i) => buckets[i % n].push(t));
    for (const b of buckets) {
      if (b.length) {
        jobs.push({ type: 'pass2', jobId: jobs.length, account: config.account, targets: b, pool, config });
      }
    }
  }

  const doneByJob = new Map<number, number>();
  const emit = () => {
    let done = 0;
    for (const d of doneByJob.values()) done += d;
    work.reportProgress(done);
  };

  const replies = await runNestedJobs(jobs, cores, (jobId, done) => {
    doneByJob.set(jobId, done);
    emit();
  });

  const result: Pass2WorkResult = { groups: [], outcomes: [], statesExplored: 0 };
  for (const r of replies) {
    if (r.type === 'done') {
      result.groups.push(...r.groups);
      result.outcomes.push(...r.outcomes);
      result.statesExplored += r.statesExplored;
    }
  }
  return result;
}

function runNestedJobs(
  jobs: WorkerJob[],
  cores: number,
  onProgress: (jobId: number, done: number) => void,
): Promise<WorkerReply[]> {
  return new Promise((resolve, reject) => {
    if (jobs.length === 0) return resolve([]);
    const workers: Worker[] = [];
    const results: WorkerReply[] = [];
    let remaining = jobs.length;
    let next = 0;
    const cleanup = () => workers.forEach((w) => w.terminate());

    const spawn = () => {
      const w = new Worker(new URL('./worker.ts', import.meta.url));
      workers.push(w);
      const assign = () => {
        if (next < jobs.length) w.postMessage(jobs[next++]);
        else w.terminate();
      };
      w.onmessage = (ev: MessageEvent<WorkerReply>) => {
        const msg = ev.data;
        if (msg.type === 'progress') {
          onProgress(msg.jobId, msg.done);
          return;
        }
        results.push(msg);
        onProgress(msg.jobId, jobs.find((j) => j.jobId === msg.jobId)!.targets.length);
        if (--remaining === 0) {
          cleanup();
          resolve(results);
        } else {
          assign();
        }
      };
      w.onerror = (e) => {
        cleanup();
        reject(new Error(`worker error: ${e.message}`));
      };
      assign();
    };
    for (let i = 0; i < Math.min(cores, jobs.length); i++) spawn();
  });
}
