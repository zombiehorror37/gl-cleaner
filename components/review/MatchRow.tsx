'use client';
import { memo } from 'react';
import type { LedgerRow, MatchGroup, Tier, GroupKind } from '@/lib/engine/types';
import { DOC_CLASS_LABEL } from '@/lib/parse/doc-class';
import { formatCents } from '@/lib/parse/values';
import { KIND_META, type ReviewStatus } from '@/lib/review-meta';
import { cx } from '@/components/ui';
import { FAMILY_STYLE, KindTag, ScoreTag, StatusTag } from './Tags';

export interface MatchActions {
  approve: (ids: string[]) => void;
  unapprove: (id: string) => void;
  dismiss: (id: string) => void;
  undismiss: (id: string) => void;
}

export interface MatchFilters {
  kind: (k: GroupKind) => void;
  tier: (t: Tier) => void;
  status: (s: ReviewStatus) => void;
  contact?: (key: string) => void;
}

const descOf = (rs: LedgerRow[]) => rs.find((r) => r.description)?.description ?? null;

const ids = (rs: LedgerRow[]) => {
  const uniq = [...new Set(rs.map((r) => r.transactionId))];
  return uniq.length <= 2 ? uniq.join(', ') : `${uniq.slice(0, 2).join(', ')} +${uniq.length - 2}`;
};

function MatchRowImpl({
  group,
  rowsById,
  status,
  precision,
  expanded,
  focused,
  onToggle,
  onFocus,
  actions,
  filters,
  activeKind,
  activeTier,
  contactLabel,
  blockedBy,
}: {
  group: MatchGroup;
  rowsById: Map<number, LedgerRow>;
  status: ReviewStatus;
  precision: number;
  expanded: boolean;
  focused: boolean;
  onToggle: (id: string) => void;
  onFocus: (id: string) => void;
  actions: MatchActions;
  filters: MatchFilters;
  activeKind: boolean;
  activeTier: boolean;
  contactLabel?: string;
  blockedBy?: string;
}) {
  const fmt = (c: number) => formatCents(c, precision);
  const members = group.memberIds.map((id) => rowsById.get(id)!);
  const plus = members.filter((m) => m.net > 0);
  const minus = members.filter((m) => m.net < 0);
  const gross = plus.reduce((s, m) => s + m.net, 0);
  const from = group.residualFromId !== null ? rowsById.get(group.residualFromId) : null;
  const fam = KIND_META[group.kind].family;
  const pending = status === 'suggested' || status === 'review';
  const dim = status === 'dismissed' || status === 'blocked';

  return (
    <div
      id={`match-${group.id}`}
      onMouseDown={() => onFocus(group.id)}
      className={cx(
        'relative rounded-lg border bg-white transition dark:bg-zinc-900/60',
        status === 'approved' ? 'border-emerald-500/40' : 'border-black/10 dark:border-white/10',
        focused && 'ring-2 ring-indigo-500/70',
        dim && 'opacity-60',
      )}
    >
      <span className={cx('absolute -left-px -top-px -bottom-px w-1 rounded-l-lg', FAMILY_STYLE[fam].bar)} aria-hidden />
      <div className="grid grid-cols-[1.5rem_3.25rem_7rem_6rem_minmax(0,1fr)_8rem_10.5rem] items-center gap-x-3 py-1.5 pl-3 pr-2 text-sm">
        <button
          type="button"
          onClick={() => onToggle(group.id)}
          aria-expanded={expanded}
          aria-label={expanded ? 'Collapse' : 'Expand'}
          className="grid h-6 w-6 place-items-center rounded hover:bg-black/5 dark:hover:bg-white/10"
        >
          <span className={cx('inline-block text-[10px] transition-transform', expanded && 'rotate-90')}>▶</span>
        </button>
        <span className="font-mono text-xs opacity-60">{group.id}</span>
        <span>
          <KindTag kind={group.kind} onClick={() => filters.kind(group.kind)} active={activeKind} />
        </span>
        <span>
          <ScoreTag tier={group.tier} score={group.confidence} breakdown={group.score} onClick={() => filters.tier(group.tier)} active={activeTier} />
        </span>
        <div className="min-w-0">
          <button type="button" onClick={() => onToggle(group.id)} className="block w-full truncate text-left font-mono text-xs" title={members.map((m) => m.transactionId).join(', ')}>
            {plus.length && minus.length ? (
              <>
                {ids(plus)} <span className="opacity-40">↔</span> {ids(minus)}
              </>
            ) : (
              ids(members)
            )}
          </button>
          <div className="flex min-w-0 items-center gap-1.5 text-xs opacity-60">
            {contactLabel && (
              <>
                <button type="button" className="shrink-0 font-medium hover:underline" title={`Show only ${contactLabel}`} onClick={() => filters.contact?.(group.contactKey)}>
                  {contactLabel}
                </button>
                <span aria-hidden>·</span>
              </>
            )}
            <span className="shrink-0">{members.length} lines</span>
            {(descOf(plus) || descOf(minus)) && (
              <>
                <span aria-hidden>·</span>
                <span className="truncate" title={members.map((m) => m.description ?? '').join(' | ')}>
                  {plus.length && minus.length ? `${descOf(plus) ?? '—'} ↔ ${descOf(minus) ?? '—'}` : descOf(members)}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="text-right font-mono text-xs tabular-nums">
          <div>{fmt(gross)}</div>
          <div className={cx(group.residual ? 'text-amber-700 dark:text-amber-400' : 'opacity-40')} title={group.residual ? `Stays open on ${from?.transactionId}` : 'Nets to zero'}>
            {group.residual ? `open ${fmt(group.residual)}` : 'nets 0'}
          </div>
        </div>
        <span className="flex items-center justify-end gap-1">
          {pending ? (
            <>
              <button
                type="button"
                onClick={() => actions.approve([group.id])}
                className="h-7 rounded-md bg-emerald-600 px-2.5 text-xs font-semibold text-white hover:bg-emerald-500"
                title="Approve (a)"
              >
                Approve
              </button>
              <button type="button" onClick={() => actions.dismiss(group.id)} className="h-7 rounded-md px-2 text-xs font-medium opacity-70 hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10" title="Dismiss (d)">
                Dismiss
              </button>
            </>
          ) : (
            <>
              <StatusTag status={status} onClick={() => filters.status(status)} />
              {status === 'approved' && (
                <button type="button" onClick={() => actions.unapprove(group.id)} className="h-7 rounded-md px-2 text-xs opacity-70 hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10" title="Undo (u)">
                  Undo
                </button>
              )}
              {status === 'dismissed' && (
                <button type="button" onClick={() => actions.undismiss(group.id)} className="h-7 rounded-md px-2 text-xs opacity-70 hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10" title="Undo (u)">
                  Undo
                </button>
              )}
            </>
          )}
        </span>
      </div>

      {expanded && (
        <div className="border-t border-black/5 py-2 pl-12 pr-3 dark:border-white/5">
          <ul className="list-disc space-y-0.5 pl-4 text-sm opacity-80">
            {group.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
            {group.individualOnly && <li className="text-amber-700 dark:text-amber-400">Approve individually: never included in bulk approvals.</li>}
            {status === 'blocked' && blockedBy && <li>Blocked: a line is already in approved match {blockedBy}.</li>}
          </ul>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="opacity-60">
                <tr>
                  <th className="py-1 pr-3 font-medium">Row</th>
                  <th className="py-1 pr-3 font-medium">Transaction Id</th>
                  <th className="py-1 pr-3 font-medium">Type</th>
                  <th className="py-1 pr-3 font-medium">Effective</th>
                  <th className="py-1 pr-3 font-medium">Reference</th>
                  <th className="py-1 pr-3 font-medium">Description</th>
                  <th className="py-1 text-right font-medium">Net</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id} className={cx('border-t border-black/5 dark:border-white/5', from?.id === m.id && 'bg-amber-500/10')}>
                    <td className="py-1 pr-3 tabular-nums opacity-60">{m.sourceRow}</td>
                    <td className="py-1 pr-3 font-mono">{m.transactionId}</td>
                    <td className="py-1 pr-3" title={DOC_CLASS_LABEL[m.docClass]}>
                      {m.documentType ?? <span className="opacity-40">{DOC_CLASS_LABEL[m.docClass]}</span>}
                    </td>
                    <td className="whitespace-nowrap py-1 pr-3 tabular-nums">{m.effectiveDate ?? m.effectiveDateText ?? ''}</td>
                    <td className="max-w-40 truncate py-1 pr-3" title={m.reference ?? ''}>
                      {m.reference}
                    </td>
                    <td className="max-w-72 truncate py-1 pr-3" title={m.description ?? ''}>
                      {m.description}
                    </td>
                    <td className={cx('whitespace-nowrap py-1 text-right font-mono tabular-nums', m.net < 0 && 'text-red-600 dark:text-red-400')}>{fmt(m.net)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-black/15 dark:border-white/15">
                  <td colSpan={6} className="py-1 pr-3 text-right font-medium">
                    {group.residual === 0 ? 'Nets to' : `Stays open on ${from?.transactionId ?? '—'}`}
                  </td>
                  <td className={cx('py-1 text-right font-mono font-semibold tabular-nums', group.residual === 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400')}>
                    {fmt(group.residual)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export const MatchRow = memo(MatchRowImpl);
