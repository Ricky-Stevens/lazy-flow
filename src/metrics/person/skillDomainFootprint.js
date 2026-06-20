import { ENGINE_VERSION, safeRatio } from '../../core/index.js'

const FOOTPRINT_DOC =
  'Skill-Domain Footprint (person scope): aggregates contribution weight per skill ' +
  'domain, drops domains whose summed weight is below the floor, then reports breadth ' +
  '= normalized Shannon entropy of the domain-weight distribution in [0,1] (0 = all ' +
  'weight in one domain, 1 = perfectly even spread; breadth = 0 when fewer than 2 ' +
  'domains remain). Extras: depth = the largest single-domain share, distribution = ' +
  'share per domain, topDomains = up to 5 domains by share. This is a growth and ' +
  'staffing map showing WHERE a person works, never a "most skilled" rank — broad and ' +
  'deep are both legitimate shapes, so read it for coverage gaps and bus-factor, not ' +
  'as a score.'

/**
 * Person-scope skill-domain spread. Inputs are pre-aggregated by the caller:
 *   domains — [{ domain, weight }] contribution weight per domain (may repeat a domain)
 *   floor   — minimum summed weight a domain needs to count (default 0)
 * Pure: no store, no fetch, no clock. Uses asOf for the timestamp.
 */
export const skillDomainFootprint = {
  id: 'person.skill_domain_footprint',
  trustTier: 'hybrid',
  scope: 'person',
  formulaDoc: FOOTPRINT_DOC,
  params: {},

  compute(inputs, asOf) {
    const floor = inputs.floor ?? 0
    const raw = Array.isArray(inputs.domains) ? inputs.domains : []

    const base = {
      id: 'person.skill_domain_footprint',
      trustTier: 'hybrid',
      scope: 'person',
      unit: 'ratio',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: FOOTPRINT_DOC,
    }

    if (raw.length === 0) {
      return {
        ...base,
        value: null,
        dataQuality: 'no_data',
        breadth: null,
        depth: null,
        distribution: {},
        topDomains: [],
      }
    }

    // Aggregate weight per domain (a domain may appear more than once).
    const totals = new Map()
    for (const entry of raw) {
      const name = entry?.domain
      const weight = entry?.weight ?? 0
      if (name == null || weight <= 0) continue
      totals.set(name, (totals.get(name) ?? 0) + weight)
    }

    // Drop domains below the floor.
    const kept = [...totals.entries()].filter(([, w]) => w >= floor)
    const total = kept.reduce((sum, [, w]) => sum + w, 0)

    if (kept.length === 0 || total <= 0) {
      return {
        ...base,
        value: null,
        dataQuality: 'no_data',
        breadth: null,
        depth: null,
        distribution: {},
        topDomains: [],
      }
    }

    const distribution = {}
    for (const [name, w] of kept) {
      distribution[name] = safeRatio(w, total)
    }

    const shares = kept.map(([, w]) => w / total)
    const depth = Math.max(...shares)

    // Normalized Shannon entropy: H / log(n). Single domain → breadth 0.
    let breadth = 0
    if (kept.length >= 2) {
      let entropy = 0
      for (const p of shares) {
        if (p > 0) entropy -= p * Math.log(p)
      }
      breadth = entropy / Math.log(kept.length)
    }

    const topDomains = [...kept]
      .map(([domain, w]) => ({ domain, share: w / total }))
      .sort((a, b) => b.share - a.share)
      .slice(0, 5)

    return {
      ...base,
      value: breadth,
      dataQuality: 'ok',
      breadth,
      depth,
      distribution,
      topDomains,
      domainCount: kept.length,
    }
  },
}
