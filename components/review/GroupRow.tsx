'use client';
import { useState } from 'react';
import { fromCents } from '@/lib/engine/cents';
import { groupEntryIds, type Entry, type MatchGroup } from '@/lib/engine/types';
import ConfidenceBadge from './ConfidenceBadge';

export type GroupDecision = 'pending' | 'approved' | 'rejected' | 'blocked';

const KIND_LABELS: Record<MatchGroup['kind'], string> = {
  pair: '1:1 pair',
  combo: 'combination',
  deep: 'many-to-many',
};

export default function GroupRow({
  group,
  entryMap,
  decision,
  altInfo,
  onApprove,
  onUnapprove,
  onReject,
  onUnreject,
}: {
  group: MatchGroup;
  entryMap: Map<number, Entry>;
  decision: GroupDecision;
  /** e.g. "alt 2/13" when the target has competing combos. */
  altInfo: string | null;
  onApprove: () => void;
  onUnapprove: () => void;
  onReject: () => void;
  onUnreject: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ids = groupEntryIds(group);
  const members = ids.map((id) => entryMap.get(id)!).filter(Boolean);
  const targetSet = new Set(group.targetIds);

  const rowTone =
    decision === 'approved'
      ? 'border-emerald-500/40 bg-emerald-500/5'
      : decision === 'rejected'
        ? 'border-red-500/30 bg-red-500/5 opacity-60'
        : decision === 'blocked'
          ? 'border-black/10 opacity-40 dark:border-white/10'
          : 'border-black/10 dark:border-white/10';

  return (
    <div className={`rounded-xl border ${rowTone}`}>
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
        <button onClick={() => setOpen(!open)} className="text-sm opacity-60 hover:opacity-100">
          {open ? '▾' : '▸'}
        </button>
        <ConfidenceBadge tier={group.tier} confidence={group.confidence} />
        <span className="text-sm font-medium">{KIND_LABELS[group.kind]}</span>
        <span className="text-sm opacity-70">
          {group.targetIds.length} ⇄ {group.offsetIds.length} · ±
          {fromCents(Math.abs(group.targetIds.reduce((s, id) => s + (entryMap.get(id)?.amount ?? 0), 0)))}
        </span>
        {group.inScenario && (
          <span className="rounded-full bg-indigo-600/15 px-2 py-0.5 text-xs font-semibold text-indigo-700 dark:text-indigo-300">
            suggested
          </span>
        )}
        {altInfo && <span className="text-xs opacity-50">{altInfo}</span>}
        {group.clusterKey && (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
            ambiguous cluster
          </span>
        )}
        <div className="ml-auto flex gap-2">
          {decision === 'blocked' ? (
            <span className="text-xs opacity-70">entries used by an approved group</span>
          ) : decision === 'approved' ? (
            <button
              onClick={onUnapprove}
              className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-500"
            >
              ✓ Approved — undo
            </button>
          ) : decision === 'rejected' ? (
            <button
              onClick={onUnreject}
              className="rounded-md bg-black/10 px-3 py-1 text-xs font-medium hover:bg-black/20 dark:bg-white/10"
            >
              Rejected — undo
            </button>
          ) : (
            <>
              <button
                onClick={onApprove}
                className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-500"
              >
                Approve
              </button>
              <button
                onClick={onReject}
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

      {open && (
        <div className="overflow-auto border-t border-black/5 px-4 py-2 dark:border-white/5">
          <table className="w-full text-left text-xs">
            <thead className="opacity-60">
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
                  Group total
                </td>
                <td className="py-1 pr-3 text-right font-mono">
                  {fromCents(members.reduce((s, e) => s + e.amount, 0))}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
