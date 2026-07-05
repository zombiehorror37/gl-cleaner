'use client';
import { useMemo, useState } from 'react';
import { fromCents } from '@/lib/engine/cents';
import {
  groupEntryIds,
  type ConfidenceTier,
  type MatchGroup,
} from '@/lib/engine/types';
import { allGroups, allOutcomes, isBlocked, lockedEntries, useStore } from '@/lib/store';
import GroupRow, { type GroupDecision } from '@/components/review/GroupRow';

type TierFilter = 'all' | ConfidenceTier;
type StatusFilter = 'all' | 'pending' | 'approved' | 'rejected';

export default function ReviewStep() {
  const entries = useStore((s) => s.entries);
  const runs = useStore((s) => s.runs);
  const approved = useStore((s) => s.approved);
  const rejected = useStore((s) => s.rejected);
  const approve = useStore((s) => s.approve);
  const unapprove = useStore((s) => s.unapprove);
  const reject = useStore((s) => s.reject);
  const unreject = useStore((s) => s.unreject);
  const approveMany = useStore((s) => s.approveMany);
  const resetDecisions = useStore((s) => s.resetDecisions);
  const setStep = useStore((s) => s.setStep);

  const [tierFilter, setTierFilter] = useState<TierFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [showAlternatives, setShowAlternatives] = useState(false);

  const groups = useMemo(() => allGroups(runs), [runs]);
  const outcomes = useMemo(() => allOutcomes(runs), [runs]);
  const entryMap = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);
  const locked = useMemo(() => lockedEntries(groups, approved), [groups, approved]);

  // Alternatives per altKey for "alt x/y" labels.
  const altCounts = useMemo(() => {
    const m = new Map<string, MatchGroup[]>();
    for (const g of groups) {
      if (!g.altKey) continue;
      const list = m.get(g.altKey) ?? [];
      list.push(g);
      m.set(g.altKey, list);
    }
    return m;
  }, [groups]);

  const decisionOf = (g: MatchGroup): GroupDecision =>
    approved.has(g.id)
      ? 'approved'
      : rejected.has(g.id)
        ? 'rejected'
        : isBlocked(g, locked)
          ? 'blocked'
          : 'pending';

  const sorted = useMemo(
    () =>
      [...groups].sort(
        (a, b) =>
          Number(b.inScenario) - Number(a.inScenario) ||
          b.confidence - a.confidence ||
          a.id.localeCompare(b.id),
      ),
    [groups],
  );

  const visible = sorted.filter((g) => {
    if (tierFilter !== 'all' && g.tier !== tierFilter) return false;
    const d = decisionOf(g);
    if (statusFilter === 'pending' && d !== 'pending') return false;
    if (statusFilter === 'approved' && d !== 'approved') return false;
    if (statusFilter === 'rejected' && d !== 'rejected') return false;
    // Collapse alternatives: show only best (first in sorted order) per altKey
    // unless the toggle is on or a decision was already made on this one.
    if (!showAlternatives && g.altKey && d === 'pending') {
      const siblings = altCounts.get(g.altKey)!;
      if (siblings.length > 1) {
        const anyDecided = siblings.some((s) => approved.has(s.id) || rejected.has(s.id));
        if (!anyDecided) {
          const best = siblings.reduce((x, y) =>
            y.confidence > x.confidence || (y.confidence === x.confidence && y.id < x.id) ? y : x,
          );
          if (best.id !== g.id) return false;
        }
      }
    }
    return true;
  });

  // Bulk actions operate in confidence order, skipping conflicts as they arise.
  const bulkApprove = (candidates: MatchGroup[]) => {
    const lockedNow = lockedEntries(groups, approved);
    const chosen: string[] = [];
    for (const g of candidates) {
      if (approved.has(g.id) || rejected.has(g.id)) continue;
      if (isBlocked(g, lockedNow)) continue;
      chosen.push(g.id);
      for (const e of groupEntryIds(g)) lockedNow.set(e, g.id);
    }
    approveMany(chosen);
  };

  const approvedGroups = groups.filter((g) => approved.has(g.id));
  const removedRows = approvedGroups.reduce((s, g) => s + groupEntryIds(g).length, 0);
  const removedSum = approvedGroups.reduce(
    (s, g) => s + groupEntryIds(g).reduce((x, id) => x + (entryMap.get(id)?.amount ?? 0), 0),
    0,
  );

  const unmatchedCounts = useMemo(() => {
    const c = { matched: 0, 'proven-unmatchable': 0, 'exhausted-no-combo': 0, 'budget-exhausted': 0 };
    for (const o of outcomes) c[o.status]++;
    return c;
  }, [outcomes]);

  if (groups.length === 0) {
    return (
      <div className="rounded-xl border border-black/10 p-8 text-center dark:border-white/10">
        <p className="text-lg font-medium">No offsetting groups found.</p>
        <p className="mt-1 text-sm opacity-60">
          Nothing in this GL sums to zero within the configured limits.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary bar */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-x-6 gap-y-1 rounded-xl border border-black/10 bg-white/90 px-4 py-3 text-sm backdrop-blur dark:border-white/10 dark:bg-zinc-950/90">
        <span>
          <b>{approvedGroups.length}</b> groups approved
        </span>
        <span>
          <b>{removedRows}</b> rows will be removed
        </span>
        <span className={removedSum === 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}>
          removed sum: <b className="font-mono">{fromCents(removedSum)}</b>{' '}
          {removedSum === 0 ? '✓' : '✗ MUST BE ZERO'}
        </span>
        <span className="opacity-60">
          engine: {unmatchedCounts.matched} targets matched · {unmatchedCounts['proven-unmatchable']}{' '}
          proven unmatchable · {unmatchedCounts['exhausted-no-combo']} none within limits ·{' '}
          {unmatchedCounts['budget-exhausted']} hit time budget
        </span>
        <button
          onClick={() => setStep('export')}
          disabled={approvedGroups.length === 0 || removedSum !== 0}
          className="ml-auto rounded-lg bg-indigo-600 px-5 py-1.5 font-semibold text-white hover:bg-indigo-500 disabled:opacity-40"
        >
          Continue → Export
        </button>
      </div>

      {/* Bulk actions + filters */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button
          onClick={() => bulkApprove(sorted.filter((g) => g.inScenario))}
          className="rounded-md bg-indigo-600/15 px-3 py-1.5 font-medium text-indigo-700 hover:bg-indigo-600/25 dark:text-indigo-300"
        >
          Approve suggested scenario
        </button>
        <button
          onClick={() => bulkApprove(sorted.filter((g) => g.tier === 'high'))}
          className="rounded-md bg-emerald-600/15 px-3 py-1.5 font-medium text-emerald-700 hover:bg-emerald-600/25 dark:text-emerald-400"
        >
          Approve all high confidence
        </button>
        <button
          onClick={resetDecisions}
          className="rounded-md bg-black/5 px-3 py-1.5 hover:bg-black/10 dark:bg-white/10"
        >
          Reset all decisions
        </button>
        <span className="mx-2 opacity-30">|</span>
        <select
          value={tierFilter}
          onChange={(e) => setTierFilter(e.target.value as TierFilter)}
          className="rounded-md border border-black/15 bg-transparent px-2 py-1 dark:border-white/20 dark:bg-zinc-900"
        >
          <option value="all">All confidence</option>
          <option value="high">High only</option>
          <option value="medium">Medium only</option>
          <option value="low">Low only</option>
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          className="rounded-md border border-black/15 bg-transparent px-2 py-1 dark:border-white/20 dark:bg-zinc-900"
        >
          <option value="all">All statuses</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={showAlternatives}
            onChange={(e) => setShowAlternatives(e.target.checked)}
          />
          Show all alternative combos
        </label>
        <span className="ml-auto opacity-60">
          {visible.length} of {groups.length} groups shown
        </span>
      </div>

      {/* Groups */}
      <div className="space-y-2">
        {visible.map((g) => {
          const siblings = g.altKey ? altCounts.get(g.altKey)! : null;
          const altInfo =
            siblings && siblings.length > 1
              ? `alt ${siblings.findIndex((s) => s.id === g.id) + 1}/${siblings.length} for this amount`
              : null;
          return (
            <GroupRow
              key={g.id}
              group={g}
              entryMap={entryMap}
              decision={decisionOf(g)}
              altInfo={altInfo}
              onApprove={() => approve(g.id)}
              onUnapprove={() => unapprove(g.id)}
              onReject={() => reject(g.id)}
              onUnreject={() => unreject(g.id)}
            />
          );
        })}
      </div>
    </div>
  );
}
