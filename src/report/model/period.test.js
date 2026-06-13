import { describe, expect, it } from 'bun:test'
import { resolvePeriod } from './period.js'

describe('resolvePeriod', () => {
  it('monthly resolves the calendar month + prior month', () => {
    const p = resolvePeriod({ cadence: 'monthly', periodEnd: '2026-05-20' })
    expect(p.from).toBe('2026-05-01')
    expect(p.to).toBe('2026-05-31')
    expect(p.label).toBe('May 2026')
    expect(p.priorFrom).toBe('2026-04-01')
    expect(p.priorTo).toBe('2026-04-30')
    expect(p.priorLabel).toBe('April 2026')
  })

  it('monthly handles January (prior = previous December)', () => {
    const p = resolvePeriod({ cadence: 'monthly', periodEnd: '2026-01-15' })
    expect(p.from).toBe('2026-01-01')
    expect(p.to).toBe('2026-01-31')
    expect(p.priorFrom).toBe('2025-12-01')
    expect(p.priorTo).toBe('2025-12-31')
    expect(p.priorLabel).toBe('December 2025')
  })

  it('quarterly resolves the calendar quarter + prior quarter', () => {
    const p = resolvePeriod({ cadence: 'quarterly', periodEnd: '2026-05-20' })
    expect(p.from).toBe('2026-04-01')
    expect(p.to).toBe('2026-06-30')
    expect(p.label).toBe('2026-Q2')
    expect(p.priorFrom).toBe('2026-01-01')
    expect(p.priorTo).toBe('2026-03-31')
    expect(p.priorLabel).toBe('2026-Q1')
  })

  it('quarterly Q1 rolls prior to previous-year Q4', () => {
    const p = resolvePeriod({ cadence: 'quarterly', periodEnd: '2026-02-10' })
    expect(p.label).toBe('2026-Q1')
    expect(p.priorLabel).toBe('2025-Q4')
    expect(p.priorFrom).toBe('2025-10-01')
    expect(p.priorTo).toBe('2025-12-31')
  })

  it('annual resolves the calendar year + prior year', () => {
    const p = resolvePeriod({ cadence: 'annual', periodEnd: '2026-07-04' })
    expect(p.from).toBe('2026-01-01')
    expect(p.to).toBe('2026-12-31')
    expect(p.label).toBe('FY2026')
    expect(p.priorLabel).toBe('FY2025')
  })

  it('weekly is a trailing 7-day window with a preceding prior week', () => {
    const p = resolvePeriod({ cadence: 'weekly', periodEnd: '2026-05-20' })
    expect(p.to).toBe('2026-05-20')
    expect(p.from).toBe('2026-05-14')
    expect(p.priorTo).toBe('2026-05-13')
    expect(p.priorFrom).toBe('2026-05-07')
  })

  it('sprint uses explicit boundaries and derives an equal-length prior', () => {
    const p = resolvePeriod({
      cadence: 'sprint',
      periodEnd: '2026-05-20',
      sprintFrom: '2026-05-07',
      sprintTo: '2026-05-20',
    })
    expect(p.from).toBe('2026-05-07')
    expect(p.to).toBe('2026-05-20')
    // 14-day sprint → prior is the preceding 14 days.
    expect(p.priorTo).toBe('2026-05-06')
    expect(p.priorFrom).toBe('2026-04-23')
  })

  it('sprint without boundaries falls back to a trailing 14 days', () => {
    const p = resolvePeriod({ cadence: 'sprint', periodEnd: '2026-05-20' })
    expect(p.to).toBe('2026-05-20')
    expect(p.from).toBe('2026-05-07')
  })

  it('custom honours windowDays', () => {
    const p = resolvePeriod({ cadence: 'custom', periodEnd: '2026-05-20', windowDays: 30 })
    expect(p.to).toBe('2026-05-20')
    expect(p.from).toBe('2026-04-21')
    expect(p.priorTo).toBe('2026-04-20')
    expect(p.priorFrom).toBe('2026-03-22')
  })

  it('rejects a malformed anchor', () => {
    expect(() => resolvePeriod({ cadence: 'monthly', periodEnd: 'nope' })).toThrow()
  })
})
