'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { fromCents } from '@/lib/engine/cents';
import {
  groupEntryIds,
  type ConfidenceTier,
  type MatchGroup,
} from '@/lib/engine/types';
import { allGroups, allOutcomes, isBlocked, lockedEntries, useStore } from '@/lib/store';
import GroupRow, { type GroupActions, type GroupDecision } from '@/components/review/GroupRow';

type TierFilter = 'all' | ConfidenceTier;
type StatusFilter = 'all' | 'pending' | 'approved' | 'rejected';

const PAGE = 100;

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

  const [viewAll, setViewAll] = useState(false);
  const [tierFilter, setTierFilter] = useState<TierFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [showAlternatives, setShowAlternatives] = useState(false);
  const [renderCount, setRenderCount] = useState(PAGE);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Stable action bundle so memoized rows never re-render from callback churn.
  const actions = useMemo<GroupActions>(
    () => ({ approve, unapprove, reject, unreject }),
    [approve, unapprove, reject, unreject],
  );

  const groups = useMemo(() => allGroups(runs), [runs]);
  const outcomes = useMemo(() => allOutcomes(runs), [runs]);
  const entryMap = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);
  const locked = useMemo(() => lockedEntries(groups, approved), [groups, approved]);

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

  const decisions = useMemo(() => {
    const m = new Map<string, GroupDecision>();
    for (const g of groups) {
      m.set(
        g.id,
        approved.has(g.id)
          ? 'approved'
          : rejected.has(g.id)
            ? 'rejected'
            : isBlocked(g, locked)
              ? 'blocked'
              : 'pending',
      );
    }
    return m;
  }, [groups, approved, rejected, locked]);

  const sorted = useMemo(
    () =>
      [...groups].sort(
        (a, b) =>
          Number(b.kind === 'net') - Number(a.kind === 'net') ||
          Number(b.inScenario) - Number(a.inScenario) ||
          b.confidence - a.confidence ||
          a.id.localeCompare(b.id),
      ),
    [groups],
  );

  const visible = useMemo(() => {
    return sorted.filter((g) => {
      if (!viewAll && !g.inScenario) return false;
      if (tierFilter !== 'all' && g.tier !== tierFilter) return false;
      const d = decisions.get(g.id)!;
      if (statusFilter === 'pending' && d !== 'pending') return false;
      if (statusFilter === 'approved' && d !== 'approved') return false;
      if (statusFilter === 'rejected' && d !== 'rejected') return false;
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
  }, [sorted, viewAll, tierFilter, statusFilter, showAlternatives, decisions, altCounts, approved, rejected]);

  // Windowed rendering: sentinel loads the next page as it scrolls into view.
  useEffect(() => setRenderCount(PAGE), [viewAll, tierFilter, statusFilter, showAlternatives]);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((ents) => {
      if (ents.some((e) => e.isIntersecting)) {
        setRenderCount((c) => Math.min(c + PAGE, visible.length));
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [visible.length]);

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

  const approvedGroups = useMemo(() => groups.filter((g) => approved.has(g.id)), [groups, approved]);
  const removed = useMemo(() => {
    let rows = 0;
    let sum = 0;
    const ids = new Set<number>();
    for (const g of approvedGroups) {
      for (const id of groupEntryIds(g)) {
        rows++;
        ids.add(id);
        sum += entryMap.get(id)?.amount ?? 0;
      }
    }
    return { rows, sum, ids };
  }, [approvedGroups, entryMap]);

  // Open target-side entries remaining if current approvals were exported.
  const openNegatives = useMemo(() => {
    let count = 0;
    let sum = 0;
    for (const e of entries) {
      if (e.amount < 0 && !removed.ids.has(e.id)) {
        count++;
        sum += e.amount;
      }
    }
    return { count, sum };
  }, [entries, removed.ids]);

  const netReports = runs.map((r) => r.result.netReport).filter((r) => r !== null);
  const stranded = netReports.flatMap((r) => r!.strandedTargetIds);

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
          <b>{approvedGroups.length}</b> approved
        </span>
        <span>
          <b>{removed.rows}</b> rows to remove
        </span>
        <span className={removed.sum === 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}>
          removed sum: <b className="font-mono">{fromCents(removed.sum)}</b>{' '}
          {removed.sum === 0 ? '✓' : '✗ MUST BE ZERO'}
        </span>
        <span className={openNegatives.count === 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}>
          negatives left open: <b>{openNegatives.count}</b> ({fromCents(openNegatives.sum)})
        </span>
        <button
          onClick={() => setStep('export')}
          disabled={approvedGroups.length === 0 || removed.sum !== 0}
          className="ml-auto rounded-lg bg-indigo-600 px-5 py-1.5 font-semibold text-white hover:bg-indigo-500 disabled:opacity-40"
        >
          Continue → Export
        </button>
      </div>

      {stranded.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-2 text-sm">
          <b>{stranded.length}</b> entr{stranded.length === 1 ? 'y is' : 'ies are'} mathematically
          impossible to clear — no combination of opposite-sign entries sums to them (proof, not a
          timeout). They stay open:{' '}
          {stranded.slice(0, 10).map((id) => {
            const e = entryMap.get(id);
            return e ? (
              <span key={id} className="mr-2 font-mono">
                {e.docNo ?? `row ${id + 2}`}: {fromCents(e.amount)}
              </span>
            ) : null;
          })}
          {stranded.length > 10 && `… +${stranded.length - 10} more`}
        </div>
      )}

      {/* Bulk actions + filters */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button
          onClick={() => bulkApprove(sorted.filter((g) => g.inScenario))}
          className="rounded-md bg-indigo-600 px-3 py-1.5 font-semibold text-white hover:bg-indigo-500"
        >
          Approve suggested cleanup
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
          Reset
        </button>
        <span className="mx-2 opacity-30">|</span>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={viewAll} onChange={(e) => setViewAll(e.target.checked)} />
          Explore all groups
        </label>
        {viewAll && (
          <>
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
              Show all alternatives
            </label>
          </>
        )}
        <span className="ml-auto opacity-60">
          {visible.length} of {groups.length} groups {viewAll ? 'shown' : 'suggested'}
        </span>
      </div>

      {/* Groups (windowed) */}
      <div className="space-y-2">
        {visible.slice(0, renderCount).map((g) => {
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
              decision={decisions.get(g.id)!}
              altInfo={altInfo}
              actions={actions}
            />
          );
        })}
        {renderCount < visible.length && (
          <div ref={sentinelRef} className="py-4 text-center text-sm opacity-50">
            Loading more… ({renderCount}/{visible.length})
          </div>
        )}
      </div>
    </div>
  );
}
