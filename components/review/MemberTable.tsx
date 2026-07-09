'use client';
import { fromCents } from '@/lib/engine/cents';
import { groupEntryIds, type Entry, type MatchGroup } from '@/lib/engine/types';

/**
 * Member rows of a group, rendered in the fixed GL-header column order so every
 * detail view reads the same way: Side · Date · Doc No · Type · Account ·
 * Account Name · Reference · Description · Amount.
 */
export default function MemberTable({
  group,
  entryMap,
}: {
  group: MatchGroup;
  entryMap: Map<number, Entry>;
}) {
  const ids = groupEntryIds(group);
  const members = ids.map((id) => entryMap.get(id)!).filter(Boolean);
  const targetSet = new Set(group.targetIds);
  const cell = (v: string | null | undefined) => (v ? v : '—');
  return (
    <div className="max-h-96 overflow-auto border-t border-black/5 dark:border-white/5">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-white text-[11px] uppercase tracking-wide opacity-70 dark:bg-zinc-950">
          <tr>
            <th className="px-3 py-1.5">Side</th>
            <th className="px-3 py-1.5">Date</th>
            <th className="px-3 py-1.5">Doc No</th>
            <th className="px-3 py-1.5">Type</th>
            <th className="px-3 py-1.5">Account</th>
            <th className="px-3 py-1.5">Account Name</th>
            <th className="px-3 py-1.5">Reference</th>
            <th className="px-3 py-1.5">Description</th>
            <th className="px-3 py-1.5 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {members.map((e) => {
            const isTarget = targetSet.has(e.id);
            return (
              <tr key={e.id} className="border-t border-black/5 dark:border-white/5">
                <td className="px-3 py-1.5">
                  <span
                    className={
                      isTarget
                        ? 'font-semibold text-red-600 dark:text-red-400'
                        : 'text-emerald-700 dark:text-emerald-400'
                    }
                  >
                    {isTarget ? 'reversal' : 'offset'}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-1.5">
                  {e.date ? new Date(e.date).toLocaleDateString() : '—'}
                </td>
                <td className="whitespace-nowrap px-3 py-1.5">{cell(e.docNo)}</td>
                <td className="whitespace-nowrap px-3 py-1.5">{cell(e.docType)}</td>
                <td className="whitespace-nowrap px-3 py-1.5">{cell(e.account)}</td>
                <td className="max-w-40 truncate px-3 py-1.5">{cell(e.accountName)}</td>
                <td className="whitespace-nowrap px-3 py-1.5">{cell(e.reference)}</td>
                <td className="max-w-72 truncate px-3 py-1.5">{cell(e.description)}</td>
                <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono">
                  {fromCents(e.amount)}
                </td>
              </tr>
            );
          })}
          <tr className="border-t border-black/10 font-semibold dark:border-white/10">
            <td colSpan={8} className="px-3 py-1.5 text-right">
              Group total ({members.length} rows)
            </td>
            <td className="px-3 py-1.5 text-right font-mono">
              {fromCents(members.reduce((s, e) => s + e.amount, 0))}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
