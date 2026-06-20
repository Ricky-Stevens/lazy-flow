/**
 * Unit-aware presentation helpers shared by every renderer (markdown, html,
 * csv) and the chart builder.
 *
 * The model carries every metric value in its CANONICAL computation unit so
 * baseline comparison, benchmark band lookup and chart math all stay in one
 * consistent space. Two presentation transforms happen ONLY here, at the
 * rendering boundary:
 *
 *   1. Ratios. Metric modules emit ratios in [0,1] (e.g. change_failure_rate =
 *      0.08) but several preset specs present them with unit '%'. '8%' is never
 *      rendered as '0.08 %'.
 *
 *   2. Durations. Every duration metric (cycle time, lead time, recovery time,
 *      review latency, aging WIP, …) emits SECONDS. Presets present them in a
 *      coarser human unit ('hours', 'days', 'minutes', 'weeks'). Without a
 *      conversion here a p50 cycle time of 172800 s was rendered "172800 hours"
 *      (a ×3600 error) — a ship-blocking lie for a metrics tool. The model keeps
 *      seconds; the divide-down happens at the boundary, exactly like ratios.
 */

/** True for the percentage unit, whose stored value is a ratio in [0,1]. */
export function isPercentUnit(unit) {
  return unit === '%'
}

/**
 * Seconds-per-unit for the duration units a preset may declare. The stored
 * value is always seconds; dividing by these yields the displayed magnitude.
 * 'seconds'/'s' are identity. Units NOT in this map (counts, ratios, points,
 * index, per day, …) are left untouched.
 */
const SECONDS_PER_DURATION_UNIT = {
  seconds: 1,
  s: 1,
  minutes: 60,
  min: 60,
  hours: 3600,
  h: 3600,
  days: 86400,
  d: 86400,
  weeks: 604800,
}

/** True when `unit` denotes a duration whose stored value is in seconds. */
export function isDurationUnit(unit) {
  return Object.hasOwn(SECONDS_PER_DURATION_UNIT, unit)
}

/**
 * Convert a stored metric value to the number actually shown for its unit.
 *   - '%'        → ratio ×100
 *   - durations  → seconds ÷ (seconds-per-unit)
 *   - everything else → verbatim
 * Returns the value unchanged when it is null/non-finite so callers can format
 * the gap.
 */
export function toDisplayValue(value, unit) {
  if (value === null || !Number.isFinite(value)) return value
  if (isPercentUnit(unit)) return value * 100
  if (isDurationUnit(unit)) return value / SECONDS_PER_DURATION_UNIT[unit]
  return value
}

/**
 * Format a metric value as display text, unit-aware.
 *   - null / non-finite           → '—'
 *   - integers                    → verbatim
 *   - |v| >= 100                  → whole number
 *   - otherwise                   → up to 2 dp, trailing zeros trimmed
 * The '%' unit is scaled to percent and rendered with no space ('8%'); other
 * non-count units are appended with a space ('48 hours', '55800 s'); 'count' is
 * bare. Duration units are divided down to their human magnitude first.
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
