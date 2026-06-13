import { max as d3max, min as d3min } from 'd3-array'
import { scaleBand, scaleLinear, scalePoint } from 'd3-scale'
import { area as d3area, line as d3line, stack as d3stack } from 'd3-shape'
import {
  CHART_CONFIG,
  escapeXml,
  legendRow,
  MARGIN,
  round,
  seriesColor,
  svgRoot,
  xCategoryAxis,
  yGridAxis,
} from './render.js'

export { CHART_CONFIG } from './render.js'

function fmtNum(v) {
  if (v === null || !Number.isFinite(v)) return 'n/a'
  return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2).replace(/\.00$/, '')
}

const DEFAULT_W = 480
const DEFAULT_H = 180
// Top inset for charts that carry a legend row (multi-series).
const LEGEND_TOP = 26

/** Pivot flat {category, group, value} rows into one row per category. */
function pivot(points, catKey, groupKey, valKey, categories, groups) {
  const byCat = new Map(categories.map((c) => [c, { [catKey]: c }]))
  for (const p of points) {
    const row = byCat.get(p[catKey])
    row[p[groupKey]] = (row[p[groupKey]] ?? 0) + p[valKey]
  }
  return categories.map((c) => {
    const row = byCat.get(c)
    for (const g of groups) if (row[g] == null) row[g] = 0
    return row
  })
}

/** A time/period trend line. */
export async function trendLineChart(opts) {
  // Filter to FINITE values, not just non-null: undefined/NaN would slip past a
  // `!== null` check, make d3min/d3max return undefined, and produce SVG paths
  // with literal 'NaN' coordinates (a silently-blank chart).
  const values = opts.points
    .filter((p) => Number.isFinite(p.value))
    .map((p) => ({ label: p.label, value: p.value }))
  const alt = `${opts.title} trend — ${
    values.length === 0 ? 'no data' : values.map((v) => `${v.label}: ${fmtNum(v.value)}`).join('; ')
  }`
  if (values.length === 0) return { kind: 'trend', title: opts.title, svg: '', alt }

  const width = opts.width ?? DEFAULT_W
  const height = opts.height ?? DEFAULT_H
  const { left, top, right, bottom } = MARGIN
  const innerW = width - left - right
  const innerH = height - top - bottom
  const x = scalePoint()
    .domain(values.map((v) => v.label))
    .range([left, left + innerW])
  const y = scaleLinear()
    .domain([
      Math.min(
        0,
        d3min(values, (v) => v.value),
      ),
      d3max(values, (v) => v.value),
    ])
    .nice()
    .range([top + innerH, top])

  const path = d3line()
    .x((v) => x(v.label))
    .y((v) => y(v.value))(values)
  const dots = values
    .map(
      (v) =>
        `<circle cx="${round(x(v.label))}" cy="${round(y(v.value))}" r="2.5" fill="${CHART_CONFIG.primary}"/>`,
    )
    .join('')
  const body =
    yGridAxis(y, left, innerW) +
    xCategoryAxis(x, top + innerH) +
    `<path d="${path}" fill="none" stroke="${CHART_CONFIG.primary}" stroke-width="2"/>` +
    dots
  return { kind: 'trend', title: opts.title, svg: svgRoot(width, height, body), alt }
}

/** A compact, axis-less sparkline. */
export async function sparklineChart(opts) {
  // Finite-only (see trendLineChart): guards d3min/d3max against undefined/NaN.
  const values = opts.points
    .filter((p) => Number.isFinite(p.value))
    .map((p, i) => ({ i, value: p.value }))
  const alt = `${opts.title} sparkline — ${
    values.length === 0 ? 'no data' : values.map((v) => fmtNum(v.value)).join(', ')
  }`
  if (values.length === 0) return { kind: 'sparkline', title: opts.title, svg: '', alt }

  const width = 160
  const height = 36
  const pad = 3
  const x = scalePoint()
    .domain(values.map((v) => v.i))
    .range([pad, width - pad])
  const y = scaleLinear()
    .domain([d3min(values, (v) => v.value), d3max(values, (v) => v.value)])
    .range([height - pad, pad])
  const path = d3line()
    .x((v) => x(v.i))
    .y((v) => y(v.value))(values)
  const body = `<path d="${path}" fill="none" stroke="${CHART_CONFIG.primary}" stroke-width="1.5"/>`
  return { kind: 'sparkline', title: opts.title, svg: svgRoot(width, height, body), alt }
}

/** Categorical bars (e.g. work-type distribution, aging buckets). */
export async function distributionBarChart(opts) {
  const values = opts.bars
    .filter((b) => b.value !== null)
    .map((b) => ({ label: b.label, value: b.value }))
  const alt = `${opts.title} — ${
    values.length === 0 ? 'no data' : values.map((v) => `${v.label}: ${fmtNum(v.value)}`).join('; ')
  }`
  if (values.length === 0) return { kind: 'distribution_bar', title: opts.title, svg: '', alt }

  const width = opts.bars.length > 6 ? DEFAULT_W : 360
  const height = DEFAULT_H
  const { left, top, right, bottom } = MARGIN
  const innerW = width - left - right
  const innerH = height - top - bottom
  const baseY = top + innerH
  const x = scaleBand()
    .domain(values.map((v) => v.label))
    .range([left, left + innerW])
    .padding(0.2)
  const y = scaleLinear()
    .domain([0, d3max(values, (v) => v.value) ?? 0])
    .nice()
    .range([baseY, top])

  const bars = values
    .map(
      (v) =>
        `<rect x="${round(x(v.label))}" y="${round(y(v.value))}" width="${round(x.bandwidth())}" height="${round(baseY - y(v.value))}" fill="${CHART_CONFIG.primary}"/>`,
    )
    .join('')
  const body = yGridAxis(y, left, innerW) + bars + xCategoryAxis(x, baseY)
  return { kind: 'distribution_bar', title: opts.title, svg: svgRoot(width, height, body), alt }
}

/** Stacked bars (e.g. work-type mix across periods). */
export async function stackedBarChart(opts) {
  const values = opts.points
  const groups = [...new Set(values.map((v) => v.group))]
  const categories = [...new Set(values.map((v) => v.category))]
  const alt = `${opts.title} — stacked by ${groups.join(', ') || 'n/a'} across ${
    categories.length
  } periods`
  if (values.length === 0) return { kind: 'stacked_bar', title: opts.title, svg: '', alt }

  const width = DEFAULT_W
  const height = DEFAULT_H
  const { left, right, bottom } = MARGIN
  const top = LEGEND_TOP
  const innerW = width - left - right
  const innerH = height - top - bottom
  const baseY = top + innerH

  const rows = pivot(values, 'category', 'group', 'value', categories, groups)
  const series = d3stack().keys(groups)(rows)
  const maxTotal = d3max(rows, (r) => groups.reduce((s, g) => s + r[g], 0)) ?? 0
  const x = scaleBand()
    .domain(categories)
    .range([left, left + innerW])
    .padding(0.2)
  const y = scaleLinear().domain([0, maxTotal]).nice().range([baseY, top])

  const rects = series
    .map((s, si) =>
      s
        .map(
          (seg) =>
            `<rect x="${round(x(seg.data.category))}" y="${round(y(seg[1]))}" width="${round(x.bandwidth())}" height="${round(y(seg[0]) - y(seg[1]))}" fill="${seriesColor(si)}"/>`,
        )
        .join(''),
    )
    .join('')
  const body =
    yGridAxis(y, left, innerW) +
    rects +
    xCategoryAxis(x, baseY) +
    legendRow(
      groups.map((g, i) => ({ label: g, color: seriesColor(i) })),
      left,
      12,
    )
  return { kind: 'stacked_bar', title: opts.title, svg: svgRoot(width, height, body), alt }
}

/** Cumulative Flow Diagram — stacked area of status counts over days. */
export async function cfdAreaChart(opts) {
  const values = opts.points
  const statuses = [...new Set(values.map((v) => v.status))]
  const days = [...new Set(values.map((v) => v.day))]
  const alt = `${opts.title} — cumulative flow across ${days.length} days, statuses: ${
    statuses.join(', ') || 'n/a'
  }`
  if (values.length === 0) return { kind: 'cfd_area', title: opts.title, svg: '', alt }

  const width = DEFAULT_W
  const height = DEFAULT_H
  const { left, right, bottom } = MARGIN
  const top = LEGEND_TOP
  const innerW = width - left - right
  const innerH = height - top - bottom
  const baseY = top + innerH

  const rows = pivot(values, 'day', 'status', 'count', days, statuses)
  const series = d3stack().keys(statuses)(rows)
  const maxTotal = d3max(rows, (r) => statuses.reduce((s, st) => s + r[st], 0)) ?? 0
  const x = scalePoint()
    .domain(days)
    .range([left, left + innerW])
  const y = scaleLinear().domain([0, maxTotal]).nice().range([baseY, top])

  const areaGen = d3area()
    .x((d) => x(d.data.day))
    .y0((d) => y(d[0]))
    .y1((d) => y(d[1]))
  const paths = series
    .map((s, si) => `<path d="${areaGen(s)}" fill="${seriesColor(si)}" fill-opacity="0.85"/>`)
    .join('')
  const body =
    yGridAxis(y, left, innerW) +
    paths +
    xCategoryAxis(x, baseY) +
    legendRow(
      statuses.map((st, i) => ({ label: st, color: seriesColor(i) })),
      left,
      12,
    )
  return { kind: 'cfd_area', title: opts.title, svg: svgRoot(width, height, body), alt }
}

/**
 * DORA-style band gauge: a value bar with band-threshold rules. The band label
 * itself is computed upstream (benchmark layer); this only visualises position.
 */
export async function doraBandGaugeChart(opts) {
  const alt = `${opts.title}: ${fmtNum(opts.value)} ${opts.unit}${
    opts.band ? ` — band: ${opts.band}` : ''
  }`
  if (opts.value === null) {
    return { kind: 'dora_band_gauge', title: opts.title, svg: '', alt }
  }

  const width = 360
  const height = 56
  const left = 8
  const right = 16
  const barY = 18
  const barH = 18
  const innerW = width - left - right
  const maxThreshold = d3max(opts.thresholds, (t) => t.at) ?? 0
  const x = scaleLinear()
    .domain([0, Math.max(opts.value, maxThreshold, 0)])
    .nice()
    .range([left, left + innerW])

  const unitLabel = `<text x="${left}" y="12" font-size="11" fill="${CHART_CONFIG.labelColor}">${escapeXml(opts.unit ?? '')}</text>`
  const track = `<rect x="${left}" y="${barY}" width="${innerW}" height="${barH}" rx="3" fill="${CHART_CONFIG.gridColor}"/>`
  const valueBar = `<rect x="${left}" y="${barY}" width="${round(x(opts.value) - left)}" height="${barH}" rx="3" fill="${CHART_CONFIG.primary}"/>`
  const rules = opts.thresholds
    .map((t) => {
      const px = round(x(t.at))
      return (
        `<line x1="${px}" x2="${px}" y1="${barY - 4}" y2="${barY + barH + 4}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="4 2"/>` +
        `<text x="${px}" y="${barY + barH + 14}" text-anchor="middle" font-size="10" fill="${CHART_CONFIG.labelColor}">${escapeXml(t.label)}</text>`
      )
    })
    .join('')
  const body = unitLabel + track + valueBar + rules
  return { kind: 'dora_band_gauge', title: opts.title, svg: svgRoot(width, height, body), alt }
}
