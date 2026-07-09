'use client';
import { useState } from 'react';
import { fromCents } from '@/lib/engine/cents';
import { type Entry, type MatchGroup } from '@/lib/engine/types';
import { useStore } from '@/lib/store';
import { ConfidenceBar } from './ConfidenceBadge';
import MemberTable from './MemberTable';

/**
 * Alternative clearing combos for one target. Every sibling offsets the SAME
 * target entry(ies), so they mutually conflict — this is a single-choice
 * picker: choosing one un-picks any other sibling first, so the target is never
 * double-counted. Options are laid out as a ranked comparison so the reviewer
 * can weigh confidence, size and reasons side by side.
 */
export default function AltCombos({
  siblings,
  entryMap,
  targetAbs,
}: {
  siblings: MatchGroup[];
  entryMap: Map<number, Entry>;
  targetAbs: number;
}) {
  const approved = useStore((s) => s.approved);
  const rejected = useStore((s) => s.rejected);
  const approve = useStore((s) => s.approve);
  const unapprove = useStore((s) => s.unapprove);
  const reject = useStore((s) => s.reject);
  const unreject = useStore((s) => s.unreject);
  const [expanded, setExpanded] = useState<string | null>(null);

  const pick = (id: string) => {
    for (const s of siblings) if (s.id !== id && approved.has(s.id)) unapprove(s.id);
    approve(id);
  };

  const ordered = [...siblings].sort(
    (a, b) =>
      b.confidence - a.confidence ||
      a.offsetIds.length - b.offsetIds.length ||
      a.id.localeCompare(b.id),
  );
  const best = ordered[0]?.confidence ?? 0;

  const offsetSummary = (g: MatchGroup) => {
    const amts = g.offsetIds.map((id) => entryMap.get(id)?.amount ?? 0);
    const shown = amts.slice(0, 6).map((a) => fromCents(a)).join(' + ');
    return amts.length > 6 ? `${shown} + …(${amts.length - 6} more)` : shown;
  };

  return (
    <div className="border-t border-black/5 bg-black/[0.02] px-4 py-3 dark:border-white/5 dark:bg-white/[0.02]">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide opacity-60">
        {siblings.length} ways to clear ±{fromCents(targetAbs)} — pick one
      </p>
      <div className="space-y-1.5">
        {ordered.map((g, i) => {
          const isApproved = approved.has(g.id);
          const isRejected = rejected.has(g.id);
          const isOpen = expanded === g.id;
          const delta = g.confidence - best;
          return (
            <div
              key={g.id}
              className={`rounded-lg border transition ${
                isApproved
                  ? 'border-emerald-500/60 bg-emerald-500/10'
                  : isRejected
                    ? 'border-red-500/30 opacity-50'
                    : 'border-black/10 bg-white/40 dark:border-white/10 dark:bg-white/[0.03]'
              }`}
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 text-xs">
                <span
                  className={`w-20 shrink-0 font-semibold ${
                    i === 0 ? 'text-indigo-600 dark:text-indigo-300' : 'opacity-60'
                  }`}
                >
                  {i === 0 ? 'Best match' : `Alt ${i + 1}`}
                </span>
                <ConfidenceBar tier={g.tier} confidence={g.confidence} />
                {i > 0 && delta < 0 && (
                  <span className="rounded bg-black/5 px-1.5 py-0.5 font-mono text-[11px] opacity-60 dark:bg-white/10">
                    {delta} vs best
                  </span>
                )}
                <span className="opacity-50">{g.offsetIds.length} entries</span>
                <span className="font-mono opacity-80">{offsetSummary(g)}</span>
                {g.reasons[0] && (
                  <span className="rounded bg-black/5 px-1.5 py-0.5 opacity-70 dark:bg-white/10">
                    {g.reasons[0]}
                  </span>
                )}
                <div className="ml-auto flex items-center gap-1.5">
                  <button
                    onClick={() => setExpanded(isOpen ? null : g.id)}
                    className="rounded px-2 py-0.5 opacity-60 hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
                  >
                    {isOpen ? 'hide rows ▾' : 'view rows ▸'}
                  </button>
                  {isApproved ? (
                    <button
                      onClick={() => unapprove(g.id)}
                      className="rounded bg-emerald-600 px-2.5 py-1 font-semibold text-white hover:bg-emerald-500"
                    >
                      ✓ chosen
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={() => pick(g.id)}
                        className="rounded bg-emerald-600 px-2.5 py-1 font-semibold text-white hover:bg-emerald-500"
                      >
                        Use this
                      </button>
                      {isRejected ? (
                        <button
                          onClick={() => unreject(g.id)}
                          className="rounded bg-black/10 px-2 py-1 hover:bg-black/20 dark:bg-white/10"
                        >
                          un-reject
                        </button>
                      ) : (
                        <button
                          onClick={() => reject(g.id)}
                          className="rounded bg-black/10 px-2 py-1 hover:bg-black/20 dark:bg-white/10"
                        >
                          reject
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
              {isOpen && (
                <div className="rounded-b-lg bg-white/60 dark:bg-black/20">
                  <MemberTable group={g} entryMap={entryMap} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
