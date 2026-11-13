export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * Exponential approach of `current` to `target` over `dtMs` with time constant `tauMs`.
 * The result is always between the two values, never past the target; with `tauMs` of 0 it is the target.
 */
export function approach(current: number, target: number, dtMs: number, tauMs: number): number {
  if (tauMs <= 0) return target;
  if (!(dtMs > 0)) return current;
  const k = 1 - Math.exp(-dtMs / tauMs);
  const next = current + (target - current) * k;
  // Rounding must not step over the target.
  return target >= current ? Math.min(next, target) : Math.max(next, target);
}
