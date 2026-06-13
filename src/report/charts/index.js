import { renderVegaLiteToSvg } from './render.js'

export { CHART_CONFIG, renderVegaLiteToSvg } from './render.js'

function fmtNum(v) {
  if (v === null || !Number.isFinite(v)) return 'n/a'
  return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2).replace(/\.00$/, '')
}

const DEFAULT_W = 480
const DEFAULT_H = 180

/** A time/period trend line. */
export async function trendLineChart(opts) {
  const values = opts.points
    .filter((p) => p.value !== null)
    .map((p) => ({ label: p.label, value: p.value }))
  const alt = `${opts.title} trend — ${
    values.length === 0 ? 'no data' : values.map((v) => `${v.label}: ${fmtNum(v.value)}`).join('; ')
  }`
  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    width: opts.width ?? DEFAULT_W,
    height: opts.height ?? DEFAULT_H,
    data: { values },
    mark: { type: 'line', point: true, color: '#0072B2' },
    encoding: {
      x: { field: 'label', type: 'ordinal', title: null, axis: { labelAngle: 0 } },
      y: { field: 'value', type: 'quantitative', title: opts.yTitle ?? null },
    },
  }
  const svg = values.length > 0 ? await renderVegaLiteToSvg(spec) : ''
  return { kind: 'trend', title: opts.title, svg, alt }
}

/** A compact, axis-less sparkline. */
export async function sparklineChart(opts) {
  const values = opts.points.filter((p) => p.value !== null).map((p, i) => ({ i, value: p.value }))
  const alt = `${opts.title} sparkline — ${
    values.length === 0 ? 'no data' : values.map((v) => fmtNum(v.value)).join(', ')
  }`
  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    width: 160,
    height: 36,
    data: { values },
    mark: { type: 'line', color: '#0072B2', strokeWidth: 1.5 },
    encoding: {
      x: { field: 'i', type: 'quantitative', axis: null },
      y: { field: 'value', type: 'quantitative', axis: null },
    },
  }
  const svg = values.length > 0 ? await renderVegaLiteToSvg(spec) : ''
  return { kind: 'sparkline', title: opts.title, svg, alt }
}

/** Categorical bars (e.g. work-type distribution, aging buckets). */
export async function distributionBarChart(opts) {
  const values = opts.bars
    .filter((b) => b.value !== null)
    .map((b) => ({ label: b.label, value: b.value }))
  const alt = `${opts.title} — ${
    values.length === 0 ? 'no data' : values.map((v) => `${v.label}: ${fmtNum(v.value)}`).join('; ')
  }`
  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    width: opts.bars.length > 6 ? DEFAULT_W : 360,
    height: DEFAULT_H,
    data: { values },
    mark: { type: 'bar', color: '#0072B2' },
    encoding: {
      x: { field: 'label', type: 'nominal', title: null, axis: { labelAngle: 0 } },
      y: { field: 'value', type: 'quantitative', title: opts.yTitle ?? null },
    },
  }
  const svg = values.length > 0 ? await renderVegaLiteToSvg(spec) : ''
  return { kind: 'distribution_bar', title: opts.title, svg, alt }
}

/** Stacked bars (e.g. work-type mix across periods). */
export async function stackedBarChart(opts) {
  const values = opts.points.map((p) => ({ ...p }))
  const groups = [...new Set(values.map((v) => v.group))]
  const alt = `${opts.title} — stacked by ${groups.join(', ') || 'n/a'} across ${
    new Set(values.map((v) => v.category)).size
  } periods`
  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    width: DEFAULT_W,
    height: DEFAULT_H,
    data: { values },
    mark: 'bar',
    encoding: {
      x: { field: 'category', type: 'nominal', title: null, axis: { labelAngle: 0 } },
      y: { field: 'value', type: 'quantitative', title: opts.yTitle ?? null, stack: true },
      color: { field: 'group', type: 'nominal', title: null },
    },
  }
  const svg = values.length > 0 ? await renderVegaLiteToSvg(spec) : ''
  return { kind: 'stacked_bar', title: opts.title, svg, alt }
}

/** Cumulative Flow Diagram — stacked area of status counts over days. */
export async function cfdAreaChart(opts) {
  const values = opts.points.map((p) => ({ ...p }))
  const statuses = [...new Set(values.map((v) => v.status))]
  const days = [...new Set(values.map((v) => v.day))]
  const alt = `${opts.title} — cumulative flow across ${days.length} days, statuses: ${
    statuses.join(', ') || 'n/a'
  }`
  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    width: DEFAULT_W,
    height: DEFAULT_H,
    data: { values },
    mark: 'area',
    encoding: {
      x: { field: 'day', type: 'temporal', title: null },
      y: { field: 'count', type: 'quantitative', title: null, stack: true },
      color: { field: 'status', type: 'nominal', title: null },
    },
  }
  const svg = values.length > 0 ? await renderVegaLiteToSvg(spec) : ''
  return { kind: 'cfd_area', title: opts.title, svg, alt }
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
  const spec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    width: 360,
    height: 56,
    layer: [
      {
        data: { values: [{ v: opts.value }] },
        mark: { type: 'bar', color: '#0072B2', height: 18 },
        encoding: { x: { field: 'v', type: 'quantitative', title: opts.unit } },
      },
      {
        data: { values: opts.thresholds.map((t) => ({ t: t.at, label: t.label })) },
        mark: { type: 'rule', color: '#94a3b8', strokeDash: [4, 2] },
        encoding: { x: { field: 't', type: 'quantitative' } },
      },
    ],
  }
  const svg = await renderVegaLiteToSvg(spec)
  return { kind: 'dora_band_gauge', title: opts.title, svg, alt }
}
