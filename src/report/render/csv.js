import { stringify } from 'csv-stringify/sync'

/** RFC-4180 CSV from a list of flat records (escaping handled by csv-stringify). */
export function toCsv(rows) {
  if (rows.length === 0) return ''
  return stringify(rows, {
    header: true,
    // null/undefined render as empty cells; everything else stringified.
    cast: {
      boolean: (v) => (v ? 'true' : 'false'),
    },
  })
}

/** Flatten a ReportModel into one CSV row per metric cell, carrying provenance columns. */
export function renderCsv(model) {
  const rows = []
  for (const section of model.sections) {
    for (const cell of section.cells) {
      rows.push({
        section: section.title,
        metric_id: cell.metricId,
        label: cell.label,
        value: cell.value,
        unit: cell.unit,
        trust_tier: cell.trustTier,
        data_quality: cell.dataQuality,
        polarity: cell.polarity,
        proxy: cell.proxy ?? false,
        baseline_p50: cell.comparison?.baselineP50 ?? null,
        delta: cell.comparison?.delta ?? null,
        band: cell.comparison?.band ?? null,
        baseline_n: cell.comparison?.n ?? null,
        significant: cell.comparison?.significant ?? null,
        benchmark_source: cell.benchmark?.source ?? null,
        benchmark_band: cell.benchmark?.band ?? null,
        benchmark_suppressed: cell.benchmark?.suppressed ?? null,
        engine_version: model.provenance.engineVersion,
        as_of: model.provenance.asOf,
        coverage_fingerprint: model.provenance.coverageFingerprint ?? null,
      })
    }
  }
  return toCsv(rows)
}
