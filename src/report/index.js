/**
 * @lazy-flow/report — preset report generation (HTML / Markdown / CSV / JSON).
 *
 * Local, export-artifact model: produces self-contained files a human shares.
 * USP code only — charts (vega-lite), templating (eta), CSV (csv-stringify) are deps.
 */

// Assembly + generation

export { assembleReportModel, generateReport } from './assemble/index.js'
// Baseline + comparison layer

export {
  BASELINE_VERSION,
  baselineToStats,
  buildBaselineRecord,
  classifyDrift,
  compareToBaseline,
  compareToStats,
  MIN_BASELINE_N,
  MIN_BASELINE_SPRINTS,
  percentileRank,
  polarityFor,
  robustSd,
  summarize,
} from './baseline/index.js'
// Industry benchmarks (DORA)
export { buildBenchmarkProvider, DORA_SOURCE } from './benchmark/index.js'
// Charts (vega-lite → inline SVG)

export {
  CHART_CONFIG,
  cfdAreaChart,
  distributionBarChart,
  doraBandGaugeChart,
  renderVegaLiteToSvg,
  sparklineChart,
  stackedBarChart,
  trendLineChart,
} from './charts/index.js'
// Period resolution

export { resolvePeriod } from './model/period.js'
// Model contract

// Registry

export { getPreset, listPresets, PRESETS } from './registry/index.js'

// Renderers
export { renderCsv, toCsv } from './render/csv.js'
export { renderHtml } from './render/html.js'
export { renderJson, toJson } from './render/json.js'
export { renderMarkdown } from './render/markdown.js'
export { REPORT_CSS } from './render/theme.js'
