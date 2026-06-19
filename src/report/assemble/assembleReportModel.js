import { ENGINE_VERSION } from '../../core/index.js'
import { compareToBaseline } from '../baseline/compare.js'
import { polarityFor } from '../baseline/polarity.js'
import {
  cfdAreaChart,
  distributionBarChart,
  doraBandGaugeChart,
  sparklineChart,
  stackedBarChart,
  trendLineChart,
} from '../charts/index.js'
import { resolvePeriod, shiftDay } from '../model/period.js'

import { getPreset } from '../registry/index.js'
import { isPercentUnit } from '../render/units.js'

function latestNonNull(snaps) {
  for (let i = snaps.length - 1; i >= 0; i--) {
    const s = snaps[i]
    if (s !== undefined && s.value !== null) return s
  }
  return null
}

async function buildChart(spec, series, value, thresholds, band) {
  if (spec.chart === undefined) return null
  // '%' metrics store a ratio in [0,1]; scale the value, series and threshold
  // markers together so the chart axis and its band lines stay in one space
  // (matching the percent the cell text shows). See render/units.js.
  const scale = isPercentUnit(spec.unit) ? 100 : 1
  const chartValue = value === null || !Number.isFinite(value) ? value : value * scale
  const chartThresholds = (thresholds ?? []).map((t) => ({ ...t, at: t.at * scale }))
  const points = series.map((p) => ({
    label: p.day,
    value: p.value === null || !Number.isFinite(p.value) ? p.value : p.value * scale,
  }))
  switch (spec.chart) {
    case 'trend':
      return trendLineChart({ title: spec.label, points, yTitle: spec.unit })
    case 'sparkline':
      return sparklineChart({ title: spec.label, points })
    case 'distribution_bar':
      return distributionBarChart({ title: spec.label, bars: points, yTitle: spec.unit })
    case 'dora_band_gauge':
      return doraBandGaugeChart({
        title: spec.label,
        value: chartValue,
        unit: spec.unit,
        thresholds: chartThresholds,
        band,
      })
    case 'cfd_area':
      // CFD needs status-bucketed data not present in scalar snapshots; degrade to alt.
      return cfdAreaChart({ title: spec.label, points: [] })
    case 'stacked_bar':
      // The per-bucket work-type split (feature/bug/debt/other) lives on the
      // FlowDistributionResult, not in the scalar daily snapshot we persist (which
      // carries only the completed-issue total). We therefore render the allocation
      // as a stacked-bar of the per-period TOTAL completed, which still gives the
      // operator the period-over-period investment volume; the per-type breakdown
      // degrades to the chart's text alt rather than fabricating a split we did not
      // store. (A future snapshot schema carrying the buckets would fill the stack.)
      return stackedBarChart({
        title: spec.label,
        points: series
          .filter((p) => p.value !== null)
          .map((p) => ({ category: p.day, group: 'completed', value: p.value * scale })),
        yTitle: spec.unit,
      })
    default:
      return null
  }
}

async function assembleCell(opts, preset, spec, from, to, baselineFrom, baselineTo) {
  const { store, scope } = opts
  const currentSnaps = (
    await store.getSnapshots(scope.type, scope.id, spec.metricId, from, to)
  ).filter((s) => !s.isStale)
  const baselineSnaps = (
    await store.getSnapshots(scope.type, scope.id, spec.metricId, baselineFrom, baselineTo)
  ).filter((s) => !s.isStale)

  const series = currentSnaps.map((s) => ({ day: s.day, value: s.value }))
  const latest = latestNonNull(currentSnaps)
  const value = latest?.value ?? null
  const baselineValues = baselineSnaps.map((s) => s.value)

  const comparison = compareToBaseline({ value, baselineValues })
  const trustTier = latest?.trustTier ?? 'deterministic'
  const dataQuality = value === null ? 'no_data' : (latest?.dataQuality ?? 'ok')

  // Benchmarks: team/org scope only, never person scope.
  //
  // Proxy gating is driven by the SNAPSHOT'S provenance, not the preset. The
  // preset's `proxy: true` flag now means proxy-CAPABLE — "this DORA metric
  // could rest on a heuristic" — and a snapshot computed from a real deploy feed
  // (dataSource === 'real') overrides it so a genuine band can render. A missing
  // dataSource (NULL / non-DORA) is treated as proxy (conservative). Suppression
  // logic itself stays entirely in benchmark/dora.ts.
  const isProxy = spec.proxy === true && (latest?.dataSource ?? 'proxy') !== 'real'
  const benchmark =
    preset.personScope === true || spec.benchmark !== true || opts.benchmark === undefined
      ? undefined
      : (opts.benchmark.lookup({
          metricId: spec.metricId,
          value,
          scopeType: scope.type,
          proxy: isProxy,
        }) ?? undefined)

  const thresholds = opts.benchmark?.thresholds?.(spec.metricId) ?? []
  const chart = await buildChart(spec, series, value, thresholds, benchmark?.band ?? null)

  return {
    cell: {
      metricId: spec.metricId,
      label: spec.label,
      value,
      unit: spec.unit,
      trustTier,
      dataQuality,
      polarity: polarityFor(spec.metricId),
      formulaDoc: '',
      series,
      comparison,
      benchmark,
      // Reflect the EFFECTIVE provenance (real data clears the proxy badge), not
      // the preset's proxy-capable flag.
      proxy: isProxy,
    },
    chart,
  }
}

async function assembleSection(
  opts,
  preset,
  spec,
  from,
  to,
  baselineFrom,
  baselineTo,
  periodLabel,
) {
  const results = await Promise.all(
    spec.metrics.map((m) => assembleCell(opts, preset, m, from, to, baselineFrom, baselineTo)),
  )
  const cells = results.map((r) => r.cell)
  const charts = results.map((r) => r.chart).filter((c) => c !== null)

  // AI narrative: advisory, team/org only, never person scope, only when provided.
  let narrative = null
  if (preset.personScope !== true && opts.narrative !== undefined) {
    narrative = await opts.narrative.forSection({
      sectionTitle: spec.title,
      scope: opts.scope,
      periodLabel,
      cells: cells.map((c) => ({
        label: c.label,
        metricId: c.metricId,
        value: c.value,
        comparison: c.comparison ?? {
          baselineP50: null,
          delta: null,
          deltaPct: null,
          band: 'unknown',
          trendArrow: 'steady',
          zScore: null,
          percentileWithin: null,
          n: 0,
          significant: false,
          note: null,
        },
      })),
    })
  }

  return {
    id: spec.id,
    title: spec.title,
    purpose: spec.purpose,
    cells,
    charts,
    narrative,
    caveats: spec.caveats ?? [],
  }
}

/** Assemble a full ReportModel for a preset + scope + period from stored snapshots. */
export async function assembleReportModel(opts) {
  const preset = getPreset(opts.presetKey)
  if (preset === null) throw new Error(`unknown report preset: ${opts.presetKey}`)

  const period = resolvePeriod({
    cadence: preset.cadence,
    periodEnd: opts.periodEnd,
    windowDays: opts.windowDays,
    sprintFrom: opts.sprintFrom,
    sprintTo: opts.sprintTo,
  })

  const baselineDays = opts.baselineDays ?? 90
  const baselineTo = shiftDay(period.from, -1)
  const baselineFrom = shiftDay(baselineTo, -(baselineDays - 1))

  const sections = await Promise.all(
    preset.sections.map((s) =>
      assembleSection(
        opts,
        preset,
        s,
        period.from,
        period.to,
        baselineFrom,
        baselineTo,
        period.label,
      ),
    ),
  )

  // Provenance: uniform trust tier across cells with data, else 'mixed'.
  const allCells = sections.flatMap((s) => s.cells)
  const tiers = [...new Set(allCells.filter((c) => c.value !== null).map((c) => c.trustTier))]
  const trustTier = tiers.length === 0 ? 'deterministic' : tiers.length === 1 ? tiers[0] : 'mixed'
  const anyData = allCells.some((c) => c.value !== null)

  return {
    presetKey: preset.key,
    title: preset.title,
    audience: preset.audience,
    scope: opts.scope,
    period,
    generatedAt: opts.now,
    provenance: {
      asOf: opts.now,
      engineVersion: ENGINE_VERSION,
      trustTier,
      dataQuality: anyData ? 'ok' : 'no_data',
      coverageFingerprint: opts.coverageFingerprint ?? null,
    },
    sections,
    blindSpots: preset.blindSpots ?? [],
    personScope: preset.personScope === true,
  }
}
