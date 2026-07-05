/// <reference lib="webworker" />
import { findCombos } from './pass2-subset';
import { findDeepGroups } from './pass3-deep';
import type { Entry, MatchGroup, SearchConfig, TargetOutcome } from './types';

export interface Pass2Job {
  type: 'pass2';
  jobId: number;
  account: string;
  targets: Entry[];
  pool: Entry[];
  config: SearchConfig;
}

export interface Pass3Job {
  type: 'pass3';
  jobId: number;
  account: string;
  targets: Entry[];
  pool: Entry[];
  config: SearchConfig;
}

export type WorkerJob = Pass2Job | Pass3Job;

export type WorkerReply =
  | { type: 'progress'; jobId: number; done: number; total: number }
  | {
      type: 'done';
      jobId: number;
      groups: MatchGroup[];
      outcomes: TargetOutcome[];
      statesExplored: number;
    };

self.onmessage = (ev: MessageEvent<WorkerJob>) => {
  const job = ev.data;
  const post = (msg: WorkerReply) => (self as unknown as Worker).postMessage(msg);

  if (job.type === 'pass2') {
    const res = findCombos(job.targets, job.pool, job.account, job.config, 'combo', (done, total) =>
      post({ type: 'progress', jobId: job.jobId, done, total }),
    );
    post({
      type: 'done',
      jobId: job.jobId,
      groups: res.groups,
      outcomes: res.outcomes,
      statesExplored: res.statesExplored,
    });
  } else {
    const res = findDeepGroups(job.targets, job.pool, job.account, job.config);
    post({
      type: 'done',
      jobId: job.jobId,
      groups: res.groups,
      outcomes: [],
      statesExplored: res.statesExplored,
    });
  }
};
