import { describe, expect, it } from 'bun:test'

import { BunSqliteStore, migrate } from '../../core/index.js'
import { buildBenchmarkProvider } from '../benchmark/index.js'
import { assembleReportModel } from './assembleReportModel.js'
import { generateReport } from './generate.js'

function mkStore() {
  const store = new BunSqliteStore(':memory:')
  migrate(store.db)
  return store
}

async function seed(
  store,
  metric,
  day,
  value,
  scopeType = 'team',
  scopeId = 'platform',
  trustTier = 'deterministic',
  dataSource,
) {
  const snap = {
    scopeType,
    scopeId,
    metric,
    day,
    value,
    window: '30d',
    trustTier,
    dataQuality: value === null ? 'no_data' : 'ok',
    engineVersion: '0.1.0',
    ingestWatermarkVersion: '1',
    coverageFingerprint: 'cov-1',
    computedAt: `${day}T00:00:00.000Z`,
    isStale: false,
    dataSource,
  }
  await store.putSnapshot(snap)
}

describe('assembleReportModel', () => {
  it('assembles a monthly:team report with real snapshots + a significant comparison', async () => {
    const store = mkStore()
    // Baseline (Mar–Apr): cycle time steady ~4h.
    for (const d of [
      '2026-03-05',
      '2026-03-15',
      '2026-03-25',
      '2026-04-05',
      '2026-04-15',
      '2026-04-25',
    ]) {
      await seed(store, 'flow.cycle_time', d, 4)
    }
    // Current month (May): cycle time jumped to ~8h.
    await seed(store, 'flow.cycle_time', '2026-05-10', 7)
    await seed(store, 'flow.cycle_time', '2026-05-28', 8)
    // Some throughput in May too.
    await seed(store, 'flow.throughput', '2026-05-28', 12)

    const model = await assembleReportModel({
      store,
      presetKey: 'monthly:team',
      scope: { type: 'team', id: 'platform' },
      periodEnd: '2026-05-31',
      now: '2026-06-01T00:00:00.000Z',
    })

    expect(model.title).toBe('Monthly Delivery Report')
    expect(model.period.label).toBe('May 2026')
    expect(model.sections.length).toBeGreaterThan(0)

    // Find the cycle-time cell.
    const cycle = model.sections
      .flatMap((s) => s.cells)
      .find((c) => c.metricId === 'flow.cycle_time')
    expect(cycle?.value).toBe(8) // latest non-null in May
    expect(cycle?.comparison?.significant).toBe(true)
    expect(cycle?.comparison?.trendArrow).toBe('up')
    expect(cycle?.polarity).toBe('lower_better')

    // A metric with no snapshots degrades to no_data, not an error.
    const sayDo = model.sections.flatMap((s) => s.cells).find((c) => c.metricId === 'agile.say_do')
    expect(sayDo?.value).toBeNull()
    expect(sayDo?.dataQuality).toBe('no_data')

    // A trend chart was rendered for cycle time.
    const charts = model.sections.flatMap((s) => s.charts)
    expect(charts.some((c) => c.kind === 'trend' && c.svg.startsWith('<svg'))).toBe(true)
    store.close()
  })

  it('sprint:team renders an Investment Allocation stacked-bar from flow_distribution', async () => {
    const store = mkStore()
    // Completed-issue totals across the sprint window drive the allocation stack.
    await seed(store, 'flow.flow_distribution', '2026-05-20', 6)
    await seed(store, 'flow.flow_distribution', '2026-05-28', 9)

    const model = await assembleReportModel({
      store,
      presetKey: 'sprint:team',
      scope: { type: 'team', id: 'platform' },
      periodEnd: '2026-05-31',
      now: '2026-06-01T00:00:00.000Z',
    })

    const investment = model.sections.find((s) => s.id === 'investment')
    expect(investment).toBeDefined()
    const cell = investment?.cells.find((c) => c.metricId === 'flow.flow_distribution')
    expect(cell?.value).toBe(9) // latest non-null in the window
    // The stacked-bar chart rendered with the period totals.
    const stacked = investment?.charts.find((c) => c.kind === 'stacked_bar')
    expect(stacked).toBeDefined()
    expect(stacked?.svg.startsWith('<svg')).toBe(true)
    store.close()
  })

  it('generateReport renders HTML end-to-end', async () => {
    const store = mkStore()
    await seed(store, 'flow.cycle_time', '2026-05-28', 5)
    const res = await generateReport(
      {
        store,
        presetKey: 'monthly:team',
        scope: { type: 'team', id: 'platform' },
        periodEnd: '2026-05-31',
        now: '2026-06-01T00:00:00.000Z',
      },
      'html',
    )
    expect(res.ext).toBe('html')
    expect(res.content.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(res.content).toContain('Monthly Delivery Report')
    store.close()
  })

  it('is reproducible — same inputs render byte-identical HTML (incl. charts)', async () => {
    const store = mkStore()
    for (const d of ['2026-03-10', '2026-04-10', '2026-05-10', '2026-05-20', '2026-05-28']) {
      await seed(store, 'flow.cycle_time', d, 5)
    }
    const opts = {
      store,
      presetKey: 'monthly:team',
      scope: { type: 'team', id: 'platform' },
      periodEnd: '2026-05-31',
      now: '2026-06-01T00:00:00.000Z',
    }
    const a = await generateReport(opts, 'html')
    const b = await generateReport(opts, 'html')
    expect(a.content).toBe(b.content)
    store.close()
  })

  it('throws on an unknown preset', async () => {
    const store = mkStore()
    await expect(
      assembleReportModel({
        store,
        presetKey: 'nope:nope',
        scope: { type: 'team', id: 'x' },
        periodEnd: '2026-05-31',
        now: '2026-06-01T00:00:00.000Z',
      }),
    ).rejects.toThrow(/unknown report preset/)
    store.close()
  })

  it('person-scope reports never call the benchmark or narrative providers', async () => {
    const store = mkStore()
    await seed(store, 'flow.cycle_time', '2026-05-28', 5, 'person', 'alice')

    let benchmarkCalled = false
    let narrativeCalled = false
    const benchmark = {
      lookup() {
        benchmarkCalled = true
        return null
      },
    }
    const narrative = {
      async forSection() {
        narrativeCalled = true
        return null
      },
    }

    const model = await assembleReportModel({
      store,
      presetKey: 'annual:person',
      scope: { type: 'person', id: 'alice' },
      periodEnd: '2026-12-31',
      now: '2027-01-01T00:00:00.000Z',
      benchmark,
      narrative,
    })

    expect(model.personScope).toBe(true)
    expect(benchmarkCalled).toBe(false)
    expect(narrativeCalled).toBe(false)
    // Person reports declare the appraisal boundary up-front.
    expect(model.blindSpots.join(' ')).toContain('Not for appraisal')
    store.close()
  })

  it('person-scope cells fall back to liveCompute when no snapshots exist (not an empty facade)', async () => {
    // Sync never persists person-scope snapshots, so without a live fallback the
    // annual:person preset renders all-no_data. The injected liveCompute must
    // populate the cells so the advertised person report actually has content.
    const store = mkStore()
    const seen = []
    const liveCompute = async (metricId, scope, _from, _to) => {
      seen.push({ metricId, scopeType: scope.type })
      return { value: 0.42, trustTier: 'deterministic', dataQuality: 'ok' }
    }

    const model = await assembleReportModel({
      store,
      presetKey: 'annual:person',
      scope: { type: 'person', id: 'alice' },
      periodEnd: '2026-12-31',
      now: '2027-01-01T00:00:00.000Z',
      liveCompute,
    })

    const cells = model.sections.flatMap((s) => s.cells)
    expect(cells.length).toBeGreaterThan(0)
    // Every cell was filled from the live path, none left as no_data facade.
    expect(cells.every((c) => c.value === 0.42)).toBe(true)
    expect(model.provenance.dataQuality).toBe('ok')
    // liveCompute was invoked with person scope for each metric.
    expect(seen.length).toBe(cells.length)
    expect(seen.every((s) => s.scopeType === 'person')).toBe(true)
    store.close()
  })

  it('team-scope reports do NOT use the live fallback (snapshot path only)', async () => {
    // Guard: the live fallback is person/self only — team/org must stay on the
    // fast persisted-snapshot path even when a liveCompute is provided.
    const store = mkStore()
    let liveCalled = false
    const model = await assembleReportModel({
      store,
      presetKey: 'monthly:team',
      scope: { type: 'team', id: 'platform' },
      periodEnd: '2026-05-31',
      now: '2026-06-01T00:00:00.000Z',
      liveCompute: async () => {
        liveCalled = true
        return { value: 99 }
      },
    })
    expect(liveCalled).toBe(false)
    expect(model.sections.flatMap((s) => s.cells).every((c) => c.value === null)).toBe(true)
    store.close()
  })

  it('shows a real DORA band when the snapshot dataSource is real (proxy-capable preset overridden)', async () => {
    const store = mkStore()
    // 1.5 deploys/day ⇒ DORA "elite". Org scope, snapshot provenance = real.
    await seed(
      store,
      'dora.deployment_frequency',
      '2026-06-28',
      1.5,
      'org',
      'acme',
      'deterministic',
      'real',
    )

    const model = await assembleReportModel({
      store,
      presetKey: 'quarterly:dept',
      scope: { type: 'org', id: 'acme' },
      periodEnd: '2026-06-30',
      now: '2026-07-01T00:00:00.000Z',
      benchmark: buildBenchmarkProvider(),
    })

    const cell = model.sections
      .flatMap((s) => s.cells)
      .find((c) => c.metricId === 'dora.deployment_frequency')
    expect(cell?.value).toBe(1.5)
    // Real data overrides the preset's proxy-capable flag: band renders, not suppressed.
    expect(cell?.benchmark?.suppressed).toBe(false)
    expect(cell?.benchmark?.band).toBe('elite')
    // The proxy badge clears for real data.
    expect(cell?.proxy).toBe(false)
    store.close()
  })

  it('suppresses the DORA band when the snapshot dataSource is proxy, with a remediation note', async () => {
    const store = mkStore()
    await seed(
      store,
      'dora.deployment_frequency',
      '2026-06-28',
      1.5,
      'org',
      'acme',
      'deterministic',
      'proxy',
    )

    const model = await assembleReportModel({
      store,
      presetKey: 'quarterly:dept',
      scope: { type: 'org', id: 'acme' },
      periodEnd: '2026-06-30',
      now: '2026-07-01T00:00:00.000Z',
      benchmark: buildBenchmarkProvider(),
    })

    const cell = model.sections
      .flatMap((s) => s.cells)
      .find((c) => c.metricId === 'dora.deployment_frequency')
    expect(cell?.benchmark?.suppressed).toBe(true)
    expect(cell?.benchmark?.band).toBeNull()
    expect(cell?.benchmark?.note).toContain('connect real deploy/incident data')
    expect(cell?.proxy).toBe(true)
    store.close()
  })

  it('bands a duration DORA metric in DISPLAY units, not raw seconds (lead_time)', async () => {
    // Regression: lead_time is stored in SECONDS but its preset unit is 'hours'.
    // An elite 6-hour lead time = 21600 s. The benchmark classifier expects
    // hours and bands <24h as elite. If the call site passes raw seconds it
    // computes `21600 < 24` → 'low', mislabelling an elite team as worst-band
    // on the executive/quarterly presets. The displayed value must be banded.
    const store = mkStore()
    await seed(store, 'dora.lead_time', '2026-06-28', 21600, 'org', 'acme', 'deterministic', 'real')

    const model = await assembleReportModel({
      store,
      presetKey: 'quarterly:dept',
      scope: { type: 'org', id: 'acme' },
      periodEnd: '2026-06-30',
      now: '2026-07-01T00:00:00.000Z',
      benchmark: buildBenchmarkProvider(),
    })

    const cell = model.sections.flatMap((s) => s.cells).find((c) => c.metricId === 'dora.lead_time')
    // Stored value stays in canonical seconds; the band is computed in hours.
    expect(cell?.value).toBe(21600)
    expect(cell?.benchmark?.suppressed).toBe(false)
    expect(cell?.benchmark?.band).toBe('elite')
  })

  it('bands recovery_time in display hours and CFR in display percent', async () => {
    // recovery_time: 30 min = 1800 s ⇒ <1h ⇒ elite (raw seconds would be 'high').
    // change_failure_rate: 0.03 ratio ⇒ 3% ⇒ elite, verifying the % path also
    // survives the display-unit conversion.
    const store = mkStore()
    await seed(
      store,
      'dora.recovery_time',
      '2026-06-28',
      1800,
      'org',
      'acme',
      'deterministic',
      'real',
    )
    await seed(
      store,
      'dora.change_failure_rate',
      '2026-06-28',
      0.03,
      'org',
      'acme',
      'deterministic',
      'real',
    )

    const model = await assembleReportModel({
      store,
      presetKey: 'quarterly:dept',
      scope: { type: 'org', id: 'acme' },
      periodEnd: '2026-06-30',
      now: '2026-07-01T00:00:00.000Z',
      benchmark: buildBenchmarkProvider(),
    })
    const cells = model.sections.flatMap((s) => s.cells)
    expect(cells.find((c) => c.metricId === 'dora.recovery_time')?.benchmark?.band).toBe('elite')
    expect(cells.find((c) => c.metricId === 'dora.change_failure_rate')?.benchmark?.band).toBe(
      'elite',
    )
  })

  it('suppresses the DORA band when dataSource is absent (NULL ⇒ proxy, conservative)', async () => {
    const store = mkStore()
    // No dataSource passed ⇒ persisted NULL ⇒ treated as proxy.
    await seed(store, 'dora.deployment_frequency', '2026-06-28', 1.5, 'org', 'acme')

    const model = await assembleReportModel({
      store,
      presetKey: 'quarterly:dept',
      scope: { type: 'org', id: 'acme' },
      periodEnd: '2026-06-30',
      now: '2026-07-01T00:00:00.000Z',
      benchmark: buildBenchmarkProvider(),
    })

    const cell = model.sections
      .flatMap((s) => s.cells)
      .find((c) => c.metricId === 'dora.deployment_frequency')
    expect(cell?.benchmark?.suppressed).toBe(true)
    store.close()
  })
})
