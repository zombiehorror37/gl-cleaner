'use client';
import { useId, type ReactNode } from 'react';
import { KIND_LABEL, type GroupKind, type ScoreBreakdown, type Tier } from '@/lib/engine/types';
import { FAMILY, KIND_META, STATUS_META, TIER_LABEL, type Family, type ReviewStatus } from '@/lib/review-meta';
import { cx } from '@/components/ui';

/** Family colours: one hue per family, used for tags, legend dots and row accents. */
export const FAMILY_STYLE: Record<Family, { tag: string; dot: string; bar: string }> = {
  document: { tag: 'bg-sky-500/10 text-sky-800 ring-sky-500/30 dark:text-sky-300', dot: 'bg-sky-500', bar: 'bg-sky-500' },
  amount: { tag: 'bg-violet-500/10 text-violet-800 ring-violet-500/30 dark:text-violet-300', dot: 'bg-violet-500', bar: 'bg-violet-500' },
  judgement: { tag: 'bg-amber-500/15 text-amber-900 ring-amber-500/40 dark:text-amber-300', dot: 'bg-amber-500', bar: 'bg-amber-500' },
  neutral: { tag: 'bg-zinc-500/10 text-zinc-700 ring-zinc-500/30 dark:text-zinc-300', dot: 'bg-zinc-400', bar: 'bg-zinc-400' },
};

export const TIER_DOT: Record<Tier, string> = { high: 'bg-emerald-500', medium: 'bg-amber-500', low: 'bg-rose-500' };

export const STATUS_STYLE: Record<ReviewStatus, string> = {
  suggested: 'text-sky-700 dark:text-sky-300',
  review: 'text-amber-700 dark:text-amber-300',
  approved: 'text-emerald-700 dark:text-emerald-400',
  dismissed: 'text-zinc-500',
  blocked: 'text-zinc-500',
};

/** The one tag shape. Renders a button (with pressed state) when it filters. */
export function Tag({
  children,
  className,
  title,
  onClick,
  active,
  count,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  onClick?: () => void;
  active?: boolean;
  count?: number;
}) {
  const cls = cx(
    'inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-xs font-medium ring-1 ring-inset',
    className ?? 'bg-black/5 text-black/70 ring-black/10 dark:bg-white/10 dark:text-white/70 dark:ring-white/15',
    onClick && 'cursor-pointer transition hover:brightness-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:hover:brightness-125',
    active && 'ring-2 ring-indigo-500',
  );
  const body = (
    <>
      {children}
      {count !== undefined && <span className="tabular-nums opacity-60">{count}</span>}
    </>
  );
  return onClick ? (
    <button type="button" className={cls} title={title} onClick={onClick} aria-pressed={active}>
      {body}
    </button>
  ) : (
    <span className={cls} title={title}>
      {body}
    </span>
  );
}

export function KindTag({ kind, onClick, active, count }: { kind: GroupKind; onClick?: () => void; active?: boolean; count?: number }) {
  const fam = KIND_META[kind].family;
  return (
    <Tag className={FAMILY_STYLE[fam].tag} title={`${FAMILY[fam].label}: ${KIND_META[kind].description}${onClick ? ' (click to filter)' : ''}`} onClick={onClick} active={active} count={count}>
      {KIND_LABEL[kind]}
    </Tag>
  );
}

export function TierTag({ tier, score, onClick, active, count }: { tier: Tier; score?: number; onClick?: () => void; active?: boolean; count?: number }) {
  return (
    <Tag title={`${TIER_LABEL[tier]} confidence${score !== undefined ? ` (${score}/100)` : ''}. ${TIER_SCALE}${onClick ? ' Click to filter.' : ''}`} onClick={onClick} active={active} count={count}>
      <span className={cx('h-2 w-2 rounded-full', TIER_DOT[tier])} />
      {TIER_LABEL[tier]}
      {score !== undefined && <span className="tabular-nums opacity-60">{score}</span>}
    </Tag>
  );
}

export function StatusTag({ status, onClick, active, count }: { status: ReviewStatus; onClick?: () => void; active?: boolean; count?: number }) {
  return (
    <Tag className={cx('bg-transparent ring-black/10 dark:ring-white/15', STATUS_STYLE[status])} title={STATUS_META[status].description} onClick={onClick} active={active} count={count}>
      {STATUS_META[status].label}
    </Tag>
  );
}

export function FamilyDot({ family }: { family: Family }) {
  return <span className={cx('inline-block h-2.5 w-2.5 shrink-0 rounded-full', FAMILY_STYLE[family].dot)} />;
}

/**
 * Confidence tag with an explanation on hover / keyboard focus: the starting
 * score for this kind of match, each piece of corroborating evidence, any
 * ceiling, and what the tiers mean.
 */
export function ScoreTag({
  tier,
  score,
  breakdown,
  onClick,
  active,
}: {
  tier: Tier;
  score: number;
  breakdown: ScoreBreakdown;
  onClick?: () => void;
  active?: boolean;
}) {
  const id = useId();
  const raw = breakdown.base + breakdown.parts.reduce((a, p) => a + p.points, 0);
  return (
    <span className="group/score relative inline-flex">
      <span aria-describedby={id} className="inline-flex">
        <Tag onClick={onClick} active={active}>
          <span className={cx('h-2 w-2 rounded-full', TIER_DOT[tier])} />
          {TIER_LABEL[tier]}
          <span className="tabular-nums opacity-60">{score}</span>
        </Tag>
      </span>
      <span
        id={id}
        role="tooltip"
        className="pointer-events-none invisible absolute left-0 top-full z-30 mt-1.5 w-80 rounded-lg border border-black/10 bg-white p-3 text-xs opacity-0 shadow-lg transition-opacity delay-150 group-focus-within/score:visible group-focus-within/score:opacity-100 group-hover/score:visible group-hover/score:opacity-100 dark:border-white/15 dark:bg-zinc-900"
      >
        <span className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
          <span className={cx('h-2 w-2 rounded-full', TIER_DOT[tier])} />
          {TIER_LABEL[tier]} confidence: {score} / 100
        </span>
        <span className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
          <span>{breakdown.basis}</span>
          <span className="text-right font-mono tabular-nums">{breakdown.base}</span>
          {breakdown.parts.map((p, i) => (
            <span key={i} className="contents">
              <span className="opacity-80">{p.label}</span>
              <span className="text-right font-mono tabular-nums text-emerald-700 dark:text-emerald-400">+{p.points}</span>
            </span>
          ))}
          {breakdown.parts.length === 0 && breakdown.base < 100 && <span className="col-span-2 opacity-60">No corroborating evidence found (reference, wording, document types or dates).</span>}
          {breakdown.cap !== null && (
            <>
              <span className="opacity-80">Ceiling for this kind of match</span>
              <span className="text-right font-mono tabular-nums text-rose-700 dark:text-rose-400">−{raw - breakdown.cap}</span>
            </>
          )}
          <span className="border-t border-black/10 pt-1 font-semibold dark:border-white/15">Score</span>
          <span className="border-t border-black/10 pt-1 text-right font-mono font-semibold tabular-nums dark:border-white/15">{score}</span>
        </span>
        <span className="mt-2 block opacity-60">
          {TIER_SCALE}
          {onClick && ` Click to show only ${TIER_LABEL[tier].toLowerCase()}-confidence matches.`}
        </span>
      </span>
    </span>
  );
}

export const TIER_SCALE = 'High = 75 or more · Medium = 50 to 74 · Low = below 50.';
