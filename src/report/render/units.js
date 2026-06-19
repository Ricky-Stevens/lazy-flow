/**
 * Unit-aware presentation helpers shared by every renderer (markdown, html,
 * csv) and the chart builder.
 *
 * Metric modules emit ratios in [0,1] (e.g. change_failure_rate = 0.08) but
 * several preset specs present them with unit '%'. The raw ratio is what the
 * model carries (so baseline comparison, benchmark band lookup and chart math
 * all stay in one consistent space); the ratio→percent conversion happens ONLY
 * at the presentation boundary, here, so '8%' is never rendered as '0.08 %'.
 */

/** True for the percentage unit, whose stored value is a ratio in [0,1]. */
export function isPercentUnit(unit) {
  return unit === '%'
}

/**
 * Convert a stored metric value to the number actually shown for its unit.
 * Percentages are scaled ×100; every other unit is shown verbatim. Returns the
 * value unchanged when it is null/non-finite so callers can format the gap.
 */
export function toDisplayValue(value, unit) {
  if (value === null || !Number.isFinite(value)) return value
  return isPercentUnit(unit) ? value * 100 : value
}

/**
 * Format a metric value as display text, unit-aware.
 *   - null / non-finite           → '—'
 *   - integers                    → verbatim
 *   - |v| >= 100                  → whole number
 *   - otherwise                   → up to 2 dp, trailing zeros trimmed
 * The '%' unit is scaled to percent and rendered with no space ('8%'); other
 * non-count units are appended with a space ('55800 s'); 'count' is bare.
 */
export function fmtValue(value, unit) {
  if (value === null || !Number.isFinite(value)) return '—'
  const display = toDisplayValue(value, unit)
  let s
  if (Number.isInteger(display)) s = String(display)
  else if (Math.abs(display) >= 100) s = display.toFixed(0)
  else s = display.toFixed(2).replace(/\.?0+$/, '')
  if (isPercentUnit(unit)) return `${s}%`
  return unit && unit !== 'count' ? `${s} ${unit}` : s
}
