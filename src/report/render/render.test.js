import { describe, expect, it } from 'bun:test'

import { renderHtml } from './html.js'
import { renderMarkdown } from './markdown.js'

function sampleModel(overrides = {}) {
  return {
    presetKey: 'monthly:team',
    title: 'Monthly Delivery Report',
    audience: 'Engineering Manager',
    scope: { type: 'team', id: 'platform' },
    period: {
      cadence: 'monthly',
      from: '2026-05-01',
      to: '2026-05-31',
      label: 'May 2026',
      priorFrom: '2026-04-01',
      priorTo: '2026-04-30',
      priorLabel: 'April 2026',
    },
    generatedAt: '2026-06-01T00:00:00.000Z',
    provenance: {
      asOf: '2026-06-01T00:00:00.000Z',
      engineVersion: '0.1.0',
      trustTier: 'mixed',
      dataQuality: 'ok',
      coverageFingerprint: 'cov-1',
    },
    personScope: false,
    blindSpots: ['No real deploy/incident data — DORA is proxy-mode.'],
    sections: [
      {
        id: 'flow',
        title: 'Flow',
        purpose: 'Where work got stuck.',
        cells: [
          {
            metricId: 'flow.cycle_time',
            label: 'Cycle time',
            value: 5.2,
            unit: 'days',
            trustTier: 'deterministic',
            dataQuality: 'ok',
            polarity: 'lower_better',
            formulaDoc: 'started → done',
            comparison: {
              baselineP50: 4,
              delta: 1.2,
              deltaPct: 0.3,
              band: 'above',
              trendArrow: 'up',
              zScore: 2.1,
              percentileWithin: 0.85,
              n: 12,
              significant: true,
              note: null,
            },
          },
        ],
        charts: [
          {
            kind: 'trend',
            title: 'Cycle time',
            svg: '<svg aria-label="t"></svg>',
            alt: 'trend alt',
          },
        ],
        narrative: {
          trustTier: 'hybrid',
          summary: 'Cycle time rose, consistent with reviewer latency.',
          bullets: ['Review pickup slowed'],
          promptVersion: 'anomaly@1',
          modelSnapshot: 'claude-sonnet-4-6',
          contestable: true,
          advisory: true,
        },
        caveats: ['Single-team monthly sample is small.'],
      },
    ],
    ...overrides,
  }
}

describe('renderHtml', () => {
  it('produces a self-contained HTML document with inline CSS and SVG', () => {
    const html = renderHtml(sampleModel())
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html).toContain('<style>')
    expect(html).toContain('Monthly Delivery Report')
    expect(html).toContain('May 2026')
    expect(html).toContain('Cycle time')
    // trust badge + significant comparison rendered with text (not colour-only)
    expect(html).toContain('badge deterministic')
    expect(html).toContain('▲ up')
    // chart SVG injected raw
    expect(html).toContain('<svg aria-label="t">')
    // AI advisory block
    expect(html).toContain('AI — advisory')
    // blind spots callout
    expect(html).toContain('What this report cannot see')
  })

  it('escapes untrusted text (XSS guard via eta auto-escape)', () => {
    const html = renderHtml(sampleModel({ title: 'Team <script>alert(1)</script>' }))
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>alert(1)')
  })

  it('renders the person-scope boundary banner', () => {
    const html = renderHtml(sampleModel({ personScope: true }))
    expect(html).toContain('Private self-view')
    expect(html).toContain('Not for appraisal')
  })

  it('falls back to alt text when a chart SVG is empty', () => {
    const m = sampleModel()
    const chart = m.sections[0]?.charts[0]
    if (chart === undefined) throw new Error('fixture missing chart')
    chart.svg = ''
    const html = renderHtml(m)
    expect(html).toContain('trend alt')
  })

  it('renders a real DORA band when the benchmark is not suppressed', () => {
    const m = withDoraBenchmark({
      source: 'DORA 2025',
      band: 'elite',
      note: 'DORA 2025 bands (CC BY 4.0, Google LLC).',
      suppressed: false,
      suppressedReason: null,
    })
    const html = renderHtml(m)
    expect(html).toContain('elite')
    expect(html).toContain('DORA 2025')
    // No proxy badge / suppression note when the band is real.
    expect(html).not.toContain('suppressed —')
  })

  it('prints the suppression remediation note (not just "suppressed")', () => {
    const m = withDoraBenchmark({
      source: 'DORA 2025',
      band: null,
      note: SUPPRESSED_NOTE,
      suppressed: true,
      suppressedReason: 'proxy_data',
    })
    const html = renderHtml(m)
    expect(html).toContain('suppressed —')
    expect(html).toContain('connect real deploy/incident data')
  })
})

const SUPPRESSED_NOTE =
  'proxy-mode — not comparable to DORA benchmarks; connect real deploy/incident data.'

function withDoraBenchmark(benchmark) {
  const cell = {
    metricId: 'dora.deployment_frequency',
    label: 'Deployment frequency',
    value: 1.5,
    unit: 'per day',
    trustTier: 'deterministic',
    dataQuality: 'ok',
    polarity: 'higher_better',
    formulaDoc: 'deploys / window',
    proxy: benchmark.suppressed,
    benchmark,
  }
  return sampleModel({
    sections: [
      {
        id: 'dora',
        title: 'DORA',
        purpose: 'Delivery throughput and stability.',
        cells: [cell],
        charts: [],
        narrative: null,
        caveats: [],
      },
    ],
  })
}

describe('renderMarkdown', () => {
  it('produces a board-pack with a metric table', () => {
    const md = renderMarkdown(sampleModel())
    expect(md).toContain('# Monthly Delivery Report')
    expect(md).toContain('| Metric | Value | vs baseline | Trust | Benchmark |')
    expect(md).toContain('Cycle time')
    expect(md).toContain('▲ up')
    expect(md).toContain('AI — advisory')
    expect(md).toContain('What this report cannot see')
  })

  it('escapes pipes in cell text', () => {
    const m = sampleModel()
    const cell = m.sections[0]?.cells[0]
    if (cell === undefined) throw new Error('fixture missing cell')
    cell.label = 'a | b'
    const md = renderMarkdown(m)
    expect(md).toContain('a \\| b')
  })

  it('renders the real DORA band when not suppressed', () => {
    const md = renderMarkdown(
      withDoraBenchmark({
        source: 'DORA 2025',
        band: 'elite',
        note: 'DORA 2025 bands (CC BY 4.0, Google LLC).',
        suppressed: false,
        suppressedReason: null,
      }),
    )
    expect(md).toContain('elite DORA 2025')
    expect(md).not.toContain('suppressed —')
  })

  it('prints the suppression remediation note (not just "suppressed")', () => {
    const md = renderMarkdown(
      withDoraBenchmark({
        source: 'DORA 2025',
        band: null,
        note: SUPPRESSED_NOTE,
        suppressed: true,
        suppressedReason: 'proxy_data',
      }),
    )
    expect(md).toContain('suppressed —')
    expect(md).toContain('connect real deploy/incident data')
  })
})
