import { describe, expect, it } from 'bun:test'

import { classifyWorkType } from './worktype.js'

const NOW = new Date('2024-06-01T00:00:00Z').getTime()
const DAYS = (n) => n * 24 * 60 * 60 * 1000

// ── helpers ────────────────────────────────────────────────────────────────

function blame(line, author, daysAgo) {
  return { line, author, lastChangedAt: NOW - DAYS(daysAgo) }
}

// ── pure new work ──────────────────────────────────────────────────────────

describe('New work', () => {
  it('lines with no blame record are classified as New', () => {
    const result = classifyWorkType({
      author: 'alice',
      blameRecords: [],
      now: NOW,
      lines: [1, 2, 3],
    })
    expect(result.counts.New).toBe(3)
    expect(result.counts.Rework).toBe(0)
    expect(result.efficiency).toBe(100)
    expect(result.reworkPercent).toBe(0)
  })
})

// ── rework ─────────────────────────────────────────────────────────────────

describe('Rework', () => {
  it('author touching own recent line = Rework', () => {
    const result = classifyWorkType({
      author: 'alice',
      blameRecords: [blame(1, 'alice', 5)],
      now: NOW,
    })
    expect(result.counts.Rework).toBe(1)
    expect(result.reworkPercent).toBe(100)
    expect(result.efficiency).toBe(0)
  })

  it('Rework% and efficiency are correctly computed across a mix', () => {
    // 2 rework + 2 new = 50% rework → 50% efficiency
    const result = classifyWorkType({
      author: 'alice',
      blameRecords: [blame(1, 'alice', 5), blame(2, 'alice', 10)],
      now: NOW,
      lines: [1, 2, 3, 4], // lines 3,4 have no blame → New
    })
    expect(result.counts.Rework).toBe(2)
    expect(result.counts.New).toBe(2)
    expect(result.reworkPercent).toBe(50)
    expect(result.efficiency).toBe(50)
  })
})

// ── help others ────────────────────────────────────────────────────────────

describe('Help-Others', () => {
  it("editing someone else's recent line = Help-Others", () => {
    const result = classifyWorkType({
      author: 'alice',
      blameRecords: [blame(1, 'bob', 10)],
      now: NOW,
    })
    expect(result.counts['Help-Others']).toBe(1)
    expect(result.reworkPercent).toBe(0)
    expect(result.efficiency).toBe(100)
  })
})

// ── legacy refactor ────────────────────────────────────────────────────────

describe('Legacy-Refactor', () => {
  it("editing someone else's old line = Legacy-Refactor", () => {
    const result = classifyWorkType({
      author: 'alice',
      blameRecords: [blame(1, 'bob', 60)],
      now: NOW,
    })
    expect(result.counts['Legacy-Refactor']).toBe(1)
  })

  it('editing own old line = Legacy-Refactor', () => {
    const result = classifyWorkType({
      author: 'alice',
      blameRecords: [blame(1, 'alice', 60)],
      now: NOW,
    })
    expect(result.counts['Legacy-Refactor']).toBe(1)
  })
})

// ── window configuration ───────────────────────────────────────────────────

describe('configurable window', () => {
  it('shorter window makes a 20-day-old line count as Legacy-Refactor', () => {
    // 20 days old, within default 30-day window → Help-Others
    const defaultResult = classifyWorkType({
      author: 'alice',
      blameRecords: [blame(1, 'bob', 20)],
      now: NOW,
    })
    expect(defaultResult.counts['Help-Others']).toBe(1)

    // With window=10, 20 days old → Legacy-Refactor
    const shortResult = classifyWorkType({
      author: 'alice',
      blameRecords: [blame(1, 'bob', 20)],
      now: NOW,
      windowDays: 10,
    })
    expect(shortResult.counts['Legacy-Refactor']).toBe(1)
  })

  it('uses default 30-day window when windowDays is not specified', () => {
    // 29 days → recent
    const result = classifyWorkType({
      author: 'alice',
      blameRecords: [blame(1, 'bob', 29)],
      now: NOW,
    })
    expect(result.counts['Help-Others']).toBe(1)
  })
})

// ── zero total ─────────────────────────────────────────────────────────────

describe('zero / empty input', () => {
  it('returns null reworkPercent and efficiency when total=0', () => {
    const result = classifyWorkType({
      author: 'alice',
      blameRecords: [],
      now: NOW,
      lines: [],
    })
    expect(result.total).toBe(0)
    expect(result.reworkPercent).toBeNull()
    expect(result.efficiency).toBeNull()
  })
})
