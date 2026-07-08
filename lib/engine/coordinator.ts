/// <reference lib="webworker" />
// Coordinator worker: runs the ENTIRE pipeline for one account off the main
// thread — pass 1 inline, pass-2 shards fanned out to nested workers (one per
// core), optional pass 3, then scenario + global net solve. Emits throttled
// progress; the main thread only renders.
import { findExactPairs } from './pass1-pairs';
import { findCombos } from './pass2-subset';
import { findDeepGroups } from './pass3-deep';
import { finalizeGroups } from './run';
import type { WorkerJob, WorkerReply } from './worker';
import type {
  AccountConfig,
  EngineProgress,
  EngineResult,
  Entry,
  MatchGroup,
  TargetOutcome,
} from './types';

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
    const result = await runPipeline(ev.data.entries, ev.data.config, post);
    post({ type: 'done', result });
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};

async function runPipeline(
  entries: Entry[],
  config: AccountConfig,
  post: (msg: CoordinatorReply) => void,
): Promise<EngineResult> {
  const t0 = Date.now();
  const account = config.account;
  let lastEmit = 0;
  const progress = (p: Omit<EngineProgress, 'account'>, force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < PROGRESS_INTERVAL_MS) return;
    lastEmit = now;
    post({ type: 'progress', progress: { ...p, account } });
  };

  progress({ phase: 'pass1', targetsDone: 0, targetsTotal: 0, groupsFound: 0, statesExplored: 0 }, true);
  const pass1 = findExactPairs(entries, account);
  const groups: MatchGroup[] = [...pass1.groups];
  const outcomes: TargetOutcome[] = [];
  let statesExplored = 0;

  const residual = entries.filter((e) => !pass1.pairedIds.has(e.id) && e.amount !== 0);
  const pos = residual.filter((e) => e.amount > 0);
  const neg = residual.filter((e) => e.amount < 0);
  const directions: [Entry[], Entry[]][] =
    config.nature === 'debit'
      ? [[neg, pos]]
      : config.nature === 'credit'
        ? [[pos, neg]]
        : [
            [neg, pos],
            [pos, neg],
          ];
  const totalTargets = directions.reduce((s, [t]) => s + t.length, 0);

  const nestedWorkersOk = typeof Worker !== 'undefined';
  const doneByJob = new Map<number, number>();
  const emitPass2 = () => {
    let done = 0;
    for (const d of doneByJob.values()) done += d;
    progress({
      phase: 'pass2',
      targetsDone: done,
      targetsTotal: totalTargets,
      groupsFound: groups.length,
      statesExplored,
    });
  };

  if (nestedWorkersOk) {
    const cores = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 16));
    interface Shard {
      targets: Entry[];
      pool: Entry[];
    }
    const shards: Shard[] = [];
    for (const [targets, pool] of directions) {
      const ordered = [...targets].sort(
        (a, b) => Math.abs(b.amount) - Math.abs(a.amount) || a.id - b.id,
      );
      const n = Math.min(cores, Math.max(1, ordered.length));
      const buckets: Entry[][] = Array.from({ length: n }, () => []);
      ordered.forEach((t, i) => buckets[i % n].push(t));
      for (const b of buckets) if (b.length) shards.push({ targets: b, pool });
    }
    const jobs: WorkerJob[] = shards.map((s, i) => ({
      type: 'pass2',
      jobId: i,
      account,
      targets: s.targets,
      pool: s.pool,
      config,
    }));
    const replies = await runNestedJobs(jobs, cores, (jobId, done) => {
      doneByJob.set(jobId, done);
      emitPass2();
    });
    for (const r of replies) {
      if (r.type === 'done') {
        groups.push(...r.groups);
        outcomes.push(...r.outcomes);
        statesExplored += r.statesExplored;
      }
    }
  } else {
    let done = 0;
    for (const [targets, pool] of directions) {
      const res = findCombos(targets, pool, account, config, 'combo', (d) => {
        doneByJob.set(0, done + d);
        emitPass2();
      });
      done += targets.length;
      groups.push(...res.groups);
      outcomes.push(...res.outcomes);
      statesExplored += res.statesExplored;
    }
  }

  if (config.deepSearch) {
    progress({ phase: 'pass3', targetsDone: totalTargets, targetsTotal: totalTargets, groupsFound: groups.length, statesExplored }, true);
    const matched = new Set(outcomes.filter((o) => o.status === 'matched').map((o) => o.targetId));
    for (const [targets, pool] of directions) {
      const deep = findDeepGroups(targets.filter((e) => !matched.has(e.id)), pool, account, config);
      groups.push(...deep.groups);
      statesExplored += deep.statesExplored;
    }
  }

  progress({ phase: 'net', targetsDone: totalTargets, targetsTotal: totalTargets, groupsFound: groups.length, statesExplored }, true);
  const netReport = finalizeGroups(entries, groups, config);

  progress({ phase: 'done', targetsDone: totalTargets, targetsTotal: totalTargets, groupsFound: groups.length, statesExplored }, true);
  return {
    groups,
    clusters: pass1.clusters,
    outcomes,
    netReport,
    stats: {
      totalEntries: entries.length,
      positiveEntries: entries.filter((e) => e.amount > 0).length,
      negativeEntries: entries.filter((e) => e.amount < 0).length,
      statesExplored,
      elapsedMs: Date.now() - t0,
    },
  };
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
