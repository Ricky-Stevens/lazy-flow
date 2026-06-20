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
import { toDisplayValue } from '../render/units.js'

function latestNonNull(snaps) {
  for (let i = snaps.length - 1; i >= 0; i--) {
    const s = snaps[i]
    if (s !== undefined && s.value !== null) return s
  }
  return null
}

async function buildChart(spec, series, value, thresholds, band) {
  if (spec.chart === undefined) return null
  // The model stores values in their canonical unit ('%' as a [0,1] ratio,
  // durations in seconds). Scale the value, series and threshold markers
  // together through the SAME presentation transform the cell text uses, so the
  // chart axis (labelled spec.unit) and its band lines sit in the displayed
  // space rather than plotting raw seconds under an "hours" axis. See
  // render/units.js.
  const toDisplay = (v) => (v === null || !Number.isFinite(v) ? v : toDisplayValue(v, spec.unit))
  const chartValue = toDisplay(value)
  const chartThresholds = (thresholds ?? []).map((t) => ({
    ...t,
    at: toDisplayValue(t.at, spec.unit),
  }))
  const points = series.map((p) => ({
    label: p.day,
    value: toDisplay(p.value),
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
          .map((p) => ({ category: p.day, group: 'completed', value: toDisplay(p.value) })),
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

  let series = currentSnaps.map((s) => ({ day: s.day, value: s.value }))
  let latest = latestNonNull(currentSnaps)
  const baselineValues = baselineSnaps.map((s) => s.value)

  // Person-scope live fallback. The sync pipeline only persists team/org
  // snapshots — person-scope snapshots are never written — so a person preset
  // (e.g. annual:person) would otherwise render an all-no_data report despite
  // get_person_report being able to compute these metrics live. When the scope
  // is person/self and there are no stored snapshots, compute the metric live
  // for the period (a single point series) so the report is not an empty facade.
  if (
    currentSnaps.length === 0 &&
    (scope.type === 'person' || scope.type === 'self') &&
    typeof opts.liveCompute === 'function'
  ) {
    const live = await opts.liveCompute(spec.metricId, scope, from, to)
    if (live && live.value !== null && live.value !== undefined) {
      series = [{ day: to, value: live.value }]
      latest = {
        value: live.value,
        trustTier: live.trustTier ?? 'deterministic',
        dataQuality: live.dataQuality ?? 'ok',
        dataSource: live.dataSource ?? null,
      }
    }
  }
  const value = latest?.value ?? null

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
  // The benchmark provider's contract (see benchmark/dora.js) is that `value`
  // arrives already normalised to the metric's DISPLAY unit — lead_time and
  // recovery_time are stored in SECONDS but their preset unit is 'hours', and
  // change_failure_rate is stored as a [0,1] ratio but presented as '%'. Pass
  // the raw seconds and an elite 6h lead time (21600 s) is compared against the
  // <24h threshold as `21600 < 24` → always banded 'low'. Convert through the
  // SAME presentation transform the chart and cell text use so the band, the
  // gauge and the displayed number all agree.
  const benchValue = value === null ? null : toDisplayValue(value, spec.unit)
  const benchmark =
    preset.personScope === true || spec.benchmark !== true || opts.benchmark === undefined
      ? undefined
      : (opts.benchmark.lookup({
          metricId: spec.metricId,
          value: benchValue,
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
