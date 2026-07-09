'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { fromCents } from '@/lib/engine/cents';
import {
  groupEntryIds,
  type ConfidenceTier,
  type GroupKind,
  type MatchGroup,
} from '@/lib/engine/types';
import { allGroups, isBlocked, lockedEntries, useStore } from '@/lib/store';
import GroupRow, { type GroupActions, type GroupDecision } from '@/components/review/GroupRow';

type TierFilter = 'all' | ConfidenceTier;
type StatusFilter = 'all' | 'pending' | 'approved' | 'rejected';
type KindFilter = 'all' | GroupKind;

const PAGE = 100;
// Global netting is surfaced in its own last-resort panel, not this list.
const KIND_OPTIONS: { value: KindFilter; label: string }[] = [
  { value: 'all', label: 'All types' },
  { value: 'pair', label: '1:1 pairs' },
  { value: 'combo', label: 'Combinations' },
  { value: 'deep', label: 'Many-to-many' },
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
  const [showUnevidenced, setShowUnevidenced] = useState(false);
  const [unevidencedCount, setUnevidencedCount] = useState(PAGE);
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

  // Global-net groups are a last-resort balancing action, not evidenced matches —
  // kept out of the main review list and surfaced separately below.
  const netGroups = useMemo(
    () => groups.filter((g) => g.kind === 'net').sort((a, b) => a.id.localeCompare(b.id)),
    [groups],
  );
  // The main list is EVIDENCED matches only. Zero-evidence amount coincidences
  // are quarantined in their own collapsed section — they are never suggested
  // and never bulk-approved.
  const sorted = useMemo(
    () =>
      groups
        .filter((g) => g.kind !== 'net' && g.evidenced)
        .sort(
          (a, b) =>
            Number(b.inScenario) - Number(a.inScenario) ||
            b.confidence - a.confidence ||
            a.id.localeCompare(b.id),
        ),
    [groups],
  );
  const unevidenced = useMemo(
    () =>
      groups
        .filter((g) => g.kind !== 'net' && !g.evidenced)
        .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id)),
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

  // Currently-filtered groups that can still be approved (pending = not already
  // decided and not blocked by an approved conflict). Drives "Approve all filtered".
  const approvableVisible = useMemo(
    () => visible.filter((g) => decisions.get(g.id) === 'pending'),
    [visible, decisions],
  );

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

  // Coverage of the one-click suggestion (evidenced scenario groups).
  const suggestedCoverage = useMemo(() => {
    const ids = new Set<number>();
    for (const g of sorted) if (g.inScenario) for (const id of groupEntryIds(g)) ids.add(id);
    return ids.size;
  }, [sorted]);

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
      {/* Summary bar — live reconciliation while you decide. */}
      <div className="sticky top-[104px] z-10 space-y-1.5 rounded-xl border border-black/10 bg-white/90 p-2 backdrop-blur dark:border-white/10 dark:bg-zinc-950/90">
        <div className="flex flex-wrap items-center gap-2">
          <Stat label="Approved" value={approvedGroups.length} />
          <Stat
            label="Rows to remove"
            value={removed.rows}
            hint={entries.length ? `of ${entries.length}` : undefined}
          />
          <Stat
            label="Removed sum"
            value={fromCents(removed.sum)}
            mono
            tone={removed.sum === 0 ? 'good' : 'bad'}
            hint={removed.sum === 0 ? 'balances ✓' : 'must be 0'}
          />
          <Stat
            label="Negatives left open"
            value={`${openNegatives.count}`}
            tone={openNegatives.count === 0 ? 'good' : 'warn'}
            hint={fromCents(openNegatives.sum)}
          />
          <Stat label="Evidenced coverage" value={suggestedCoverage} hint="rows suggested" />
          <button
            onClick={() => setStep('export')}
            disabled={approvedGroups.length === 0 || removed.sum !== 0}
            className="ml-auto rounded-lg bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-40"
          >
            Continue → Export
          </button>
        </div>
        {/* Cleared-rows meter: approved (solid) vs suggested-but-pending (soft). */}
        <div
          className="relative h-1.5 overflow-hidden rounded-full bg-black/10 dark:bg-white/10"
          title={`${removed.rows} rows approved for removal · ${suggestedCoverage} rows in the evidenced suggestion`}
        >
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-indigo-300 dark:bg-indigo-800"
            style={{ width: `${entries.length ? (suggestedCoverage / entries.length) * 100 : 0}%` }}
          />
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-emerald-500"
            style={{ width: `${entries.length ? (removed.rows / entries.length) * 100 : 0}%` }}
          />
        </div>
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

      {/* View toggle + bulk actions */}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <div className="inline-flex rounded-lg border border-black/10 p-0.5 dark:border-white/10">
          <button
            onClick={() => setViewAll(false)}
            className={`rounded-md px-3 py-1 font-medium transition ${
              !viewAll ? 'bg-indigo-600 text-white' : 'opacity-70 hover:opacity-100'
            }`}
          >
            Suggested cleanup
          </button>
          <button
            onClick={() => setViewAll(true)}
            className={`rounded-md px-3 py-1 font-medium transition ${
              viewAll ? 'bg-indigo-600 text-white' : 'opacity-70 hover:opacity-100'
            }`}
          >
            All evidenced groups
          </button>
        </div>
        <div className="mx-1 h-6 w-px bg-black/10 dark:bg-white/10" />
        <button
          onClick={() => bulkApprove(sorted.filter((g) => g.inScenario))}
          className="rounded-md bg-emerald-600 px-3 py-1.5 font-semibold text-white hover:bg-emerald-500"
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
          onClick={() => bulkApprove(approvableVisible)}
          disabled={approvableVisible.length === 0}
          title="Approve every group matching the current filters/search below"
          className="rounded-md bg-emerald-600/15 px-3 py-1.5 font-medium text-emerald-700 hover:bg-emerald-600/25 disabled:opacity-40 dark:text-emerald-400"
        >
          Approve all filtered ({approvableVisible.length})
        </button>
        <button
          onClick={resetDecisions}
          className="rounded-md bg-black/5 px-3 py-1.5 hover:bg-black/10 dark:bg-white/10"
        >
          Reset
        </button>
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
          {visible.length} {viewAll ? 'shown' : 'suggested'} · {sorted.length} evidenced ·{' '}
          {unevidenced.length} without evidence
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

      {/* Quarantine — zero-evidence amount coincidences, never suggested or bulk-approved. */}
      {unevidenced.length > 0 && (
        <div className="rounded-xl border border-black/10 dark:border-white/10">
          <button
            onClick={() => setShowUnevidenced((v) => !v)}
            className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm"
          >
            <span className="opacity-50">{showUnevidenced ? '▾' : '▸'}</span>
            <span className="font-semibold">
              No documentary evidence — {unevidenced.length} amount coincidence
              {unevidenced.length === 1 ? '' : 's'}
            </span>
            <span className="ml-auto text-xs opacity-60">
              excluded from suggestions & bulk approval — approve individually only if you
              recognise them
            </span>
          </button>
          {showUnevidenced && (
            <div className="space-y-2 border-t border-black/5 p-3 dark:border-white/5">
              <p className="text-xs opacity-70">
                These groups sum to exactly zero but share no document number, reference or
                description. In a ledger this size, exact sums arise by coincidence — treat
                each as unproven unless you know the transaction.
              </p>
              {unevidenced.slice(0, unevidencedCount).map((g) => (
                <GroupRow
                  key={g.id}
                  group={g}
                  entryMap={entryMap}
                  decision={decisions.get(g.id)!}
                  siblings={g.altKey ? altCounts.get(g.altKey)! : null}
                  actions={actions}
                />
              ))}
              {unevidencedCount < unevidenced.length && (
                <button
                  onClick={() => setUnevidencedCount((c) => c + PAGE)}
                  className="w-full rounded-lg bg-black/5 py-2 text-center text-sm hover:bg-black/10 dark:bg-white/10"
                >
                  Show more ({unevidencedCount}/{unevidenced.length})
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Last resort — global netting, kept out of the suggested cleanup. */}
      {netGroups.length > 0 && (
        <div className="space-y-2 rounded-xl border border-amber-500/40 bg-amber-500/[0.04] p-3">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-amber-800 dark:text-amber-300">
              Last resort
            </span>
            <span className="text-sm font-semibold">Force-balance the residual to zero</span>
          </div>
          <p className="text-xs opacity-70">
            Not an evidenced match. Global netting just picks whatever offsets sum to the
            remaining unmatched total so the account nets to zero — true of almost any residual,
            so it carries deliberately low confidence and is <b>excluded from the suggested
            cleanup and bulk approvals</b>. Use it only after reviewing the individual matches above.
          </p>
          {netGroups.map((g) => (
            <GroupRow
              key={g.id}
              group={g}
              entryMap={entryMap}
              decision={decisions.get(g.id)!}
              siblings={null}
              actions={actions}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  mono = false,
  tone,
  hint,
}: {
  label: string;
  value: string | number;
  mono?: boolean;
  tone?: 'good' | 'bad' | 'warn';
  hint?: string;
}) {
  const toneCls =
    tone === 'good'
      ? 'text-emerald-600 dark:text-emerald-400'
      : tone === 'bad'
        ? 'text-red-500'
        : tone === 'warn'
          ? 'text-amber-600 dark:text-amber-400'
          : '';
  return (
    <div className="rounded-lg px-3 py-1.5">
      <div className="text-[11px] uppercase tracking-wide opacity-50">{label}</div>
      <div className={`flex items-baseline gap-1.5 ${toneCls}`}>
        <span className={`text-lg font-semibold ${mono ? 'font-mono tabular-nums' : ''}`}>{value}</span>
        {hint && <span className="text-xs opacity-70">{hint}</span>}
      </div>
    </div>
  );
}
