import { findExactPairs } from './pass1-pairs';
import { buildScenario } from './scenario';
import { runAccount } from './run';
import type { WorkerJob, WorkerReply } from './worker';
import type {
  AccountConfig,
  EngineProgress,
  EngineResult,
  Entry,
  MatchGroup,
  TargetOutcome,
} from './types';

/**
 * Multi-core orchestration for one account:
 * pass 1 runs inline (O(n), fast); pass-2 targets are sharded across a pool of
 * Web Workers (one per core); pass 3 runs on a single worker over residuals;
 * scenario optimization runs inline on the merged group set.
 * Falls back to the synchronous engine when Workers are unavailable.
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

  const t0 = Date.now();
  const account = config.account;
  const progress = (p: Omit<EngineProgress, 'account'>) => onProgress?.({ ...p, account });

  progress({ phase: 'pass1', targetsDone: 0, targetsTotal: 0, groupsFound: 0, statesExplored: 0 });
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

  const cores = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 16));

  // Build shards: round-robin targets (sorted large-first) so each worker gets
  // a mix of heavy and light targets.
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

  const totalTargets = shards.reduce((s, x) => s + x.targets.length, 0);
  const doneByJob = new Map<number, number>();

  const runJobs = (jobs: WorkerJob[]): Promise<WorkerReply[]> =>
    new Promise((resolve, reject) => {
      if (jobs.length === 0) return resolve([]);
      const workers: Worker[] = [];
      const results: WorkerReply[] = [];
      let remaining = jobs.length;
      let next = 0;
      const poolSize = Math.min(cores, jobs.length);

      const cleanup = () => workers.forEach((w) => w.terminate());
      signal?.addEventListener('abort', () => {
        cleanup();
        reject(new DOMException('cancelled', 'AbortError'));
      });

      const spawn = () => {
        const w = new Worker(new URL('./worker.ts', import.meta.url));
        workers.push(w);
        const assign = () => {
          if (next < jobs.length) {
            w.postMessage(jobs[next++]);
          } else {
            w.terminate();
          }
        };
        w.onmessage = (ev: MessageEvent<WorkerReply>) => {
          const msg = ev.data;
          if (msg.type === 'progress') {
            doneByJob.set(msg.jobId, msg.done);
            let done = 0;
            for (const d of doneByJob.values()) done += d;
            progress({
              phase: 'pass2',
              targetsDone: done,
              targetsTotal: totalTargets,
              groupsFound: groups.length,
              statesExplored,
            });
            return;
          }
          results.push(msg);
          doneByJob.set(msg.jobId, jobs.find((j) => j.jobId === msg.jobId)!.targets.length);
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
      for (let i = 0; i < poolSize; i++) spawn();
    });

  const pass2Jobs: WorkerJob[] = shards.map((s, i) => ({
    type: 'pass2',
    jobId: i,
    account,
    targets: s.targets,
    pool: s.pool,
    config,
  }));
  const replies = await runJobs(pass2Jobs);
  for (const r of replies) {
    if (r.type === 'done') {
      groups.push(...r.groups);
      outcomes.push(...r.outcomes);
      statesExplored += r.statesExplored;
    }
  }

  if (config.deepSearch) {
    progress({ phase: 'pass3', targetsDone: totalTargets, targetsTotal: totalTargets, groupsFound: groups.length, statesExplored });
    const matched = new Set(outcomes.filter((o) => o.status === 'matched').map((o) => o.targetId));
    const deepJobs: WorkerJob[] = directions.map(([targets, pool], i) => ({
      type: 'pass3',
      jobId: 1000 + i,
      account,
      targets: targets.filter((e) => !matched.has(e.id)),
      pool,
      config,
    }));
    const deepReplies = await runJobs(deepJobs);
    for (const r of deepReplies) {
      if (r.type === 'done') {
        groups.push(...r.groups);
        statesExplored += r.statesExplored;
      }
    }
  }

  progress({ phase: 'scenario', targetsDone: totalTargets, targetsTotal: totalTargets, groupsFound: groups.length, statesExplored });
  const scenario = buildScenario(groups);
  for (const g of groups) g.inScenario = scenario.chosen.has(g.id);

  progress({ phase: 'done', targetsDone: totalTargets, targetsTotal: totalTargets, groupsFound: groups.length, statesExplored });
  return {
    groups,
    clusters: pass1.clusters,
    outcomes,
    stats: {
      totalEntries: entries.length,
      positiveEntries: entries.filter((e) => e.amount > 0).length,
      negativeEntries: entries.filter((e) => e.amount < 0).length,
      statesExplored,
      elapsedMs: Date.now() - t0,
    },
  };
}
