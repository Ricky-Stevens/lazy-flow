import { describe, expect, it } from 'bun:test'
import {
  cfdAreaChart,
  distributionBarChart,
  doraBandGaugeChart,
  sparklineChart,
  stackedBarChart,
  trendLineChart,
} from './index.js'

describe('chart builders', () => {
  it('trendLineChart renders an SVG and always sets alt', async () => {
    const c = await trendLineChart({
      title: 'Cycle time',
      points: [
        { label: 'Mar', value: 5 },
        { label: 'Apr', value: 4 },
        { label: 'May', value: 6 },
      ],
      yTitle: 'days',
    })
    expect(c.kind).toBe('trend')
    expect(c.svg.startsWith('<svg')).toBe(true)
    expect(c.alt).toContain('Cycle time')
    expect(c.alt).toContain('May')
  })

  it('returns empty svg but meaningful alt when there is no data', async () => {
    const c = await trendLineChart({ title: 'Cycle time', points: [] })
    expect(c.svg).toBe('')
    expect(c.alt).toContain('no data')
  })

  it('sparklineChart renders compact SVG', async () => {
    const c = await sparklineChart({
      title: 'Throughput',
      points: [
        { label: 'a', value: 1 },
        { label: 'b', value: 3 },
        { label: 'c', value: 2 },
      ],
    })
    expect(c.kind).toBe('sparkline')
    expect(c.svg.startsWith('<svg')).toBe(true)
  })

  it('distributionBarChart renders bars', async () => {
    const c = await distributionBarChart({
      title: 'Aging WIP',
      bars: [
        { label: '0-3d', value: 4 },
        { label: '3-7d', value: 2 },
        { label: '7d+', value: 1 },
      ],
    })
    expect(c.svg.startsWith('<svg')).toBe(true)
    expect(c.alt).toContain('7d+')
  })

  it('stackedBarChart renders stacked series', async () => {
    const c = await stackedBarChart({
      title: 'Work mix',
      points: [
        { category: 'Apr', group: 'Feature', value: 5 },
        { category: 'Apr', group: 'Bug', value: 2 },
        { category: 'May', group: 'Feature', value: 6 },
        { category: 'May', group: 'Bug', value: 1 },
      ],
    })
    expect(c.svg.startsWith('<svg')).toBe(true)
    expect(c.alt).toContain('Feature')
  })

  it('cfdAreaChart renders stacked area', async () => {
    const c = await cfdAreaChart({
      title: 'CFD',
      points: [
        { day: '2026-05-01', status: 'todo', count: 3 },
        { day: '2026-05-01', status: 'doing', count: 2 },
        { day: '2026-05-02', status: 'todo', count: 2 },
        { day: '2026-05-02', status: 'doing', count: 3 },
      ],
    })
    expect(c.svg.startsWith('<svg')).toBe(true)
  })

  it('doraBandGaugeChart renders a value with thresholds and reflects the band in alt', async () => {
    const c = await doraBandGaugeChart({
      title: 'Deploy frequency',
      value: 1.5,
      unit: 'per day',
      thresholds: [
        { label: 'medium', at: 0.03 },
        { label: 'high', at: 0.14 },
        { label: 'elite', at: 1 },
      ],
      band: 'elite',
    })
    expect(c.svg.startsWith('<svg')).toBe(true)
    expect(c.alt).toContain('elite')
  })

  it('doraBandGaugeChart with null value degrades to empty svg', async () => {
    const c = await doraBandGaugeChart({
      title: 'Deploy frequency',
      value: null,
      unit: 'per day',
      thresholds: [],
      band: null,
    })
    expect(c.svg).toBe('')
    expect(c.alt).toContain('n/a')
  })
})
