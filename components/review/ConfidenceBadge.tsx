import type { ConfidenceTier } from '@/lib/engine/types';

const STYLES: Record<ConfidenceTier, string> = {
  high: 'bg-emerald-600/15 text-emerald-700 dark:text-emerald-400',
  medium: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  low: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-400',
};

const DOT: Record<ConfidenceTier, string> = {
  high: 'bg-emerald-500',
  medium: 'bg-amber-500',
  low: 'bg-zinc-400',
};

export const BAR: Record<ConfidenceTier, string> = {
  high: 'bg-emerald-500',
  medium: 'bg-amber-500',
  low: 'bg-zinc-400',
};

export default function ConfidenceBadge({
  tier,
  confidence,
}: {
  tier: ConfidenceTier;
  confidence: number;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold ${STYLES[tier]}`}
      title={`${tier} confidence — score ${confidence}/100`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${DOT[tier]}`} />
      {tier.toUpperCase()} {confidence}
    </span>
  );
}

/** Horizontal confidence meter for comparing alternatives at a glance. */
export function ConfidenceBar({ tier, confidence }: { tier: ConfidenceTier; confidence: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
        <span
          className={`block h-full rounded-full ${BAR[tier]}`}
          style={{ width: `${Math.max(4, confidence)}%` }}
        />
      </span>
      <span className="w-7 text-right font-mono text-xs tabular-nums opacity-70">{confidence}</span>
    </span>
  );
}
