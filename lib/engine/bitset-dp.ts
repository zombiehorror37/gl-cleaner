import { gcd } from './cents';

/** Max bitset size we allow (in bits) — 4M bits = 512KB per oracle run. */
const MAX_BITS = 4_000_000;

export type OracleVerdict = 'reachable' | 'unreachable' | 'too-large';

/**
 * Subset-sum reachability oracle. Proves whether ANY subset of `values`
 * (unbounded size) sums exactly to `target`. Values and target are first
 * reduced by their common GCD (GL amounts are frequently multiples of 100),
 * which usually shrinks the state space by 2 orders of magnitude.
 *
 * 'unreachable' is a mathematical proof of no match (at any combo size).
 * 'too-large' means the reduced target exceeds MAX_BITS and no proof is made.
 */
export function subsetSumReachable(values: number[], target: number): OracleVerdict {
  if (target === 0) return 'reachable';
  const usable = values.filter((v) => v > 0 && v <= target);
  if (usable.length === 0) return 'unreachable';

  let g = target;
  for (const v of usable) {
    g = gcd(g, v);
    if (g === 1) break;
  }
  const t = target / g;
  if (t > MAX_BITS) return 'too-large';

  const words = (t >>> 5) + 1;
  const dp = new Uint32Array(words);
  dp[0] = 1; // sum 0 reachable

  for (const raw of usable) {
    const v = raw / g;
    // dp |= dp << v
    const wordShift = v >>> 5;
    const bitShift = v & 31;
    if (bitShift === 0) {
      for (let i = words - 1; i >= wordShift; i--) {
        dp[i] |= dp[i - wordShift];
      }
    } else {
      for (let i = words - 1; i >= wordShift; i--) {
        const lo = dp[i - wordShift] << bitShift;
        const hi = i - wordShift - 1 >= 0 ? dp[i - wordShift - 1] >>> (32 - bitShift) : 0;
        dp[i] |= lo | hi;
      }
    }
    if ((dp[t >>> 5] >>> (t & 31)) & 1) return 'reachable';
  }
  return (dp[t >>> 5] >>> (t & 31)) & 1 ? 'reachable' : 'unreachable';
}
