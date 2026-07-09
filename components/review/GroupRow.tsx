'use client';
import { memo, useState } from 'react';
import { fromCents } from '@/lib/engine/cents';
import { type Entry, type MatchGroup } from '@/lib/engine/types';
import ConfidenceBadge from './ConfidenceBadge';
import AltCombos from './AltCombos';
import MemberTable from './MemberTable';

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
  net: 'global netting',
};

const fmtDate = (ms: number | null): string | null =>
  ms === null ? null : new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });

/** Compact one-line context: docs, dates and description, so most groups can be judged without expanding. */
function ContextLine({ group, entryMap }: { group: MatchGroup; entryMap: Map<number, Entry> }) {
  const t = entryMap.get(group.targetIds[0]);
  const offsets = group.offsetIds.map((id) => entryMap.get(id)).filter((e): e is Entry => !!e);
  if (!t) return null;
  const offsetDocs = offsets
    .map((o) => o.docNo)
    .filter((d): d is string => !!d)
    .slice(0, 3);
  const desc = (t.description ?? offsets.find((o) => o.description)?.description ?? '').trim();
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs opacity-70">
      {t.docNo && (
        <span className="font-mono">
          {group.targetIds.length > 1 ? `${t.docNo} +${group.targetIds.length - 1}` : t.docNo}
          {offsetDocs.length > 0 && (
            <>
              {' '}↔ {offsetDocs.join(', ')}
              {group.offsetIds.length > offsetDocs.length && ` +${group.offsetIds.length - offsetDocs.length}`}
            </>
          )}
        </span>
      )}
      {fmtDate(t.date) && <span>{fmtDate(t.date)}</span>}
      {desc && <span className="max-w-[38ch] truncate">{desc}</span>}
    </div>
  );
}

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
  const hasAlts = altCount > 1;

  const rowTone =
    decision === 'approved'
      ? 'border-emerald-500/50 bg-emerald-500/[0.06]'
      : decision === 'rejected'
        ? 'border-red-500/30 bg-red-500/[0.04] opacity-60'
        : decision === 'blocked'
          ? 'border-black/10 opacity-40 dark:border-white/10'
          : isNet
            ? 'border-amber-500/50 bg-amber-500/[0.05]'
            : 'border-black/10 dark:border-white/10';

  const targetAbs = Math.abs(
    group.targetIds.reduce((s, id) => s + (entryMap.get(id)?.amount ?? 0), 0),
  );

  return (
    <div
      className={`rounded-xl border ${rowTone}`}
      style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 84px' }}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <button
          onClick={() => setOpen(!open)}
          className="text-sm opacity-50 hover:opacity-100"
          aria-label={open ? 'Collapse rows' : 'Expand rows'}
        >
          {open ? '▾' : '▸'}
        </button>

        {/* Amount is the anchor — largest, first thing scanned. */}
        <span className="font-mono text-base font-semibold tabular-nums">±{fromCents(targetAbs)}</span>

        <ConfidenceBadge tier={group.tier} confidence={group.confidence} />

        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            isNet
              ? 'bg-amber-500/20 text-amber-800 dark:text-amber-300'
              : 'bg-black/5 opacity-70 dark:bg-white/10'
          }`}
        >
          {KIND_LABELS[group.kind]}
        </span>
        <span className="text-xs opacity-60">
          {isNet
            ? `${group.targetIds.length} residual → ${group.offsetIds.length} offset`
            : `${group.targetIds.length} reversal → ${group.offsetIds.length} offset`}
        </span>

        {group.inScenario && !isNet && (
          <span className="rounded-full bg-indigo-600/15 px-2 py-0.5 text-xs font-semibold text-indigo-700 dark:text-indigo-300">
            suggested
          </span>
        )}
        {!group.evidenced && !isNet && (
          <span
            className="rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-400"
            title="Sums to zero, but no document number, reference or description ties these entries together"
          >
            no evidence
          </span>
        )}
        {group.clusterKey && !hasAlts && (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
            ambiguous cluster
          </span>
        )}

        <div className="ml-auto flex gap-2">
          {decision === 'blocked' ? (
            <span className="self-center text-xs opacity-70">entries used by an approved group</span>
          ) : decision === 'approved' ? (
            <button
              onClick={() => actions.unapprove(group.id)}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
            >
              ✓ Approved — undo
            </button>
          ) : decision === 'rejected' ? (
            <button
              onClick={() => actions.unreject(group.id)}
              className="rounded-md bg-black/10 px-3 py-1.5 text-xs font-medium hover:bg-black/20 dark:bg-white/10"
            >
              Rejected — undo
            </button>
          ) : (
            <>
              <button
                onClick={() => actions.approve(group.id)}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
              >
                Approve
              </button>
              <button
                onClick={() => actions.reject(group.id)}
                className="rounded-md bg-black/10 px-3 py-1.5 text-xs font-medium hover:bg-black/20 dark:bg-white/10 dark:hover:bg-white/20"
              >
                Reject
              </button>
            </>
          )}
        </div>
      </div>

      <div className="px-4 pb-1 -mt-1">
        <ContextLine group={group} entryMap={entryMap} />
      </div>

      {group.reasons.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-4 pb-2.5">
          {group.reasons.map((r, i) => (
            <span
              key={i}
              className="rounded bg-black/5 px-1.5 py-0.5 text-xs opacity-70 dark:bg-white/10"
            >
              {r}
            </span>
          ))}
        </div>
      )}

      {/* Alternatives: a prominent, obvious control — the core of navigating choices. */}
      {hasAlts && (
        <button
          onClick={() => setAltOpen((v) => !v)}
          className={`flex w-full items-center gap-2 border-t px-4 py-2 text-left text-xs font-semibold transition ${
            altOpen
              ? 'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300'
              : 'border-black/5 bg-amber-500/5 text-amber-700 hover:bg-amber-500/10 dark:border-white/5 dark:text-amber-400'
          }`}
        >
          <span className="grid h-4 w-4 place-items-center rounded-full bg-amber-500/20 text-[10px]">
            {altCount}
          </span>
          {altOpen ? 'Hide alternatives' : `Compare ${altCount} ways to clear this amount`}
          <span className="ml-auto opacity-60">{altOpen ? '▾' : '▸'}</span>
        </button>
      )}

      {altOpen && siblings && siblings.length > 1 && (
        <AltCombos siblings={siblings} entryMap={entryMap} targetAbs={targetAbs} />
      )}

      {open && <MemberTable group={group} entryMap={entryMap} />}
    </div>
  );
}

/** Memoized: only rows whose decision (or group identity) changed re-render. */
const GroupRow = memo(GroupRowInner);
export default GroupRow;
