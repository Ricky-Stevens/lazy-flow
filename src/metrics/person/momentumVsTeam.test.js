import { describe, expect, it } from 'bun:test'
import { momentumVsTeam } from './momentumVsTeam.js'

const ASOF = '2026-06-20T00:00:00.000Z'

describe('momentumVsTeam', () => {
  it('computes the difference-in-differences headline on a hand example', () => {
    const r = momentumVsTeam.compute({ personDriftZ: 1.2, teamDriftZ: 0.4 }, ASOF)
    expect(r.value).toBeCloseTo(0.8, 10)
    expect(r.dataQuality).toBe('ok')
    expect(r.interpretation).toBe('outpacing team')
    expect(r.unit).toBe('zscore')
    expect(r.personDriftZ).toBe(1.2)
    expect(r.teamDriftZ).toBe(0.4)
  })

  it('orients by polarity so lower-better flips the sign', () => {
    // person dropped less than team; with lower-better that is out-pacing.
    const r = momentumVsTeam.compute({ personDriftZ: -1.0, teamDriftZ: 0.2, polarity: -1 }, ASOF)
    expect(r.value).toBeCloseTo(1.2, 10)
    expect(r.interpretation).toBe('outpacing team')
  })

  it('bands a lagging reading', () => {
    const r = momentumVsTeam.compute({ personDriftZ: -0.6, teamDriftZ: 0.3 }, ASOF)
    expect(r.value).toBeCloseTo(-0.9, 10)
    expect(r.interpretation).toBe('lagging team')
  })

  it('returns no_data when either drift is null', () => {
    const a = momentumVsTeam.compute({ personDriftZ: null, teamDriftZ: 0.4 }, ASOF)
    expect(a.value).toBeNull()
    expect(a.dataQuality).toBe('no_data')
    expect(a.interpretation).toBe('no_data')

    const b = momentumVsTeam.compute({ personDriftZ: 1.0, teamDriftZ: null }, ASOF)
    expect(b.value).toBeNull()
    expect(b.dataQuality).toBe('no_data')
  })

  it('reads equal drift as tracking team (all-equal edge)', () => {
    const r = momentumVsTeam.compute({ personDriftZ: 0.7, teamDriftZ: 0.7 }, ASOF)
    expect(r.value).toBe(0)
    expect(r.interpretation).toBe('tracking team')
    expect(r.dataQuality).toBe('ok')
  })
})
