import { ENGINE_VERSION, safeRatio } from '../../core/index.js'

const TEST_INCLUSION_DOC =
  'Test-Inclusion Rate (person scope, path-heuristic phase 1): of the PRs that touch ' +
  'production code, the share that also touch test files. ' +
  'rate = (PRs touching prod AND test) / (PRs touching prod). ' +
  'Classification is path-based until diff-level analysis lands, so it is a coarse signal: ' +
  'small fixes, config tweaks, or doc-adjacent changes may legitimately need no new test, and ' +
  'a high rate can come from trivial test edits. Read it against the team norm, not as a target ' +
  'to maximise — more tests is not automatically better.'

const SAMPLE_FLOOR = 5

/**
 * Person-scope test-inclusion rate. inputs.prs is a list of the person's PRs,
 * each pre-classified by file path:
 *   touchedProd — PR changed at least one production (non-test) source file
 *   touchedTest — PR changed at least one test file
 * Denominator is code-changing PRs (touchedProd). Numerator is those that also
 * touched a test. Pure-test or pure-config PRs (no touchedProd) are excluded.
 */
export const testInclusionRate = {
  id: 'person.test_inclusion_rate',
  trustTier: 'hybrid',
  scope: 'person',
  formulaDoc: TEST_INCLUSION_DOC,
  params: {},

  compute(inputs, asOf) {
    const prs = inputs?.prs ?? []
    const totalPrs = prs.length
    const codeChangingPrs = prs.filter((pr) => pr.touchedProd).length
    const prsWithTests = prs.filter((pr) => pr.touchedProd && pr.touchedTest).length

    const base = {
      id: 'person.test_inclusion_rate',
      trustTier: 'hybrid',
      scope: 'person',
      unit: 'ratio',
      engineVersion: ENGINE_VERSION,
      asOf,
      formulaDoc: TEST_INCLUSION_DOC,
      totalPrs,
      codeChangingPrs,
      prsWithTests,
    }

    // No code-changing PRs → the rate is undefined (denominator 0).
    if (codeChangingPrs === 0) {
      return { ...base, value: null, dataQuality: 'no_data' }
    }

    const rate = safeRatio(prsWithTests, codeChangingPrs)
    // Below the floor the rate is computable but too noisy to compare to a norm.
    const dataQuality = codeChangingPrs < SAMPLE_FLOOR ? 'insufficient_sample' : 'ok'
    return { ...base, value: rate, dataQuality }
  },
}
