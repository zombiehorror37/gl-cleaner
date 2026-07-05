import type { ConfidenceTier } from '@/lib/engine/types';

const STYLES: Record<ConfidenceTier, string> = {
  high: 'bg-emerald-600/15 text-emerald-700 dark:text-emerald-400',
  medium: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  low: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-400',
};

export default function ConfidenceBadge({
  tier,
  confidence,
}: {
  tier: ConfidenceTier;
  confidence: number;
}) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STYLES[tier]}`}>
      {tier.toUpperCase()} {confidence}
    </span>
  );
}
