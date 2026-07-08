'use client';
import { memo, useState } from 'react';
import { fromCents } from '@/lib/engine/cents';
import { groupEntryIds, type Entry, type MatchGroup } from '@/lib/engine/types';
import ConfidenceBadge from './ConfidenceBadge';
import AltCombos from './AltCombos';

export type GroupDecision = 'pending' | 'approved' | 'rejected' | 'blocked';

export interface GroupActions {
  approve: (id: string) => void;
  unapprove: (id: string) => void;
  reject: (id: string) => void;
  unreject: (id: string) => void;
}

const KIND_LABELS: Record<MatchGroup['kind'], string> = {
  pair: '1:1 pair',
  combo: 'combination',
  deep: 'many-to-many',
  net: 'GLOBAL NETTING',
};

function GroupRowInner({
  group,
  entryMap,
  decision,
  siblings,
  actions,
}: {
  group: MatchGroup;
  entryMap: Map<number, Entry>;
  decision: GroupDecision;
  /** All competing combos for this target (incl. this one); null/1 = no alternatives. */
  siblings: MatchGroup[] | null;
  actions: GroupActions;
}) {
  const [open, setOpen] = useState(false);
  const [altOpen, setAltOpen] = useState(false);
  const isNet = group.kind === 'net';
  const altCount = siblings ? siblings.length : 0;

  const rowTone =
    decision === 'approved'
      ? 'border-emerald-500/40 bg-emerald-500/5'
      : decision === 'rejected'
        ? 'border-red-500/30 bg-red-500/5 opacity-60'
        : decision === 'blocked'
          ? 'border-black/10 opacity-40 dark:border-white/10'
          : isNet
            ? 'border-indigo-500/50 bg-indigo-500/5'
            : 'border-black/10 dark:border-white/10';

  const targetAbs = Math.abs(
    group.targetIds.reduce((s, id) => s + (entryMap.get(id)?.amount ?? 0), 0),
  );

  return (
    <div
      className={`rounded-xl border ${rowTone}`}
      style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 76px' }}
    >
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
        <button onClick={() => setOpen(!open)} className="text-sm opacity-60 hover:opacity-100">
          {open ? '▾' : '▸'}
        </button>
        <ConfidenceBadge tier={group.tier} confidence={group.confidence} />
        <span className={`text-sm font-medium ${isNet ? 'text-indigo-600 dark:text-indigo-300' : ''}`}>
          {KIND_LABELS[group.kind]}
        </span>
        <span className="text-sm opacity-70">
          {group.targetIds.length} ⇄ {group.offsetIds.length} · ±{fromCents(targetAbs)}
        </span>
        {group.inScenario && !isNet && (
          <span className="rounded-full bg-indigo-600/15 px-2 py-0.5 text-xs font-semibold text-indigo-700 dark:text-indigo-300">
            suggested
          </span>
        )}
        {altCount > 1 && (
          <button
            onClick={() => setAltOpen((v) => !v)}
            className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-700 hover:bg-amber-500/25 dark:text-amber-400"
          >
            ⇄ {altCount} clearing options {altOpen ? '▾' : '▸'}
          </button>
        )}
        {group.clusterKey && altCount <= 1 && (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
            ambiguous cluster
          </span>
        )}
        <div className="ml-auto flex gap-2">
          {decision === 'blocked' ? (
            <span className="text-xs opacity-70">entries used by an approved group</span>
          ) : decision === 'approved' ? (
            <button
              onClick={() => actions.unapprove(group.id)}
              className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-500"
            >
              ✓ Approved — undo
            </button>
          ) : decision === 'rejected' ? (
            <button
              onClick={() => actions.unreject(group.id)}
              className="rounded-md bg-black/10 px-3 py-1 text-xs font-medium hover:bg-black/20 dark:bg-white/10"
            >
              Rejected — undo
            </button>
          ) : (
            <>
              <button
                onClick={() => actions.approve(group.id)}
                className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-500"
              >
                Approve
              </button>
              <button
                onClick={() => actions.reject(group.id)}
                className="rounded-md bg-black/10 px-3 py-1 text-xs font-medium hover:bg-black/20 dark:bg-white/10 dark:hover:bg-white/20"
              >
                Reject
              </button>
            </>
          )}
        </div>
      </div>

      {group.reasons.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-4 pb-2">
          {group.reasons.map((r, i) => (
            <span key={i} className="rounded bg-black/5 px-1.5 py-0.5 text-xs opacity-70 dark:bg-white/10">
              {r}
            </span>
          ))}
        </div>
      )}

      {altOpen && siblings && siblings.length > 1 && (
        <AltCombos siblings={siblings} entryMap={entryMap} />
      )}

      {open && <MemberTable group={group} entryMap={entryMap} />}
    </div>
  );
}

function MemberTable({ group, entryMap }: { group: MatchGroup; entryMap: Map<number, Entry> }) {
  const ids = groupEntryIds(group);
  const members = ids.map((id) => entryMap.get(id)!).filter(Boolean);
  const targetSet = new Set(group.targetIds);
  return (
    <div className="max-h-96 overflow-auto border-t border-black/5 px-4 py-2 dark:border-white/5">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-white opacity-80 dark:bg-zinc-950">
          <tr>
            <th className="py-1 pr-3">Side</th>
            <th className="py-1 pr-3">Date</th>
            <th className="py-1 pr-3">Doc No</th>
            <th className="py-1 pr-3">Type</th>
            <th className="py-1 pr-3">Description</th>
            <th className="py-1 pr-3 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {members.map((e) => (
            <tr key={e.id} className="border-t border-black/5 dark:border-white/5">
              <td className="py-1 pr-3">
                <span
                  className={
                    targetSet.has(e.id)
                      ? 'font-semibold text-red-600 dark:text-red-400'
                      : 'text-emerald-700 dark:text-emerald-400'
                  }
                >
                  {targetSet.has(e.id) ? 'reversal' : 'offset'}
                </span>
              </td>
              <td className="whitespace-nowrap py-1 pr-3">
                {e.date ? new Date(e.date).toLocaleDateString() : '—'}
              </td>
              <td className="py-1 pr-3">{e.docNo ?? '—'}</td>
              <td className="py-1 pr-3">{e.docType ?? '—'}</td>
              <td className="max-w-72 truncate py-1 pr-3">{e.description ?? '—'}</td>
              <td className="whitespace-nowrap py-1 pr-3 text-right font-mono">
                {fromCents(e.amount)}
              </td>
            </tr>
          ))}
          <tr className="border-t border-black/10 font-semibold dark:border-white/10">
            <td colSpan={5} className="py-1 pr-3 text-right">
              Group total ({members.length} rows)
            </td>
            <td className="py-1 pr-3 text-right font-mono">
              {fromCents(members.reduce((s, e) => s + e.amount, 0))}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** Memoized: only rows whose decision (or group identity) changed re-render. */
const GroupRow = memo(GroupRowInner);
export default GroupRow;
