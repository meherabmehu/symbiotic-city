/**
 * Summary statistics over the criticality ranking.
 *
 * The API returns the full ranked list plus fleet-level *counts*; the mean,
 * peak and floor are derived here rather than at each call site, so every
 * screen quotes the same numbers from the same rows. The parameter is
 * structural so both `CriticalityIndex` and the resilience page's own
 * response type can call it.
 */
export function criticalityStats(
  index: { ranking: { criticality_index: number }[] } | null | undefined,
): {
  scored: number;
  mean: number;
  peak: number;
  floor: number;
} {
  const values = (index?.ranking ?? []).map((row) => row.criticality_index);
  if (values.length === 0) return { scored: 0, mean: 0, peak: 0, floor: 0 };
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    scored: values.length,
    mean: total / values.length,
    peak: Math.max(...values),
    floor: Math.min(...values),
  };
}
