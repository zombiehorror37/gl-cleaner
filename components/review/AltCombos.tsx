'use client';
import { fromCents } from '@/lib/engine/cents';
import { type Entry, type MatchGroup } from '@/lib/engine/types';
import { useStore } from '@/lib/store';
import ConfidenceBadge from './ConfidenceBadge';

/**
 * Alternative clearing combos for one target. Every sibling here offsets the
 * SAME target entry(ies), so they mutually conflict — picking one is a
 * single-choice: approving it unapproves any other sibling first, so the
 * target is never double-counted.
 */
export default function AltCombos({
  siblings,
  entryMap,
}: {
  siblings: MatchGroup[];
  entryMap: Map<number, Entry>;
}) {
  const approved = useStore((s) => s.approved);
  const rejected = useStore((s) => s.rejected);
  const approve = useStore((s) => s.approve);
  const unapprove = useStore((s) => s.unapprove);
  const reject = useStore((s) => s.reject);
  const unreject = useStore((s) => s.unreject);

  const pick = (id: string) => {
    for (const s of siblings) if (s.id !== id && approved.has(s.id)) unapprove(s.id);
    approve(id);
  };

  const offsetSummary = (g: MatchGroup) => {
    const amts = g.offsetIds.map((id) => entryMap.get(id)?.amount ?? 0);
    const shown = amts.slice(0, 6).map((a) => fromCents(a)).join(' + ');
    return amts.length > 6 ? `${shown} + …(${amts.length - 6} more)` : shown;
  };

  const ordered = [...siblings].sort(
    (a, b) => b.confidence - a.confidence || a.offsetIds.length - b.offsetIds.length || a.id.localeCompare(b.id),
  );

  return (
    <div className="space-y-1.5 border-t border-black/5 bg-black/[0.02] px-4 py-2.5 dark:border-white/5 dark:bg-white/[0.02]">
      <p className="text-xs font-medium opacity-70">
        {siblings.length} ways to clear this amount — pick one:
      </p>
      {ordered.map((g) => {
        const isApproved = approved.has(g.id);
        const isRejected = rejected.has(g.id);
        return (
          <div
            key={g.id}
            className={`flex flex-wrap items-center gap-2 rounded-lg border px-3 py-1.5 text-xs ${
              isApproved
                ? 'border-emerald-500/50 bg-emerald-500/10'
                : isRejected
                  ? 'border-red-500/30 opacity-50'
                  : 'border-black/10 dark:border-white/10'
            }`}
          >
            <ConfidenceBadge tier={g.tier} confidence={g.confidence} />
            <span className="opacity-60">{g.offsetIds.length} entries:</span>
            <span className="font-mono">{offsetSummary(g)}</span>
            {g.reasons[0] && <span className="opacity-50">· {g.reasons[0]}</span>}
            <div className="ml-auto flex gap-1.5">
              {isApproved ? (
                <button
                  onClick={() => unapprove(g.id)}
                  className="rounded bg-emerald-600 px-2 py-0.5 font-semibold text-white hover:bg-emerald-500"
                >
                  ✓ chosen — undo
                </button>
              ) : (
                <>
                  <button
                    onClick={() => pick(g.id)}
                    className="rounded bg-emerald-600 px-2 py-0.5 font-semibold text-white hover:bg-emerald-500"
                  >
                    Use this
                  </button>
                  {isRejected ? (
                    <button
                      onClick={() => unreject(g.id)}
                      className="rounded bg-black/10 px-2 py-0.5 hover:bg-black/20 dark:bg-white/10"
                    >
                      un-reject
                    </button>
                  ) : (
                    <button
                      onClick={() => reject(g.id)}
                      className="rounded bg-black/10 px-2 py-0.5 hover:bg-black/20 dark:bg-white/10"
                    >
                      reject
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
