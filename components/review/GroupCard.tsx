'use client';
import { memo } from 'react';
import { KIND_LABEL, type MatchGroup, type LedgerRow } from '@/lib/engine/types';
import { DOC_CLASS_LABEL } from '@/lib/parse/doc-class';
import { formatCents } from '@/lib/parse/values';
import { Badge, Button, cx } from '@/components/ui';

export type GroupStatus = 'pending' | 'approved' | 'dismissed' | 'blocked';

export interface GroupActions {
  approve: (ids: string[]) => void;
  unapprove: (id: string) => void;
  dismiss: (id: string) => void;
  undismiss: (id: string) => void;
}

const TIER_TONE = { high: 'good', medium: 'warn', low: 'bad' } as const;

const STATUS_STYLE: Record<GroupStatus, string> = {
  pending: 'border-black/10 dark:border-white/10',
  approved: 'border-emerald-500/50 bg-emerald-500/[0.04]',
  dismissed: 'border-black/10 opacity-55 dark:border-white/10',
  blocked: 'border-black/10 opacity-55 dark:border-white/10',
};

function GroupCardImpl({
  group,
  rowsById,
  status,
  precision,
  actions,
  contactLabel,
}: {
  group: MatchGroup;
  rowsById: Map<number, LedgerRow>;
  status: GroupStatus;
  precision: number;
  actions: GroupActions;
  contactLabel?: string;
}) {
  const fmt = (c: number) => formatCents(c, precision);
  const members = group.memberIds.map((id) => rowsById.get(id)!);
  const from = group.residualFromId !== null ? rowsById.get(group.residualFromId) : null;

  return (
    <div className={cx('rounded-xl border p-3 transition', STATUS_STYLE[status])}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs opacity-60">{group.id}</span>
        <Badge tone="accent">{KIND_LABEL[group.kind]}</Badge>
        <Badge tone={TIER_TONE[group.tier]} title="Confidence score (0–100)">
          {group.tier} · {group.confidence}
        </Badge>
        {group.suggested && <Badge tone="info">suggested</Badge>}
        {group.individualOnly && <Badge tone="warn">approve individually</Badge>}
        {contactLabel && <span className="truncate text-sm font-medium">{contactLabel}</span>}
        <div className="ml-auto flex items-center gap-1.5">
          {status === 'approved' && (
            <>
              <Badge tone="good">✓ approved</Badge>
              <Button size="sm" variant="ghost" onClick={() => actions.unapprove(group.id)}>
                Undo
              </Button>
            </>
          )}
          {status === 'dismissed' && (
            <>
              <Badge>dismissed</Badge>
              <Button size="sm" variant="ghost" onClick={() => actions.undismiss(group.id)}>
                Undo
              </Button>
            </>
          )}
          {status === 'blocked' && <Badge title="A line in this match is already in an approved match">blocked by another approval</Badge>}
          {status === 'pending' && (
            <>
              <Button size="sm" variant="good" onClick={() => actions.approve([group.id])}>
                Approve
              </Button>
              <Button size="sm" variant="ghost" onClick={() => actions.dismiss(group.id)}>
                Dismiss
              </Button>
            </>
          )}
        </div>
      </div>

      <ul className="mt-1.5 list-disc pl-5 text-sm opacity-80">
        {group.reasons.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
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
                <td className="max-w-64 truncate py-1 pr-3" title={m.description ?? ''}>
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
  );
}

export const GroupCard = memo(GroupCardImpl);
