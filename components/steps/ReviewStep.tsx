'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { fromCents } from '@/lib/engine/cents';
import {
  groupEntryIds,
  type ConfidenceTier,
  type GroupKind,
  type MatchGroup,
} from '@/lib/engine/types';
import { allGroups, allOutcomes, isBlocked, lockedEntries, useStore } from '@/lib/store';
import GroupRow, { type GroupActions, type GroupDecision } from '@/components/review/GroupRow';

type TierFilter = 'all' | ConfidenceTier;
type StatusFilter = 'all' | 'pending' | 'approved' | 'rejected';
type KindFilter = 'all' | GroupKind;

const PAGE = 100;
const KIND_OPTIONS: { value: KindFilter; label: string }[] = [
  { value: 'all', label: 'All types' },
  { value: 'pair', label: '1:1 pairs' },
  { value: 'combo', label: 'Combinations' },
  { value: 'deep', label: 'Many-to-many' },
  { value: 'net', label: 'Global netting' },
];

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
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [onlyAlts, setOnlyAlts] = useState(false);
  const [search, setSearch] = useState('');
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

  // One lower-cased searchable string per group, built from its member entries.
  const searchIndex = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of groups) {
      const parts: string[] = [g.kind];
      for (const id of groupEntryIds(g)) {
        const e = entryMap.get(id);
        if (!e) continue;
        if (e.docNo) parts.push(e.docNo);
        if (e.reference) parts.push(e.reference);
        if (e.docType) parts.push(e.docType);
        if (e.description) parts.push(e.description);
        parts.push(fromCents(e.amount), fromCents(Math.abs(e.amount)), String(e.amount));
      }
      m.set(g.id, parts.join(' ').toLowerCase());
    }
    return m;
  }, [groups, entryMap]);

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

  // One representative per alt cluster: the approved sibling if any, else the
  // scenario-suggested one, else the highest-confidence one. Non-reps are
  // reachable via the row's inline "clearing options" expander. `clusterShown`
  // marks reps that belong in the suggested view (any sibling suggested, or the
  // cluster has an approved pick) so choosing a non-suggested alternative never
  // makes the whole cluster vanish.
  const { isRepresentative, clusterShown } = useMemo(() => {
    const rep = new Set<string>();
    const shown = new Set<string>();
    for (const g of sorted) {
      if (!g.altKey || altCounts.get(g.altKey)!.length <= 1) {
        rep.add(g.id);
        if (g.inScenario) shown.add(g.id);
        continue;
      }
      const sibs = altCounts.get(g.altKey)!;
      const chosen =
        sibs.find((s) => approved.has(s.id)) ??
        sibs.find((s) => s.inScenario) ??
        sibs.reduce((x, y) =>
          y.confidence > x.confidence || (y.confidence === x.confidence && y.id < x.id) ? y : x,
        );
      rep.add(chosen.id);
      if (sibs.some((s) => s.inScenario) || sibs.some((s) => approved.has(s.id))) shown.add(chosen.id);
    }
    return { isRepresentative: rep, clusterShown: shown };
  }, [sorted, altCounts, approved]);

  const needle = search.trim().toLowerCase();
  const visible = useMemo(() => {
    return sorted.filter((g) => {
      if (!isRepresentative.has(g.id)) return false;
      if (!viewAll && !clusterShown.has(g.id)) return false;
      if (kindFilter !== 'all' && g.kind !== kindFilter) return false;
      if (tierFilter !== 'all' && g.tier !== tierFilter) return false;
      const d = decisions.get(g.id)!;
      if (statusFilter !== 'all' && d !== statusFilter) return false;
      if (onlyAlts && (!g.altKey || altCounts.get(g.altKey)!.length <= 1)) return false;
      if (needle && !searchIndex.get(g.id)!.includes(needle)) return false;
      return true;
    });
  }, [sorted, viewAll, isRepresentative, clusterShown, kindFilter, tierFilter, statusFilter, onlyAlts, needle, decisions, altCounts, searchIndex]);

  // Windowed rendering: sentinel loads the next page as it scrolls into view.
  useEffect(() => setRenderCount(PAGE), [viewAll, tierFilter, statusFilter, kindFilter, onlyAlts, needle]);
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

  const clustersWithAlts = useMemo(
    () => [...altCounts.values()].filter((s) => s.length > 1).length,
    [altCounts],
  );

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

      {/* Bulk actions */}
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
        <label className="ml-2 flex items-center gap-1.5">
          <input type="checkbox" checked={viewAll} onChange={(e) => setViewAll(e.target.checked)} />
          Explore all groups
        </label>
      </div>

      {/* Filters — always available */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-black/10 px-3 py-2 text-sm dark:border-white/10">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search doc no, description, amount…"
          className="w-64 rounded-md border border-black/15 bg-transparent px-3 py-1 dark:border-white/20 dark:bg-zinc-900"
        />
        <select
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value as KindFilter)}
          className="rounded-md border border-black/15 bg-transparent px-2 py-1 dark:border-white/20 dark:bg-zinc-900"
        >
          {KIND_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
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
          <input type="checkbox" checked={onlyAlts} onChange={(e) => setOnlyAlts(e.target.checked)} />
          Only groups with alternatives{clustersWithAlts > 0 && ` (${clustersWithAlts})`}
        </label>
        {(search || kindFilter !== 'all' || tierFilter !== 'all' || statusFilter !== 'all' || onlyAlts) && (
          <button
            onClick={() => {
              setSearch('');
              setKindFilter('all');
              setTierFilter('all');
              setStatusFilter('all');
              setOnlyAlts(false);
            }}
            className="rounded-md bg-black/5 px-2 py-1 hover:bg-black/10 dark:bg-white/10"
          >
            Clear filters
          </button>
        )}
        <span className="ml-auto opacity-60">
          {visible.length} {viewAll ? 'shown' : 'suggested'} · {groups.length} total
        </span>
      </div>

      {/* Groups (windowed) */}
      <div className="space-y-2">
        {visible.slice(0, renderCount).map((g) => (
          // Key by cluster (altKey) so swapping the represented alternative
          // keeps the same row mounted — the inline picker stays open.
          <GroupRow
            key={g.altKey ?? g.id}
            group={g}
            entryMap={entryMap}
            decision={decisions.get(g.id)!}
            siblings={g.altKey ? altCounts.get(g.altKey)! : null}
            actions={actions}
          />
        ))}
        {renderCount < visible.length && (
          <div ref={sentinelRef} className="py-4 text-center text-sm opacity-50">
            Loading more… ({renderCount}/{visible.length})
          </div>
        )}
        {visible.length === 0 && (
          <p className="rounded-xl border border-black/10 px-4 py-6 text-center text-sm opacity-60 dark:border-white/10">
            No groups match the current filters.
          </p>
        )}
      </div>
    </div>
  );
}
