import { ENGINE_VERSION, safeRatio } from '../../core/index.js'

const DOC =
  'Knowledge Ownership & Bus-Factor Index (person scope): a RISK map, never a ' +
  'productivity rank. For each path the person touches we know personLines, ' +
  'totalLines, contributorCount and cyclomatic complexity. A path is OWNED when ' +
  "the person's share (personLines/totalLines) >= 0.5 AND personLines >= lineFloor " +
  '(default 30, so trivial files do not count). A path is BUS-FACTOR-1 when share ' +
  '>= 0.8 AND contributorCount <= 1 — i.e. that complexity lives in one head. ' +
  'index = sum of cyclomatic complexity over owned paths; ownedShareOfRepoComplexity ' +
  'is that sum over the complexity of all supplied paths. A HIGH index flags ' +
  'concentration risk to spread via pairing/review, NOT a high performer — the fair ' +
  'reading is "where would we hurt if this person left", not "who did the most".'

export const knowledgeOwnership = {
  id: 'person.knowledge_ownership_index',
  trustTier: 'deterministic',
  scope: 'person',
  formulaDoc: DOC,
  params: {},

  compute(inputs, asOf) {
    const paths = inputs?.paths ?? []
    const lineFloor = inputs?.lineFloor ?? 30
    const base = {
      id: 'person.knowledge_ownership_index',
      trustTier: 'deterministic',
      scope: 'person',
      unit: 'index',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: DOC,
    }

    if (paths.length === 0) {
      return {
        ...base,
        value: null,
        dataQuality: 'no_data',
        ownedPaths: 0,
        busFactor1Paths: 0,
        ownedShareOfRepoComplexity: null,
        evidencePaths: [],
      }
    }

    let index = 0
    let busFactor1Paths = 0
    let totalComplexity = 0
    const owned = []

    for (const p of paths) {
      const personLines = p.personLines ?? 0
      const totalLines = p.totalLines ?? 0
      const cyclomatic = p.cyclomatic ?? 0
      const contributorCount = p.contributorCount ?? 0
      totalComplexity += cyclomatic
      const share = safeRatio(personLines, totalLines)
      const isOwned = share !== null && share >= 0.5 && personLines >= lineFloor
      if (!isOwned) continue
      index += cyclomatic
      owned.push({ path: p.path, cyclomatic })
      if (share >= 0.8 && contributorCount <= 1) busFactor1Paths += 1
    }

    const evidencePaths = owned
      .slice()
      .sort((a, b) => b.cyclomatic - a.cyclomatic)
      .slice(0, 5)
      .map((o) => o.path)

    return {
      ...base,
      value: index,
      dataQuality: 'ok',
      ownedPaths: owned.length,
      busFactor1Paths,
      ownedShareOfRepoComplexity: safeRatio(index, totalComplexity),
      evidencePaths,
    }
  },
}
