import { describe, expect, it } from 'bun:test'
import { buildBenchmarkProvider } from './dora.js'

const p = buildBenchmarkProvider()

describe('DORA benchmark provider', () => {
  it('classifies deploy frequency into bands (higher better)', () => {
    expect(
      p.lookup({ metricId: 'dora.deployment_frequency', value: 2, scopeType: 'team', proxy: false })
        ?.band,
    ).toBe('elite')
    expect(
      p.lookup({
        metricId: 'dora.deployment_frequency',
        value: 0.2,
        scopeType: 'team',
        proxy: false,
      })?.band,
    ).toBe('high')
    expect(
      p.lookup({
        metricId: 'dora.deployment_frequency',
        value: 0.001,
        scopeType: 'team',
        proxy: false,
      })?.band,
    ).toBe('low')
  })

  it('classifies lead time hours (lower better)', () => {
    expect(
      p.lookup({ metricId: 'dora.lead_time', value: 10, scopeType: 'org', proxy: false })?.band,
    ).toBe('elite')
    expect(
      p.lookup({ metricId: 'dora.lead_time', value: 100, scopeType: 'org', proxy: false })?.band,
    ).toBe('high')
    expect(
      p.lookup({ metricId: 'dora.lead_time', value: 1000, scopeType: 'org', proxy: false })?.band,
    ).toBe('low')
  })

  it('SUPPRESSES the band on proxy data', () => {
    const r = p.lookup({ metricId: 'dora.lead_time', value: 10, scopeType: 'team', proxy: true })
    expect(r?.suppressed).toBe(true)
    expect(r?.band).toBeNull()
    expect(r?.suppressedReason).toBe('proxy_data')
  })

  it('returns null at person/self scope (no individual benchmarks)', () => {
    expect(
      p.lookup({ metricId: 'dora.lead_time', value: 10, scopeType: 'person', proxy: false }),
    ).toBeNull()
    expect(
      p.lookup({ metricId: 'dora.lead_time', value: 10, scopeType: 'self', proxy: false }),
    ).toBeNull()
  })

  it('returns null for non-DORA metrics (default-suppress compatibility matrix)', () => {
    expect(
      p.lookup({ metricId: 'flow.cycle_time', value: 10, scopeType: 'team', proxy: false }),
    ).toBeNull()
    expect(
      p.lookup({
        metricId: 'code.maintainability_index',
        value: 80,
        scopeType: 'org',
        proxy: false,
      }),
    ).toBeNull()
  })

  it('exposes gauge thresholds for DORA keys only', () => {
    expect(p.thresholds?.('dora.deployment_frequency').length).toBeGreaterThan(0)
    expect(p.thresholds?.('flow.cycle_time').length).toBe(0)
  })

  it('handles change failure rate as fraction or percent', () => {
    expect(
      p.lookup({
        metricId: 'dora.change_failure_rate',
        value: 0.03,
        scopeType: 'team',
        proxy: false,
      })?.band,
    ).toBe('elite')
    expect(
      p.lookup({ metricId: 'dora.change_failure_rate', value: 3, scopeType: 'team', proxy: false })
        ?.band,
    ).toBe('elite')
  })
})
