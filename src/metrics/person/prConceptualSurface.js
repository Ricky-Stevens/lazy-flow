import { ENGINE_VERSION, percentile } from '../../core/index.js'

const SURFACE_DOC =
  'Conceptual Surface Area (person scope): the median complexity-weighted "surface" of ' +
  "a person's PRs. value = median(prSurfaces); p75 shows the heavier tail. Surface is " +
  'complexity-weighted, not line-counted, so 30 lines threaded through 8 hard functions ' +
  'outweighs a 400-line fixture/boilerplate PR. Read it PAIRED with PR size: low size + ' +
  'high surface = harder-than-it-looks work that deserves credit, not a productivity score. ' +
  'High surface is not "better" and low surface is not "worse" — both are normal depending ' +
  'on what the work demanded.'

const SAMPLE_FLOOR = 8

/**
 * Person-scope conceptual surface area. Inputs are pre-aggregated by the caller:
 *   prSurfaces — array of per-PR complexity-weighted surface scores (numbers)
 * Pure module: no store, no fetch, no clock. asOf supplies the timestamp.
 */
export const prConceptualSurface = {
  id: 'person.pr_conceptual_surface',
  trustTier: 'deterministic',
  scope: 'person',
  formulaDoc: SURFACE_DOC,
  params: {},

  compute(inputs, asOf) {
    const surfaces = inputs.prSurfaces ?? []
    const sampleSize = surfaces.length
    const base = {
      id: 'person.pr_conceptual_surface',
      trustTier: 'deterministic',
      scope: 'person',
      unit: 'index',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: SURFACE_DOC,
      sampleSize,
      p75: null,
    }

    // No PRs in the window → nothing to say.
    if (sampleSize === 0) {
      return { ...base, value: null, dataQuality: 'no_data' }
    }

    const median = percentile(surfaces, 0.5)
    const p75 = percentile(surfaces, 0.75)
    // Below the floor the median is computable but too noisy to lean on.
    const dataQuality = sampleSize < SAMPLE_FLOOR ? 'insufficient_sample' : 'ok'

    return { ...base, value: median, p75, dataQuality }
  },
}
